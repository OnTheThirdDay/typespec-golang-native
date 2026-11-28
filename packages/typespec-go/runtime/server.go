package tsgo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"

	"typespecgo/runtime/uri"
)

// NilResponse also detects a typed nil pointer inside a response interface.
func NilResponse(v any) bool {
	if v == nil {
		return true
	}
	r := reflect.ValueOf(v)
	return r.Kind() == reflect.Pointer && r.IsNil()
}

// DeferHeaders stages response metadata until its final status is committed. On an encoding
// or first-item failure the error handler still owns the original writer and its headers.
func DeferHeaders(w http.ResponseWriter) http.ResponseWriter {
	return &deferredHeaders{ResponseWriter: w, pending: w.Header().Clone()}
}

type deferredHeaders struct {
	http.ResponseWriter
	pending http.Header
}

func (w *deferredHeaders) Header() http.Header {
	if w.pending == nil {
		return w.ResponseWriter.Header()
	}
	return w.pending
}

func (w *deferredHeaders) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *deferredHeaders) WriteHeader(status int) {
	if w.pending != nil {
		h := w.ResponseWriter.Header()
		for k, values := range w.pending {
			h[k] = values
		}
		w.pending = nil
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *deferredHeaders) Write(b []byte) (int, error) {
	if w.pending != nil {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(b)
}

// SetResponseHeader rejects invalid field values before net/http can discard or rewrite them.
func SetResponseHeader(h http.Header, name, value string) error {
	for i := range len(value) {
		if value[i] == 0x7f || value[i] < 0x20 && value[i] != '\t' {
			return fmt.Errorf("invalid value for response header %q", name)
		}
	}
	h.Set(name, value)
	return nil
}

// OperationInfo describes a generated operation; it is passed to middleware and to the
// authentication hook.
type OperationInfo struct {
	ID     string // operation name, e.g. "Widgets_read"
	Method string // HTTP method
	Path   string // TypeSpec route (URI template)
	// Security lists alternative requirements; any one must be satisfied. Empty means the
	// operation has no authentication requirement.
	Security []SecurityRequirement
}

// SecurityRequirement is a set of schemes that must all be satisfied.
type SecurityRequirement []SecurityScheme

// SecurityScheme mirrors a TypeSpec.Http authentication scheme.
type SecurityScheme struct {
	ID     string   // TypeSpec model name of the scheme
	Type   string   // "http", "apiKey", "oauth2", "openIdConnect", "noAuth"
	Scheme string   // http schemes: "Bearer", "Basic", ...
	In     string   // apiKey: "header", "query" or "cookie"
	Name   string   // apiKey: parameter name
	Scopes []string // oauth2 / openIdConnect scopes required by the operation
}

// AllowsAnonymous reports whether one of the requirements is TypeSpec.Http.NoAuth.
func (o OperationInfo) AllowsAnonymous() bool {
	for _, req := range o.Security {
		if len(req) == 1 && req[0].Type == "noAuth" {
			return true
		}
	}
	return false
}

// StrictHandlerFunc is the type-erased form of a strict operation handler, used by middleware.
type StrictHandlerFunc = func(ctx context.Context, w http.ResponseWriter, r *http.Request, request any) (any, error)

// StrictMiddlewareFunc wraps strict handlers. request is the operation's *RequestObject value
// and the returned value its ResponseObject.
type StrictMiddlewareFunc = func(f StrictHandlerFunc, op OperationInfo) StrictHandlerFunc

// AuthenticateFunc is called before a request is decoded for operations with security
// requirements. It returns the context to use for the handler or an error (→ 401 by default).
type AuthenticateFunc = func(ctx context.Context, r *http.Request, op OperationInfo) (context.Context, error)

// ServerOptions configures a generated strict handler.
type ServerOptions struct {
	// CollectErrors reports every independent decoding failure of a request (all properties,
	// items and records, nested ones included, each bounded by MaxCollectedErrors) to
	// RequestErrorHandler. By default handlers see the first failure only (fail-fast).
	CollectErrors bool
	// ErrorDetails makes the default request error handler add machine-readable Details
	// (kind, location, JSON Pointer, constraint and limit, offending value, union variants).
	ErrorDetails bool
	// MaxErrors bounds the Details of the default handler (0: MaxCollectedErrors).
	MaxErrors int
	// Middlewares wrap every operation; the first element is the outermost.
	Middlewares []StrictMiddlewareFunc
	// Authenticate is required when any operation declares authentication; requests to such
	// operations are rejected with 401 if it is nil.
	Authenticate AuthenticateFunc
	// RequestErrorHandler writes responses for request errors (binding, decoding, validation,
	// authentication). Defaults to DefaultRequestErrorHandler.
	RequestErrorHandler func(w http.ResponseWriter, r *http.Request, err error)
	// ResponseErrorHandler writes responses when the handler fails or returns an invalid
	// response. Defaults to DefaultResponseErrorHandler.
	ResponseErrorHandler func(w http.ResponseWriter, r *http.Request, err error)
	// MaxRequestBodyBytes limits request bodies. 0 means 10 MiB; a negative value disables the limit.
	MaxRequestBodyBytes int64
	// ValidateResponses validates response objects before writing them.
	ValidateResponses bool
}

// Resolve fills defaults.
func (o ServerOptions) Resolve() ServerOptions {
	o.Middlewares = append([]StrictMiddlewareFunc(nil), o.Middlewares...)
	if o.RequestErrorHandler == nil {
		o.RequestErrorHandler = DefaultRequestErrorHandler
		if o.ErrorDetails {
			o.RequestErrorHandler = DetailedRequestErrorHandler(o.MaxErrors)
		}
	}
	if !o.CollectErrors {
		// Fail-fast reporting: handlers see the first failure of every collection.
		handler := o.RequestErrorHandler
		o.RequestErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) { handler(w, r, FirstErrors(err)) }
	}
	if o.ResponseErrorHandler == nil {
		o.ResponseErrorHandler = DefaultResponseErrorHandler
	}
	if o.MaxRequestBodyBytes == 0 {
		o.MaxRequestBodyBytes = 10 << 20
	}
	return o
}

// RequestErrorKind classifies request errors.
type RequestErrorKind int

const (
	ErrParameter RequestErrorKind = iota + 1
	ErrBody
	ErrContentType
	ErrValidation
	ErrUnauthenticated
	ErrBodyTooLarge
)

// RequestError is reported to RequestErrorHandler.
type RequestError struct {
	Kind     RequestErrorKind
	Location string // "path", "query", "header", "cookie", "body"
	Name     string // parameter name (wire name) when applicable
	Err      error

	decoded bool // the body kept the part that decoded (DecodedBodyError)
}

func (e *RequestError) Error() string {
	switch {
	case e.Name != "":
		return fmt.Sprintf("%s parameter %q: %v", e.Location, e.Name, e.Err)
	case e.Location != "":
		return fmt.Sprintf("%s: %v", e.Location, e.Err)
	}
	return e.Err.Error()
}

func (e *RequestError) Unwrap() error { return e.Err }

// StatusCode returns the HTTP status for the error.
func (e *RequestError) StatusCode() int {
	switch e.Kind {
	case ErrContentType:
		return http.StatusUnsupportedMediaType
	case ErrUnauthenticated:
		return http.StatusUnauthorized
	case ErrBodyTooLarge:
		return http.StatusRequestEntityTooLarge
	case ErrNotAcceptable:
		return http.StatusNotAcceptable
	}
	return http.StatusBadRequest
}

// ParamError builds a parameter RequestError.
func ParamError(location, name string, err error) error {
	return &RequestError{Kind: ErrParameter, Location: location, Name: name, Err: err}
}

// Search only for the transport size failure while constructing a body error. Consulting
// request views here would re-enter an adapter that builds its view with DecodedBodyError.
func wrapBodyError(err error, retained bool) *RequestError {
	re := &RequestError{Kind: ErrBody, Location: "body", Err: err}
	var w errorWalk
	walkBranches(err, func(e error, ctx treeContext) (treeFrame, bool) {
		var done treeFrame
		if !w.step() {
			return done, false
		}
		if _, ok := e.(*http.MaxBytesError); ok {
			re.Kind = ErrBodyTooLarge
			return done, false
		}
		if children := w.httpChildren(e, 1); len(children) != 0 {
			return ctx.group(children), true
		}
		if w.limited {
			return done, false
		}
		if a, ok := e.(interface{ As(any) bool }); ok {
			if !w.queryAdapter() {
				return done, false
			}
			var mbe *http.MaxBytesError
			if a.As(&mbe) && mbe != nil {
				re.Kind = ErrBodyTooLarge
				return done, false
			}
		}
		return done, true
	})
	re.decoded = retained && re.Kind == ErrBody && !w.limited
	return re
}

// The transport and status lookups follow actual Go causes. ValidationErrors.Unwrap
// materializes its cause slice, so account for all entries before calling it.
func (w *errorWalk) httpChildren(err error, visits int) []error {
	var entries int
	switch list := err.(type) {
	case ValidationErrors:
		entries = len(list)
	case *ValidationErrors:
		if list == nil {
			return nil
		}
		entries = len(*list)
	}
	if entries > (MaxErrorTreeWork-w.work)/visits {
		w.limited = true
		return nil
	}
	w.work += entries * visits
	switch u := err.(type) {
	case interface{ Unwrap() []error }:
		return u.Unwrap()
	case interface{ Unwrap() error }:
		if child := u.Unwrap(); child != nil {
			return []error{child}
		}
	}
	return nil
}

// BodyError builds a body RequestError, recognising size-limit failures.
func BodyError(err error) error { return wrapBodyError(err, false) }

// ValidationRequestError wraps validation failures of a decoded request.
func ValidationRequestError(err error) error {
	return &RequestError{Kind: ErrValidation, Err: err}
}

// Problem is an RFC 9457 problem details document.
type Problem struct {
	Type   string            `json:"type"`
	Title  string            `json:"title"`
	Status int               `json:"status"`
	Detail string            `json:"detail,omitempty"`
	Errors []ValidationError `json:"errors,omitempty"`
	// Details lists the problems as data (DetailedRequestErrorHandler).
	Details []ErrorDetail `json:"details,omitempty"`
}

// WriteProblem writes an application/problem+json response.
func WriteProblem(w http.ResponseWriter, status int, detail string, errs []ValidationError) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(Problem{Type: "about:blank", Title: http.StatusText(status), Status: status, Detail: detail, Errors: errs})
}

// DefaultRequestErrorHandler includes the validation entries of the request.
func DefaultRequestErrorHandler(w http.ResponseWriter, r *http.Request, err error) {
	writeRequestProblem(w, err, 0)
}

// DetailedRequestErrorHandler also includes up to max machine-readable details.
func DetailedRequestErrorHandler(max int) func(http.ResponseWriter, *http.Request, error) {
	if max <= 0 {
		max = MaxCollectedErrors
	}
	return func(w http.ResponseWriter, r *http.Request, err error) {
		writeRequestProblem(w, err, max)
	}
}

// A conventional forwarding As can search its children twice: once inside As and once
// in Go's own descent if As declines. Check the exposed tree iteratively before invoking
// application code. The remaining budget is shared by all candidate status lookups.
func (b *errorWalk) allowStatusSearch(children []error) bool {
	type frame struct {
		children []error
		visits   int
	}
	stack := []frame{{children, 1}}
	for len(stack) > 0 {
		last := &stack[len(stack)-1]
		e, visits := last.children[0], last.visits
		last.children = last.children[1:]
		if len(last.children) == 0 {
			stack = stack[:len(stack)-1]
		}
		if !b.charge(visits) {
			return false
		}
		if _, match := e.(*RequestError); match {
			continue // errors.As matches this node without descending
		}
		children := b.httpChildren(e, visits)
		if b.limited {
			return false
		}
		if _, ok := e.(interface{ As(any) bool }); ok {
			if visits > MaxErrorTreeViews-b.views {
				return false
			}
			b.views += visits
			visits *= 2
		}
		if len(children) != 0 {
			stack = append(stack, frame{children, visits})
		}
	}
	return true
}

// First non-nil *RequestError in Go's As order. A match supplies only the HTTP status.
// A wrapping adapter is eligible only if a forwarding search fits the remaining budget.
func (b *errorWalk) findRequestStatus(err error) int {
	var status int
	walkBranches(err, func(e error, ctx treeContext) (treeFrame, bool) {
		var done treeFrame
		if !b.step() {
			return done, false
		}
		if re, ok := e.(*RequestError); ok {
			if re != nil {
				status = re.StatusCode()
			}
			return done, re == nil
		}
		children := b.httpChildren(e, 1)
		if b.limited {
			return done, false
		}
		if a, ok := e.(interface{ As(any) bool }); ok {
			if !b.queryAdapter() || len(children) != 0 && !b.allowStatusSearch(children) {
				return done, false
			}
			var re *RequestError
			if a.As(&re) && re != nil {
				status = re.StatusCode()
				return done, false
			}
		}
		return ctx.group(children), true
	})
	return status
}

// Keep the complete diagnostic walk and its first known classification even when a
// separate status lookup cannot finish. Zero means no classification was established.
func (w *errorWalk) requestStatus(err error, report func(treeProblem) bool) int {
	re, native := err.(*RequestError)
	if report != nil || !native {
		if report == nil {
			report = func(treeProblem) bool { return true }
		}
		w.run(err, treeVisitor{problem: report})
	}
	if native {
		return re.StatusCode()
	}
	if !w.limited {
		budget := *w
		if status := budget.findRequestStatus(err); status != 0 {
			return status
		}
	}
	if w.first != nil {
		return w.first.StatusCode()
	}
	return 0
}

func writeRequestProblem(w http.ResponseWriter, err error, maxDetails int) {
	p := Problem{Type: "about:blank", Status: http.StatusBadRequest}
	var walk errorWalk
	status := walk.requestStatus(err, func(f treeProblem) bool {
		if e := f.validation; e != nil {
			entry := *e
			entry.Path = f.position()
			p.Errors = append(p.Errors, entry)
		}
		if len(p.Details) < maxDetails {
			d := problemDetail(f)
			d.Value = problemMetadata(d.Value, true)
			if d.Limit != nil {
				d.Limit = problemMetadata(d.Limit, false)
				if d.Limit == nil && d.Constraint == "enum" {
					d.Allowed = nil
				}
			}
			p.Details = append(p.Details, d)
		}
		return true
	})
	if status != 0 {
		p.Status = status
	}
	p.Title = http.StatusText(p.Status)
	if walk.limited {
		p.Detail = ErrErrorTreeLimit.Error()
	} else if err != nil {
		p.Detail = err.Error()
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(p.Status)
	_ = json.NewEncoder(w).Encode(p)
}

// DefaultResponseErrorHandler writes a 500 problem response without exposing error details.
func DefaultResponseErrorHandler(w http.ResponseWriter, r *http.Request, err error) {
	WriteProblem(w, http.StatusInternalServerError, "", nil)
}

// ---------------------------------------------------------------------------------------------
// parameters (built on the ogen uri codec)

// RawPathSegments returns the escaped path segments of the request (without the leading "/").
func RawPathSegments(r *http.Request) []string {
	return strings.Split(strings.TrimPrefix(r.URL.EscapedPath(), "/"), "/")
}

// PathSegment returns escaped segment i, or segments i..n joined with "/" when rest is true.
func PathSegment(segs []string, i int, rest bool) string {
	if i >= len(segs) {
		return ""
	}
	if rest {
		return strings.Join(segs[i:], "/")
	}
	return segs[i]
}

// PathStyle maps TypeSpec path styles.
func PathStyle(style string) uri.PathStyle {
	switch style {
	case "label":
		return uri.PathStyleLabel
	case "matrix":
		return uri.PathStyleMatrix
	}
	return uri.PathStyleSimple
}

// DecodePathValue decodes a scalar path parameter from its escaped segment.
func DecodePathValue[T any](raw, name, style string, explode bool, tc TextCodec[T]) (T, error) {
	var zero T
	d := uri.NewPathDecoder(uri.PathDecoderConfig{Param: name, Value: raw, Style: PathStyle(style), Explode: explode})
	s, err := d.DecodeValue()
	if err != nil {
		return zero, err
	}
	if s, err = url.PathUnescape(s); err != nil {
		return zero, err
	}
	if s == "" {
		return zero, syntaxErrorf("empty value")
	}
	return tc.parse(s)
}

// DecodePathReserved decodes an allowReserved (`{+name}`) path parameter.
func DecodePathReserved[T any](raw string, tc TextCodec[T]) (T, error) {
	s, err := url.PathUnescape(raw)
	if err != nil {
		var zero T
		return zero, err
	}
	return tc.parse(s)
}

// DecodePathArray decodes an array path parameter.
func DecodePathArray[T any](raw, name, style string, explode bool, tc TextCodec[T]) ([]T, error) {
	d := uri.NewPathDecoder(uri.PathDecoderConfig{Param: name, Value: raw, Style: PathStyle(style), Explode: explode})
	var out []T
	err := d.DecodeArray(func(d uri.Decoder) error {
		s, err := d.DecodeValue()
		if err != nil {
			return err
		}
		if s, err = url.PathUnescape(s); err != nil {
			return err
		}
		v, err := tc.parse(s)
		if err != nil {
			return err
		}
		out = append(out, v)
		return nil
	})
	return out, err
}

// QueryStyle maps TypeSpec array encodings of query parameters.
func QueryStyle(encoding string) uri.QueryStyle {
	switch encoding {
	case "spaceDelimited":
		return uri.QueryStyleSpaceDelimited
	case "pipeDelimited":
		return uri.QueryStylePipeDelimited
	}
	return uri.QueryStyleForm
}

// DecodeQueryValue decodes a scalar query parameter; present is false when absent.
func DecodeQueryValue[T any](q url.Values, name string, tc TextCodec[T]) (v T, present bool, err error) {
	vals, ok := q[name]
	if !ok {
		return v, false, nil
	}
	if len(vals) != 1 {
		return v, true, syntaxErrorf("expected one value, got %d", len(vals))
	}
	v, err = tc.parse(vals[0])
	return v, true, err
}

// DecodeQueryArray decodes an array query parameter (form, space-, pipe- or newline-delimited).
func DecodeQueryArray[T any](q url.Values, name, encoding string, explode bool, tc TextCodec[T]) ([]T, bool, error) {
	if _, ok := q[name]; !ok {
		return nil, false, nil
	}
	if encoding == "newlineDelimited" {
		vals := q[name]
		if len(vals) != 1 {
			return nil, true, syntaxErrorf("expected one value, got %d", len(vals))
		}
		out := []T{}
		for _, s := range strings.Split(vals[0], "\n") {
			v, err := tc.parse(s)
			if err != nil {
				return nil, true, err
			}
			out = append(out, v)
		}
		return out, true, nil
	}
	d := uri.NewQueryDecoder(q)
	var out []T
	err := d.DecodeParam(uri.QueryParameterDecodingConfig{Name: name, Style: QueryStyle(encoding), Explode: explode}, func(d uri.Decoder) error {
		return d.DecodeArray(func(d uri.Decoder) error {
			s, err := d.DecodeValue()
			if err != nil {
				return err
			}
			v, err := tc.parse(s)
			if err != nil {
				return err
			}
			out = append(out, v)
			return nil
		})
	})
	if out == nil && err == nil {
		out = []T{}
	}
	return out, true, err
}

// DecodeHeaderValue decodes a scalar header.
func DecodeHeaderValue[T any](h http.Header, name string, tc TextCodec[T]) (v T, present bool, err error) {
	vals := h.Values(name)
	if len(vals) == 0 {
		return v, false, nil
	}
	if len(vals) != 1 {
		return v, true, syntaxErrorf("expected one value, got %d", len(vals))
	}
	v, err = tc.parse(vals[0])
	return v, true, err
}

// DecodeHeaderArray decodes a comma-separated (simple style) array header.
func DecodeHeaderArray[T any](h http.Header, name string, tc TextCodec[T]) ([]T, bool, error) {
	vals := h.Values(name)
	if len(vals) == 0 {
		return nil, false, nil
	}
	out := []T{}
	for _, line := range vals {
		for _, s := range strings.Split(line, ",") {
			v, err := tc.parse(strings.TrimSpace(s))
			if err != nil {
				return nil, true, err
			}
			out = append(out, v)
		}
	}
	return out, true, nil
}

// DecodeCookieValue decodes a scalar cookie.
func DecodeCookieValue[T any](r *http.Request, name string, tc TextCodec[T]) (v T, present bool, err error) {
	c, err := r.Cookie(name)
	if errors.Is(err, http.ErrNoCookie) {
		return v, false, nil
	}
	if err != nil {
		return v, true, err
	}
	v, err = tc.parse(c.Value)
	return v, true, err
}

// DecodeCookieArray decodes a comma-separated (form style, not exploded) array cookie.
func DecodeCookieArray[T any](r *http.Request, name string, tc TextCodec[T]) ([]T, bool, error) {
	c, err := r.Cookie(name)
	if errors.Is(err, http.ErrNoCookie) {
		return nil, false, nil
	}
	if err != nil {
		return nil, true, err
	}
	out := []T{}
	for _, s := range strings.Split(c.Value, ",") {
		v, err := tc.parse(s)
		if err != nil {
			return nil, true, err
		}
		out = append(out, v)
	}
	return out, true, nil
}

// FormatHeaderArray formats an array header value in simple style.
func FormatHeaderArray[T any](xs []T, tc TextCodec[T]) (string, error) {
	parts := make([]string, len(xs))
	for i, x := range xs {
		s, err := tc.Format(x)
		if err != nil {
			return "", err
		}
		parts[i] = s
	}
	return strings.Join(parts, ","), nil
}

// ---------------------------------------------------------------------------------------------
// bodies

// ReadBody reads the request body (already limited by the generated handler).
func ReadBody(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, nil
	}
	b, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, BodyError(err)
	}
	return b, nil
}

// LimitBody applies ServerOptions.MaxRequestBodyBytes.
func LimitBody(w http.ResponseWriter, r *http.Request, limit int64) {
	if limit > 0 && r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, limit)
	}
}

// RequestContentType permits a missing media type only for an absent optional body.
// Chunked requests have unknown length. At most one byte distinguishes EOF from
// an untyped payload, which must be rejected before the handler is invoked.
func RequestContentType(r *http.Request, allowed []string, optional bool) (string, error) {
	header := r.Header.Get("Content-Type")
	if optional && header == "" && r.ContentLength <= 0 {
		if r.Body == nil || r.Body == http.NoBody {
			return "", nil
		}
		var first [1]byte
		_, err := io.ReadFull(r.Body, first[:])
		if err == io.EOF {
			return "", nil
		}
		if err != nil {
			return "", BodyError(err)
		}
	}
	return MatchContentType(header, allowed)
}

// MatchContentType returns the allowed media type matching the Content-Type header value.
// Parameters (e.g. charset) are ignored; comparison is case-insensitive. An empty header
// matches only when allowEmpty is set (optional bodies).
func MatchContentType(header string, allowed []string) (string, error) {
	if header == "" {
		return "", &RequestError{Kind: ErrContentType, Location: "header", Name: "Content-Type", Err: errors.New("missing Content-Type")}
	}
	mt, _, err := mime.ParseMediaType(header)
	if err != nil {
		return "", &RequestError{Kind: ErrContentType, Location: "header", Name: "Content-Type", Err: err}
	}
	for _, a := range allowed {
		if strings.EqualFold(a, mt) || a == "*/*" {
			return a, nil
		}
		if strings.HasSuffix(a, "/*") && strings.HasPrefix(mt, strings.ToLower(strings.TrimSuffix(a, "*"))) {
			return a, nil
		}
	}
	return "", &RequestError{Kind: ErrContentType, Location: "header", Name: "Content-Type", Err: fmt.Errorf("unsupported media type %q (expected one of %s)", mt, strings.Join(allowed, ", "))}
}

// IsJSONMediaType reports whether a media type uses JSON encoding (application/json, */*+json).
func IsJSONMediaType(mt string) bool {
	mt = strings.ToLower(mt)
	return mt == "application/json" || strings.HasSuffix(mt, "+json")
}

// ---------------------------------------------------------------------------------------------
// credentials (extraction only; verification is the application's responsibility)

// BearerToken returns the token of an "Authorization: Bearer <token>" header.
func BearerToken(r *http.Request) (string, bool) {
	return AuthorizationCredentials(r, "Bearer")
}

// AuthorizationCredentials returns the credentials of an Authorization header with scheme.
func AuthorizationCredentials(r *http.Request, scheme string) (string, bool) {
	h := r.Header.Get("Authorization")
	prefix, rest, ok := strings.Cut(h, " ")
	if !ok || !strings.EqualFold(prefix, scheme) || rest == "" {
		return "", false
	}
	return strings.TrimSpace(rest), true
}

// APIKey returns the API key described by an apiKey scheme.
func APIKey(r *http.Request, s SecurityScheme) (string, bool) {
	switch s.In {
	case "header":
		v := r.Header.Get(s.Name)
		return v, v != ""
	case "query":
		v := r.URL.Query().Get(s.Name)
		return v, v != ""
	case "cookie":
		c, err := r.Cookie(s.Name)
		if err != nil {
			return "", false
		}
		return c.Value, c.Value != ""
	}
	return "", false
}

// Unauthenticated wraps an authentication failure for RequestErrorHandler (→ 401).
func Unauthenticated(err error) error {
	return &RequestError{Kind: ErrUnauthenticated, Err: err}
}

// AuthenticationError prepares a hook failure for RequestErrorHandler. An unclassified
// failure defaults to 401. Classify the same failure the handler will receive in fail-fast mode.
func (o ServerOptions) AuthenticationError(err error) error {
	if err == nil {
		return nil
	}
	if !o.CollectErrors {
		err = FirstErrors(err)
	}
	var walk errorWalk
	if walk.requestStatus(err, nil) != 0 {
		return err
	}
	return Unauthenticated(err)
}

func checkURL(s string) error {
	u, err := url.Parse(s)
	if err != nil {
		return fmt.Errorf("invalid URL %q", s)
	}
	if u.Scheme == "" {
		return fmt.Errorf("URL %q is not absolute", s)
	}
	return nil
}

// AcceptMatches reports whether an Accept header value admits mediaType (RFC 9110 §12.5.1:
// media ranges with wildcards; q=0 excludes). A missing header accepts everything.
func AcceptMatches(accept, mediaType string) bool {
	return AcceptQuality(accept, mediaType) > 0
}

// AcceptQuality applies the most specific matching media range before considering its weight.
func AcceptQuality(accept, mediaType string) float64 {
	if strings.TrimSpace(accept) == "" {
		return 1
	}
	want, attributes, err := mime.ParseMediaType(mediaType)
	if err != nil {
		return 0
	}
	category, _, _ := strings.Cut(want, "/")
	best, count, quality := -1, -1, 0.0
	for _, part := range strings.Split(accept, ",") {
		mt, params, err := mime.ParseMediaType(strings.TrimSpace(part))
		if err != nil {
			continue
		}
		rank := 0
		switch mt {
		case want:
			rank = 2
		case category + "/*":
			rank = 1
		case "*/*":
		default:
			continue
		}
		q := 1.0
		if weight, ok := params["q"]; ok {
			q, err = strconv.ParseFloat(weight, 64)
			if err != nil || q < 0 || q > 1 || math.IsNaN(q) {
				continue
			}
			delete(params, "q")
		}
		match := true
		for k, v := range params {
			if attributes[k] != v {
				match = false
			}
		}
		if match && (rank > best || rank == best && (len(params) > count || len(params) == count && q > quality)) {
			best, count, quality = rank, len(params), q
		}
	}
	return quality
}

// ContentTypeIs reports whether the request Content-Type is one of the media types.
func ContentTypeIs(r *http.Request, mediaTypes ...string) bool {
	_, err := MatchContentType(r.Header.Get("Content-Type"), mediaTypes)
	return err == nil
}

// ErrNotAcceptable reports that no representation matches the Accept header (406).
const ErrNotAcceptable RequestErrorKind = 100

// NegotiationError is reported when a request matches the route of @sharedRoute operations but
// none of them accepts it: 415 if the request media type is not accepted by any of them,
// otherwise 406 (no representation matches Accept).
func NegotiationError(r *http.Request, accept []string, contentTypes []string) error {
	if len(contentTypes) > 0 && r.Header.Get("Content-Type") != "" {
		if _, err := MatchContentType(r.Header.Get("Content-Type"), contentTypes); err != nil {
			return err
		}
	}
	return &RequestError{Kind: ErrNotAcceptable, Location: "header", Name: "Accept", Err: fmt.Errorf("no representation matches Accept %q (available: %s)", r.Header.Get("Accept"), strings.Join(accept, ", "))}
}

// CheckFormKeys enforces form-body key rules: names in never must be absent, and when closed
// (a `...Record<never>` model) every key must be one of declared. The first offending key in
// sorted order is reported.
func CheckFormKeys(vals url.Values, closed bool, declared, never []string) error {
	return CheckObjectKeys(vals, closed, declared, never)
}

// CheckObjectKeys enforces closed and never-typed fields across named form, query and multipart inputs.
func CheckObjectKeys[T any](vals map[string]T, closed bool, declared, never []string) error {
	for _, n := range never {
		if _, ok := vals[n]; ok {
			return WithPath(n, problemf(ProblemNever, "property of type never must be absent"))
		}
	}
	if !closed {
		return nil
	}
	known := make(map[string]bool, len(declared))
	for _, n := range declared {
		known[n] = true
	}
	for _, k := range sortedKeys(vals) {
		if !known[k] {
			return WithPath(k, problemf(ProblemUnknownProperty, "unknown property"))
		}
	}
	return nil
}
