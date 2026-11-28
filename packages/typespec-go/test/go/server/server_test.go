package gen

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"example.com/gen/tsgo"
)

type ctxKey struct{}

type impl struct {
	last any
}

func (s *impl) WidgetsList(ctx context.Context, r WidgetsListRequestObject) (WidgetsListResponseObject, error) {
	s.last = r
	return WidgetsList200JSONResponse{Body: PageWidgetRead{Items: []WidgetRead{{ID: "1", Name: "a"}}}}, nil
}

func (s *impl) WidgetsCreate(ctx context.Context, r WidgetsCreateRequestObject) (WidgetsCreateResponseObject, error) {
	s.last = r
	if r.Body.Name == "fail" {
		return WidgetsCreateDefaultJSONResponse{StatusCode: 422, Body: APIError{Code: "bad", Message: "nope"}}, nil
	}
	return WidgetsCreate201JSONResponse{Location: "/widgets/9", Body: WidgetRead{ID: "9", Name: r.Body.Name, Weight: r.Body.Weight}}, nil
}

func (s *impl) WidgetsRead(ctx context.Context, r WidgetsReadRequestObject) (WidgetsReadResponseObject, error) {
	s.last = r
	if r.ID == "missing" {
		return WidgetsRead404JSONResponse{Body: APIError{Code: "nf", Message: "not found"}}, nil
	}
	lm := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	return WidgetsRead200JSONResponse{Etag: "v1", LastModified: &lm, Body: WidgetRead{ID: r.ID, Name: "w"}}, nil
}

func (s *impl) WidgetsRemove(ctx context.Context, r WidgetsRemoveRequestObject) (WidgetsRemoveResponseObject, error) {
	switch r.ID {
	case "boom":
		return WidgetsRemove5XXJSONResponse{StatusCode: 503, Body: APIError{Code: "x", Message: "y"}}, nil
	case "badstatus":
		return WidgetsRemove5XXJSONResponse{StatusCode: 200, Body: APIError{Code: "x", Message: "y"}}, nil
	case "err":
		return nil, errors.New("internal detail")
	}
	return WidgetsRemove204Response{}, nil
}

func (s *impl) WidgetsSetLabel(ctx context.Context, r WidgetsSetLabelRequestObject) (WidgetsSetLabelResponseObject, error) {
	return WidgetsSetLabel200TextResponse{Body: strings.ToUpper(r.Body)}, nil
}

func (s *impl) WidgetsUpload(ctx context.Context, r WidgetsUploadRequestObject) (WidgetsUploadResponseObject, error) {
	s.last = r
	return WidgetsUpload204Response{}, nil
}

func (s *impl) WidgetsDownload(ctx context.Context, r WidgetsDownloadRequestObject) (WidgetsDownloadResponseObject, error) {
	return WidgetsDownload200BinaryResponse{Body: []byte{0, 1, 2}}, nil
}

func (s *impl) WidgetsAttach(ctx context.Context, r WidgetsAttachRequestObject) (WidgetsAttachResponseObject, error) {
	s.last = r
	return WidgetsAttach204Response{}, nil
}

func (s *impl) WidgetsBatch(ctx context.Context, r WidgetsBatchRequestObject) (WidgetsBatchResponseObject, error) {
	return WidgetsBatch200JSONResponse{Body: r.IDs}, nil
}

func (s *impl) Ping(ctx context.Context, r PingRequestObject) (PingResponseObject, error) {
	return Ping200JSONResponse{Body: Ping200ResponseBody{Ok: true, At: r.T}}, nil
}

func (s *impl) GetFile(ctx context.Context, r GetFileRequestObject) (GetFileResponseObject, error) {
	return GetFile200TextResponse{Body: r.Path}, nil
}

func (s *impl) MiscForm(ctx context.Context, r MiscFormRequestObject) (MiscFormResponseObject, error) {
	return MiscForm200JSONResponse{Body: r.Body}, nil
}

func (s *impl) MiscParams(ctx context.Context, r MiscParamsRequestObject) (MiscParamsResponseObject, error) {
	var out []string
	if r.Flavors != nil {
		out = append(out, *r.Flavors...)
	}
	if r.Lines != nil {
		out = append(out, *r.Lines...)
	}
	return MiscParams200JSONResponse{Body: out}, nil
}

func (s *impl) MiscTuple(ctx context.Context, r MiscTupleRequestObject) (MiscTupleResponseObject, error) {
	s.last = r
	return MiscTuple204Response{}, nil
}

func authenticator(ctx context.Context, r *http.Request, op tsgo.OperationInfo) (context.Context, error) {
	if op.AllowsAnonymous() {
		return ctx, nil
	}
	tok, ok := tsgo.BearerToken(r)
	if !ok || tok != "secret" {
		return nil, errors.New("bad token")
	}
	return context.WithValue(ctx, ctxKey{}, "u1"), nil
}

func server(t *testing.T, opts ServerOptions) (*impl, *httptest.Server) {
	t.Helper()
	s := &impl{}
	if opts.Authenticate == nil {
		opts.Authenticate = authenticator
	}
	ts := httptest.NewServer(NewHandler(s, opts))
	t.Cleanup(ts.Close)
	return s, ts
}

func do(t *testing.T, ts *httptest.Server, method, path string, body io.Reader, headers map[string]string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(method, ts.URL+path, body)
	req.Header.Set("Authorization", "Bearer secret")
	for k, v := range headers {
		if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	return res, string(b)
}

func TestQueryHeaderBindingAndDefaults(t *testing.T) {
	s, ts := server(t, ServerOptions{})
	res, body := do(t, ts, "GET", "/widgets?tags=a&tags=b&colors=red|blue", nil, map[string]string{"x-request-id": "r1"})
	if res.StatusCode != 200 || !strings.Contains(body, `"items":[{"id":"1","name":"a"}]`) {
		t.Fatalf("%d %s", res.StatusCode, body)
	}
	r := s.last.(WidgetsListRequestObject)
	if strings.Join(*r.Tags, ",") != "a,b" || strings.Join(*r.Colors, ",") != "red,blue" || *r.RequestID != "r1" {
		t.Fatalf("%+v", r)
	}
	if r.Limit == nil || *r.Limit != 10 {
		t.Fatal("query default not applied")
	}
	res, body = do(t, ts, "GET", "/widgets?limit=500", nil, nil)
	if res.StatusCode != 400 || !strings.Contains(body, "query:limit") {
		t.Fatalf("validation: %d %s", res.StatusCode, body)
	}
	if res, _ := do(t, ts, "GET", "/widgets?limit=x", nil, nil); res.StatusCode != 400 {
		t.Fatal("bad integer accepted")
	}
	if res, _ := do(t, ts, "GET", "/widgets?limit=1&limit=2", nil, nil); res.StatusCode != 400 {
		t.Fatal("repeated scalar query parameter accepted")
	}
}

func TestCreateVisibilityAndResponses(t *testing.T) {
	s, ts := server(t, ServerOptions{})
	json_ := map[string]string{"Content-Type": "application/json"}
	res, body := do(t, ts, "POST", "/widgets", strings.NewReader(`{"name":"n","secret":"s"}`), json_)
	if res.StatusCode != 201 || res.Header.Get("Location") != "/widgets/9" {
		t.Fatalf("%d %s", res.StatusCode, body)
	}
	if !strings.Contains(body, `"weight":1.5`) || strings.Contains(body, "secret") {
		t.Fatalf("defaults/visibility in response: %s", body)
	}
	if req := s.last.(WidgetsCreateRequestObject); req.Body.Secret == nil || *req.Body.Secret != "s" {
		t.Fatal("create-visible property not decoded")
	}
	if res, body := do(t, ts, "POST", "/widgets", strings.NewReader(`{"name":""}`), json_); res.StatusCode != 400 || !strings.Contains(body, "/body/name") {
		t.Fatalf("validation: %d %s", res.StatusCode, body)
	}
	if res, _ := do(t, ts, "POST", "/widgets", strings.NewReader(`{"name":"x"}`), map[string]string{"Content-Type": "text/plain"}); res.StatusCode != 415 {
		t.Fatalf("content type: %d", res.StatusCode)
	}
	if res, _ := do(t, ts, "POST", "/widgets", strings.NewReader(`{"name":1}`), json_); res.StatusCode != 400 {
		t.Fatal("type error accepted")
	}
	if res, body := do(t, ts, "POST", "/widgets", strings.NewReader(`{"name":"fail"}`), json_); res.StatusCode != 422 || !strings.Contains(body, `"code":"bad"`) {
		t.Fatalf("default response: %d %s", res.StatusCode, body)
	}
	if res, _ := do(t, ts, "POST", "/widgets", nil, json_); res.StatusCode != 400 {
		t.Fatal("missing body accepted")
	}
}

func TestPathCookieHeadersAndStatusRanges(t *testing.T) {
	s, ts := server(t, ServerOptions{ValidateResponses: true})
	req, _ := http.NewRequest("GET", ts.URL+"/widgets/a%2Fb", nil)
	req.Header.Set("Authorization", "Bearer secret")
	req.AddCookie(&http.Cookie{Name: "session", Value: "abc"})
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 || res.Header.Get("etag") != "v1" || res.Header.Get("last-modified") != "Tue, 02 Jan 2024 03:04:05 GMT" {
		t.Fatalf("%d %v", res.StatusCode, res.Header)
	}
	if r := s.last.(WidgetsReadRequestObject); r.ID != "a/b" || r.Session == nil || *r.Session != "abc" {
		t.Fatalf("%+v", r)
	}
	if res, _ := do(t, ts, "GET", "/widgets/missing", nil, nil); res.StatusCode != 404 {
		t.Fatal("404 variant")
	}
	if res, _ := do(t, ts, "DELETE", "/widgets/boom", nil, nil); res.StatusCode != 503 {
		t.Fatal("status range")
	}
	if res, _ := do(t, ts, "DELETE", "/widgets/badstatus", nil, nil); res.StatusCode != 500 {
		t.Fatal("out-of-range status must fail response validation")
	}
	if res, body := do(t, ts, "DELETE", "/widgets/err", nil, nil); res.StatusCode != 500 || strings.Contains(body, "internal detail") {
		t.Fatalf("handler errors must not leak: %s", body)
	}
	if res, _ := do(t, ts, "DELETE", "/widgets/ok", nil, nil); res.StatusCode != 204 {
		t.Fatal("204")
	}
	if res, body := do(t, ts, "GET", "/widgets/a,b%2Cc/batch", nil, nil); res.StatusCode != 200 || body != `["a","b,c"]` {
		t.Fatalf("array path: %d %s", res.StatusCode, body)
	}
	if res, body := do(t, ts, "GET", "/files/a/b/c.txt", nil, nil); res.StatusCode != 200 || body != "a/b/c.txt" {
		t.Fatalf("reserved path: %d %s", res.StatusCode, body)
	}
	if res, _ := do(t, ts, "PATCH", "/widgets/x", nil, nil); res.StatusCode != 405 {
		t.Fatal("method not allowed")
	}
	if res, _ := do(t, ts, "GET", "/nope", nil, nil); res.StatusCode != 404 {
		t.Fatal("not found")
	}
}

func TestTextBinaryMultipart(t *testing.T) {
	s, ts := server(t, ServerOptions{})
	res, body := do(t, ts, "PUT", "/widgets/1/label", strings.NewReader("hello"), map[string]string{"Content-Type": "text/plain; charset=utf-8"})
	if res.StatusCode != 200 || body != "HELLO" || res.Header.Get("Content-Type") != "text/plain" {
		t.Fatalf("text: %d %q %v", res.StatusCode, body, res.Header)
	}
	res, _ = do(t, ts, "PUT", "/widgets/1/blob", bytes.NewReader([]byte{9, 8, 7}), map[string]string{"Content-Type": "application/octet-stream"})
	if res.StatusCode != 204 || !bytes.Equal(s.last.(WidgetsUploadRequestObject).Body, []byte{9, 8, 7}) {
		t.Fatal("binary upload")
	}
	if res, body := do(t, ts, "GET", "/widgets/1/blob", nil, nil); res.StatusCode != 200 || body != "\x00\x01\x02" || res.Header.Get("Content-Type") != "application/octet-stream" {
		t.Fatal("binary download")
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("description", "desc")
	fw, _ := mw.CreateFormFile("file", "a.txt")
	_, _ = fw.Write([]byte("contents"))
	_ = mw.WriteField("extra", `{"name":"x"}`)
	mw.Close()
	res, body = do(t, ts, "POST", "/widgets/1/attachments", &buf, map[string]string{"Content-Type": mw.FormDataContentType()})
	if res.StatusCode != 204 {
		t.Fatalf("multipart: %d %s", res.StatusCode, body)
	}
	b := s.last.(WidgetsAttachRequestObject).Body
	if b.Description != "desc" || b.File.Filename != "a.txt" || string(b.File.Contents) != "contents" || b.Extra == nil || b.Extra.Name != "x" {
		t.Fatalf("%+v", b)
	}
	buf.Reset()
	mw = multipart.NewWriter(&buf)
	_ = mw.WriteField("description", "only")
	mw.Close()
	if res, _ := do(t, ts, "POST", "/widgets/1/attachments", &buf, map[string]string{"Content-Type": mw.FormDataContentType()}); res.StatusCode != 400 {
		t.Fatal("missing required part accepted")
	}
}

func TestAuthMiddlewareAndLimits(t *testing.T) {
	var seen []string
	mw := func(f StrictHandlerFunc, op tsgo.OperationInfo) StrictHandlerFunc {
		return func(ctx context.Context, w http.ResponseWriter, r *http.Request, req any) (any, error) {
			user, _ := ctx.Value(ctxKey{}).(string)
			seen = append(seen, op.ID+":"+user)
			return f(ctx, w, r, req)
		}
	}
	_, ts := server(t, ServerOptions{Middlewares: []StrictMiddlewareFunc{mw}, MaxRequestBodyBytes: 64})
	if res, _ := do(t, ts, "GET", "/widgets", nil, map[string]string{"Authorization": ""}); res.StatusCode != 401 {
		t.Fatal("missing token accepted")
	}
	if res, _ := do(t, ts, "GET", "/widgets", nil, nil); res.StatusCode != 200 {
		t.Fatal("token rejected")
	}
	if len(seen) != 1 || seen[0] != "Widgets_list:u1" {
		t.Fatalf("middleware/context: %v", seen)
	}
	big := `{"name":"` + strings.Repeat("x", 100) + `"}`
	if res, _ := do(t, ts, "POST", "/widgets", strings.NewReader(big), map[string]string{"Content-Type": "application/json"}); res.StatusCode != 413 {
		t.Fatalf("body limit: %d", res.StatusCode)
	}
	res, body := do(t, ts, "GET", "/public?t=2024-01-02T03:04:05Z", nil, map[string]string{"Authorization": ""})
	if res.StatusCode != 200 || body != `{"ok":true,"at":"2024-01-02T03:04:05Z"}` {
		t.Fatalf("anonymous op: %d %s", res.StatusCode, body)
	}
	h := NewHandler(&impl{}, ServerOptions{})
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/widgets", nil))
	if rr.Code != 401 {
		t.Fatal("operations with security must fail closed without an authenticator")
	}
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/public", nil))
	if rr.Code != 200 {
		t.Fatal("NoAuth operation must work without an authenticator")
	}
}

// The application publishes an HTTP classification and exposes the actual credential
// failures separately. Its status view deliberately has unrelated metadata.
type authStatusView struct{ kind tsgo.RequestErrorKind }

func (authStatusView) Error() string { return "credential check failed" }
func (e authStatusView) As(target any) bool {
	re, ok := target.(**tsgo.RequestError)
	if ok {
		*re = &tsgo.RequestError{Kind: e.kind, Location: "query", Name: "invented", Err: errors.New("status view")}
	}
	return ok
}

type wrappedAuthStatus struct {
	authStatusView
	cause error
}

func (e wrappedAuthStatus) Unwrap() error { return e.cause }

type nilAuthStatus struct{ error }

func (e nilAuthStatus) Unwrap() error { return e.error }
func (nilAuthStatus) As(target any) bool {
	if re, ok := target.(**tsgo.RequestError); ok {
		*re = nil
		return true
	}
	return false
}

func TestAuthenticationProblemStatus(t *testing.T) {
	plain := errors.New("token rejected")
	failures := errors.Join(
		tsgo.ValidationError{Path: "/token", Constraint: "expired", Message: "expired token"},
		tsgo.ValidationError{Path: "/issuer", Constraint: "unknown", Message: "unknown issuer"},
	)
	large := &tsgo.RequestError{Kind: tsgo.ErrBodyTooLarge, Err: plain}
	for _, tc := range []struct {
		name   string
		err    error
		status int
		joined bool
	}{
		{"plain", plain, 401, false},
		{"concrete", tsgo.Unauthenticated(plain), 401, false},
		{"wrapped concrete", fmt.Errorf("auth: %w", large), 413, false},
		{"opaque As", authStatusView{tsgo.ErrBodyTooLarge}, 413, false},
		{"explicit bad request", wrappedAuthStatus{authStatusView{tsgo.ErrParameter}, plain}, 400, false},
		{"wrapping As 401", wrappedAuthStatus{authStatusView{tsgo.ErrUnauthenticated}, plain}, 401, false},
		{"wrapping As 413", wrappedAuthStatus{authStatusView{tsgo.ErrBodyTooLarge}, failures}, 413, true},
		{"nested wrapping As", fmt.Errorf("verifier: %w", wrappedAuthStatus{authStatusView{tsgo.ErrUnauthenticated}, large}), 401, false},
		{"first classified branch", errors.Join(plain, large, tsgo.Unauthenticated(plain)), 413, false},
		{"forwarding to size limit", forwardingAuthError{errors.Join(plain, large), new(int)}, 413, false},
		{"validation check cause", tsgo.ValidationErrors{{Path: "/token", Message: "too long", Err: large}}, 413, false},
		{"nil As falls through", nilAuthStatus{large}, 413, false},
		{"nil As without classification", nilAuthStatus{plain}, 401, false},
	} {
		for _, detailed := range []bool{false, true} {
			for _, collect := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/detailed=%t/collect=%t", tc.name, detailed, collect), func(t *testing.T) {
					service := &impl{}
					calls := 0
					h := NewHandler(service, ServerOptions{
						CollectErrors: collect,
						ErrorDetails:  detailed,
						Authenticate: func(context.Context, *http.Request, tsgo.OperationInfo) (context.Context, error) {
							calls++
							return nil, tc.err
						},
					})
					w := httptest.NewRecorder()
					r := httptest.NewRequest("GET", "/widgets", nil)
					r.Header.Set("Authorization", "Bearer bad")
					h.ServeHTTP(w, r)
					var p tsgo.Problem
					if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || w.Code != tc.status || p.Status != tc.status ||
						p.Title != http.StatusText(tc.status) || p.Detail != tc.err.Error() || w.Header().Get("Content-Type") != "application/problem+json" {
						t.Fatalf("HTTP %d, problem %s (want %d)", w.Code, w.Body.String(), tc.status)
					}
					if calls != 1 || service.last != nil {
						t.Fatalf("auth calls %d, operation received %v", calls, service.last)
					}
					if tc.joined {
						if len(p.Errors) != 2 || p.Errors[0].Path != "/token" || p.Errors[0].Constraint != "expired" || p.Errors[0].Message != "expired token" ||
							p.Errors[1].Path != "/issuer" || p.Errors[1].Constraint != "unknown" || p.Errors[1].Message != "unknown issuer" {
							t.Fatalf("credential failures %+v", p.Errors)
						}
						n := 0
						if detailed {
							n = 2
						}
						if len(p.Details) != n {
							t.Fatalf("details %+v", p.Details)
						}
						for i, d := range p.Details {
							if d.Path != p.Errors[i].Path || d.Constraint != p.Errors[i].Constraint || d.Message != p.Errors[i].Message || d.Kind != tsgo.ErrorValidation || d.Location != "" || d.Parameter != "" {
								t.Fatalf("status view leaked into detail %+v", d)
							}
						}
					}
				})
			}
		}
	}
}

func TestAuthenticationClassifiesTheReportedFailure(t *testing.T) {
	denied := errors.New("bad token")
	large := &tsgo.RequestError{Kind: tsgo.ErrBodyTooLarge, Err: errors.New("oversized credential")}
	group := &tsgo.MultiError{Errors: []error{denied, large}}
	for _, collect := range []bool{false, true} {
		var reported error
		h := NewHandler(&impl{}, ServerOptions{
			CollectErrors: collect,
			Authenticate: func(context.Context, *http.Request, tsgo.OperationInfo) (context.Context, error) {
				return nil, group
			},
			RequestErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
				reported = err
				tsgo.DetailedRequestErrorHandler(2)(w, r, err)
			},
		})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "/widgets", nil))
		var p tsgo.Problem
		if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || !errors.Is(reported, denied) {
			t.Fatalf("reported %v, problem %s", reported, w.Body.String())
		}
		if collect {
			if reported != group || w.Code != 413 || len(p.Details) != 2 || p.Details[1].Kind != tsgo.ErrorBodyTooLarge {
				t.Fatalf("collect: %T, HTTP %d %s", reported, w.Code, w.Body.String())
			}
		} else if w.Code != 401 || len(p.Details) != 1 || p.Details[0].Kind != tsgo.ErrorUnauthenticated || errors.Is(reported, large) {
			t.Fatalf("fail-fast: %T, HTTP %d %s", reported, w.Code, w.Body.String())
		}
	}
}

type forwardingAuthError struct {
	error
	calls *int
}

func (e forwardingAuthError) Error() string { return "verifier failed" }
func (e forwardingAuthError) Unwrap() error { return e.error }
func (e forwardingAuthError) As(target any) bool {
	*e.calls++
	return errors.As(e.error, target)
}

func TestAuthenticationBoundsForwardingAdapters(t *testing.T) {
	calls := 0
	var failure error = tsgo.ValidationError{Path: "/token", Message: "invalid token"}
	for range 12 {
		failure = forwardingAuthError{failure, &calls}
	}
	h := NewHandler(&impl{}, ServerOptions{
		ErrorDetails: true,
		Authenticate: func(context.Context, *http.Request, tsgo.OperationInfo) (context.Context, error) {
			return nil, failure
		},
	})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/widgets", nil))
	var p tsgo.Problem
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || w.Code != 401 || calls > tsgo.MaxErrorTreeViews ||
		len(p.Errors) != 1 || p.Errors[0].Path != "/token" || len(p.Details) != 1 || p.Details[0].Path != "/token" {
		t.Fatalf("HTTP %d after %d adapter calls: %s", w.Code, calls, w.Body.String())
	}
}

func TestOperationInfosAndProblems(t *testing.T) {
	if n := len(OperationInfos()); n != 14 {
		t.Fatalf("%d operations", n)
	}
	for _, op := range OperationInfos() {
		if op.ID == "Widgets_list" && (len(op.Security) != 1 || op.Security[0][0].Scheme != "Bearer") {
			t.Fatalf("security metadata: %+v", op.Security)
		}
	}
	var problem tsgo.Problem
	_, ts := server(t, ServerOptions{})
	_, body := do(t, ts, "GET", "/widgets?limit=0", nil, nil)
	if err := json.Unmarshal([]byte(body), &problem); err != nil || problem.Status != 400 || len(problem.Errors) != 1 || problem.Errors[0].Path != "/query:limit" {
		t.Fatalf("problem details: %s", body)
	}
}

// Response variants of one operation cannot be returned from another: this would not compile.
//
//	func (s *impl) WidgetsRead(...) (WidgetsReadResponseObject, error) { return WidgetsRemove204Response{}, nil }
var _ WidgetsReadResponseObject = WidgetsRead404JSONResponse{}

func TestFormCookiesNewlinesTupleMultipart(t *testing.T) {
	s, ts := server(t, ServerOptions{})
	res, body := do(t, ts, "POST", "/misc/form", strings.NewReader("name=a+b&tags=x&tags=y"), map[string]string{"Content-Type": "application/x-www-form-urlencoded"})
	if res.StatusCode != 200 || body != `{"name":"a b","tags":["x","y"],"n":7}` {
		t.Fatalf("form: %d %s", res.StatusCode, body)
	}
	if res, _ := do(t, ts, "POST", "/misc/form", strings.NewReader("tags=x"), map[string]string{"Content-Type": "application/x-www-form-urlencoded"}); res.StatusCode != 400 {
		t.Fatal("missing required form field accepted")
	}
	if res, _ := do(t, ts, "POST", "/misc/form", strings.NewReader("name=a&n=x"), map[string]string{"Content-Type": "application/x-www-form-urlencoded"}); res.StatusCode != 400 {
		t.Fatal("invalid form integer accepted")
	}
	req, _ := http.NewRequest("GET", ts.URL+"/misc/params?lines=l1%0Al2", nil)
	req.Header.Set("Authorization", "Bearer secret")
	req.AddCookie(&http.Cookie{Name: "flavors", Value: "a,b"})
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	if string(b) != `["a","b","l1","l2"]` {
		t.Fatalf("cookie array / newline query: %s", b)
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("a", "text")
	fw, _ := mw.CreateFormFile("f", "f.bin")
	_, _ = fw.Write([]byte{1, 2})
	mw.Close()
	if res, body := do(t, ts, "POST", "/misc/tuple", &buf, map[string]string{"Content-Type": mw.FormDataContentType()}); res.StatusCode != 204 {
		t.Fatalf("tuple multipart: %d %s", res.StatusCode, body)
	}
	if b := s.last.(MiscTupleRequestObject).Body; b.A != "text" || !bytes.Equal(b.F.Contents, []byte{1, 2}) {
		t.Fatalf("%+v", b)
	}
}

func TestOperationMetadataIsolation(t *testing.T) {
	infos := OperationInfos()
	var touched bool
	for _, op := range infos {
		if len(op.Security) > 0 && len(op.Security[0]) > 0 {
			op.Security[0][0].ID = "modified"
			touched = true
		}
	}
	if !touched {
		t.Fatal("fixture needs authentication metadata")
	}
	for _, op := range OperationInfos() {
		for _, requirement := range op.Security {
			for _, scheme := range requirement {
				if scheme.ID == "modified" {
					t.Fatal("operation metadata shared between callers")
				}
			}
		}
	}
}
