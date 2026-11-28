package tsgo

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"unicode/utf8"
)

// Request errors as data. Decoding collects every independent failure of an input (all
// properties of an object, all items of an array or record), bounded by MaxCollectedErrors per
// value; the first failure remains the error's message and what errors.As finds, so code written
// for fail-fast decoding sees no difference. Details flattens any error returned by generated
// code (decoding, validation, parameters, request errors) into stable ErrorDetail records.

// MaxCollectedErrors bounds the failures kept per decoded object, array or record.
const MaxCollectedErrors = 100

// MultiError holds several independent failures. Its message is the first one's; Unwrap gives
// all of them (errors.Is and errors.As search them in order).
type MultiError struct {
	Errors []error

	partialState
}

func (e *MultiError) Error() string { return e.Errors[0].Error() }

func (e *MultiError) Unwrap() []error { return e.Errors }

// joinErrors returns nil, the single error, or a MultiError.
func joinErrors(errs []error) error {
	switch len(errs) {
	case 0:
		return nil
	case 1:
		return errs[0]
	}
	return &MultiError{Errors: errs}
}

// FirstErrors follows the first failure of each native collection. Remember the envelopes
// above the last collection so an unchanged suffix keeps its message, raw value and causes.
func FirstErrors(err error) error {
	result := err
	var parents []error
	cut := 0
	var w errorWalk
	for err != nil {
		if !w.step() {
			if w.first != nil {
				c := *w.first
				c.Err, c.decoded = traversalLimitEntry(), false
				return &c
			}
			return traversalLimitEntry()
		}
		switch e := err.(type) {
		case *RequestError:
			if w.first == nil {
				w.first = e
			}
			parents = append(parents, e)
			err = e.Err
			continue
		case *DecodeError:
			parents = append(parents, e)
			err = e.Err
			continue
		case *MultiError:
			if len(e.Errors) > 0 {
				err = e.Errors[0]
				result, cut = err, len(parents)
				continue
			}
		}
		break
	}
	for i := cut - 1; i >= 0; i-- {
		switch e := parents[i].(type) {
		case *RequestError:
			c := *e
			c.Err = result
			result = &c
		case *DecodeError:
			result = withPrefix(e.Path, result)
		}
	}
	return result
}

// ---------------------------------------------------------------------------------------------
// decoding problems

// ProblemKind classifies a decoding failure. The values are stable strings.
type ProblemKind string

const (
	ProblemSyntax            ProblemKind = "syntax"             // malformed JSON (or XML), or not the expected text form
	ProblemType              ProblemKind = "type"               // the value has another JSON type: Expected, Got
	ProblemRequired          ProblemKind = "required"           // a required property, parameter, part or body is missing
	ProblemUnknownProperty   ProblemKind = "unknown-property"   // an undeclared property of a closed model (or reject policy)
	ProblemDuplicateProperty ProblemKind = "duplicate-property" // a property appears twice
	ProblemNever             ProblemKind = "never"              // a property of type never is present
	ProblemEnum              ProblemKind = "enum"               // not a member of a closed enum: Allowed
	ProblemLiteral           ProblemKind = "literal"            // not the declared literal value: Allowed
	ProblemDiscriminator     ProblemKind = "discriminator"      // the discriminator identifies no variant: Allowed
	ProblemUnion             ProblemKind = "union"              // no variant of an undiscriminated union decodes the value
	ProblemRange             ProblemKind = "range"              // a number outside the Go type: Expected, Minimum, Maximum
	ProblemPrecision         ProblemKind = "precision"          // a number beyond the exact range or precision of the type
	ProblemFormat            ProblemKind = "format"             // a string (or parameter) not in the expected format: Expected
	ProblemUnicode           ProblemKind = "unicode"            // invalid UTF-8 or an unpaired UTF-16 surrogate escape
	ProblemItems             ProblemKind = "items"              // a tuple with another number of items: Minimum = Maximum = the count
)

// DecodeProblem is the machine-readable cause of a decoding failure (the Err of a *DecodeError,
// or the error of a parameter): consumers need not parse messages.
type DecodeProblem struct {
	Kind ProblemKind
	// Expected is the expected JSON type ("string", "integer", ...), format ("date-time",
	// "duration", "base64", ...) or Go numeric type ("int32", "float32"); Got the JSON type found.
	Expected string
	Got      string
	// Allowed lists the accepted values (enum members, the literal, discriminator values).
	Allowed []any
	// Minimum and Maximum are the range of the target numeric type, or a tuple's item count.
	Minimum, Maximum any
	Message          string
	// Err is the underlying error of a text codec (errors.Is and errors.As find it).
	Err error
}

func (p *DecodeProblem) Error() string { return p.Message }

func (p *DecodeProblem) Unwrap() error { return p.Err }

// RequiredError reports a missing required value (generated parameter and body binding).
func RequiredError(message string) error {
	return &DecodeProblem{Kind: ProblemRequired, Message: message}
}

// EnumError reports a value that is not a member of a closed enum.
func EnumError(value any, allowed ...any) error {
	return &DecodeProblem{Kind: ProblemEnum, Allowed: allowed, Message: fmt.Sprintf("%v is not one of %v", value, allowed)}
}

// DiscriminatorError reports a discriminator value that identifies no variant.
func DiscriminatorError(tag string, allowed ...string) error {
	vals := make([]any, len(allowed))
	for i, a := range allowed {
		vals[i] = a
	}
	return &DecodeProblem{Kind: ProblemDiscriminator, Allowed: vals, Message: fmt.Sprintf("unknown discriminator value %q", tag)}
}

// FormatError reports text that is not in the expected format (expected names it), wrapping the
// error of the parser.
func FormatError(expected string, err error) error {
	var p *DecodeProblem
	if errors.As(err, &p) {
		return err
	}
	return &DecodeProblem{Kind: ProblemFormat, Expected: expected, Message: err.Error(), Err: err}
}

// ---------------------------------------------------------------------------------------------
// details

// ErrorKind classifies a problem. The values are stable strings.
type ErrorKind string

const (
	ErrorTraversalLimit  ErrorKind = "traversal-limit" // failure enumeration exceeded a runtime budget
	ErrorDecode          ErrorKind = "decode"          // the input does not decode into the declared types
	ErrorValidation      ErrorKind = "validation"      // a decoded value violates a constraint (including custom checks)
	ErrorParameter       ErrorKind = "parameter"       // a path, query, header or cookie parameter is invalid
	ErrorContentType     ErrorKind = "content-type"    // unsupported or missing request media type
	ErrorUnauthenticated ErrorKind = "unauthenticated" // authentication failed
	ErrorBodyTooLarge    ErrorKind = "body-too-large"  // the request body exceeds the configured limit
	ErrorNotAcceptable   ErrorKind = "not-acceptable"  // no acceptable response media type
)

// ErrorDetail is one machine-readable problem of a request.
type ErrorDetail struct {
	Kind ErrorKind `json:"kind"`
	// Location is "body", "path", "query", "header" or "cookie"; Parameter names the parameter.
	Location  string `json:"location,omitempty"`
	Parameter string `json:"parameter,omitempty"`
	// Path is the JSON Pointer of the offending value: within the body or parameter value for
	// decoding errors, within the request (/body/..., /query:name) for validation errors.
	Path string `json:"path"`
	// Constraint names the violated constraint: for validation errors "maxLength", "pattern",
	// "enum", ... or an application-defined name; for decoding errors the ProblemKind ("type",
	// "required", "enum", "range", ...). Limit is a validation constraint's parameter (the bound,
	// the pattern, the values).
	Constraint string `json:"constraint,omitempty"`
	Limit      any    `json:"limit,omitempty"`
	// Expected and Got are the expected JSON type, format or Go numeric type and the JSON type
	// found; Allowed the accepted values; Minimum and Maximum the range of the target type
	// (decoding errors, see DecodeProblem).
	Expected string `json:"expected,omitempty"`
	Got      string `json:"got,omitempty"`
	Allowed  []any  `json:"allowed,omitempty"`
	Minimum  any    `json:"minimum,omitempty"`
	Maximum  any    `json:"maximum,omitempty"`
	// Value is the offending value when it is known: decoded for validation errors, the raw JSON
	// for decoding errors (truncated to MaxDetailValueBytes).
	Value any `json:"value,omitempty"`
	// Variant is the union variant the input was identified as (the innermost one when unions
	// are nested; Unions lists them from the outermost); Variants the candidates that were tried
	// when no variant could be identified.
	Variant  string        `json:"variant,omitempty"`
	Unions   []UnionChoice `json:"unions,omitempty"`
	Variants []string      `json:"variants,omitempty"`
	Message  string        `json:"message"`
	// Err retains a custom check's error, a parser cause, or a plain problem with its wrappers.
	Err error `json:"-"`
}

// UnionChoice is the variant a union value at Path (JSON Pointer) was identified as.
type UnionChoice struct {
	Path    string `json:"path"`
	Variant string `json:"variant"`
}

// MaxDetailValueBytes bounds offending values copied into errors and details.
const MaxDetailValueBytes = 256

func requestKind(k RequestErrorKind) ErrorKind {
	switch k {
	case ErrParameter:
		return ErrorParameter
	case ErrValidation:
		return ErrorValidation
	case ErrContentType:
		return ErrorContentType
	case ErrUnauthenticated:
		return ErrorUnauthenticated
	case ErrBodyTooLarge:
		return ErrorBodyTooLarge
	case ErrNotAcceptable:
		return ErrorNotAcceptable
	}
	return ErrorDecode
}

// validationLocation fills the location of a validation error from its request path.
func validationLocation(d ErrorDetail) ErrorDetail {
	if d.Location != "" {
		return d
	}
	first, _, _ := strings.Cut(strings.TrimPrefix(d.Path, "/"), "/")
	if first == "body" {
		d.Location = "body"
	} else if loc, name, ok := strings.Cut(first, ":"); ok && (loc == "path" || loc == "query" || loc == "header" || loc == "cookie") {
		d.Location, d.Parameter = loc, strings.NewReplacer("~1", "/", "~0", "~").Replace(name)
	}
	return d
}

// anySlice converts the allowed values of an enum check ([]T) to []any.
func anySlice(v any) []any {
	values := reflect.ValueOf(v)
	if values.Kind() != reflect.Slice {
		return nil
	}
	out := make([]any, values.Len())
	for i := range out {
		out[i] = values.Index(i).Interface()
	}
	return out
}

// withValue records the raw JSON of the value whose decoding failed (when err is about that
// value itself, not about a nested one).
func withValue(err error, raw []byte) error {
	de, ok := err.(*DecodeError)
	if !ok || de == nil || de.Path != "" || de.Value != nil {
		return err
	}
	c := *de
	c.Value = boundedRaw(raw)
	return &c
}

func boundedRaw(raw []byte) json.RawMessage {
	s := strings.TrimSpace(string(raw))
	if len(s) > MaxDetailValueBytes || !json.Valid([]byte(s)) {
		// Truncated values are reported as JSON strings so that details remain valid JSON.
		cut := min(len(s), MaxDetailValueBytes)
		for cut > 0 && cut < len(s) && !utf8.RuneStart(s[cut]) {
			cut--
		}
		b, _ := json.Marshal(s[:cut] + "…")
		return b
	}
	return json.RawMessage(s)
}

// boundedValue keeps offending values small (long strings are truncated).
func boundedValue(v any) any {
	if s, ok := v.(string); ok && len(s) > MaxDetailValueBytes {
		cut := MaxDetailValueBytes
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		return s[:cut] + "…"
	}
	return v
}

// problemMetadata freezes application-supplied metadata before the HTTP response is committed.
// Go-only values remain available through Details and are absent from the JSON representation.
func problemMetadata(value any, bound bool) any {
	if value == nil {
		return nil
	}
	if s, ok := value.(string); ok && bound {
		return boundedValue(s)
	}
	b, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	if bound && len(b) > MaxDetailValueBytes {
		return boundedRaw(b)
	}
	return json.RawMessage(b)
}
