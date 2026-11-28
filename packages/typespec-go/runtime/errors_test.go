package tsgo

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestCollectedErrorsKeepFailFastBehaviour(t *testing.T) {
	r, err := NewObjectReader([]byte(`{"a":1,"b":"x","c":true}`))
	if err != nil {
		t.Fatal(err)
	}
	var a string
	var b int32
	ReadRequired(r, "a", &a, StringCodec)
	ReadRequired(r, "b", &b, IntCodec[int32]())
	ReadRequired(r, "missing", &a, StringCodec)
	err = WithPath("outer", r.Finish(RejectUnknown))
	var me *MultiError
	if !errors.As(err, &me) || len(me.Errors) != 4 {
		t.Fatalf("%v", err)
	}
	// Message and errors.As are the first failure's, exactly as with fail-fast decoding.
	var de *DecodeError
	if !errors.As(err, &de) || de.Path != "/outer/a" || err.Error() != "/outer/a: expected string, got number" {
		t.Fatalf("%q", err)
	}
	first := FirstErrors(err)
	if _, ok := first.(*MultiError); ok || first.Error() != err.Error() {
		t.Fatalf("%v", first)
	}
	var paths []string
	for _, d := range Details(err, 0) {
		paths = append(paths, d.Path)
	}
	if strings.Join(paths, " ") != "/outer/a /outer/b /outer/missing /outer/c" {
		t.Fatal(paths)
	}
	if d := Details(err, 0)[0]; string(d.Value.(json.RawMessage)) != "1" || d.Kind != ErrorDecode {
		t.Fatalf("%+v", d)
	}
}

func TestDetailsOfValidationAndCustomErrors(t *testing.T) {
	custom := errors.New("custom failure")
	v := NewValidator()
	MaxLength(v.At("name"), strings.Repeat("é", 300), 3)
	v.At("x").AddError("app-rule", custom)
	err := ValidationRequestError(v.Err())
	if !errors.Is(err, custom) {
		t.Fatal("custom error not reachable")
	}
	d := Details(err, 0)
	if len(d) != 2 || d[0].Kind != ErrorValidation || d[0].Limit != 3 || d[1].Constraint != "app-rule" || d[1].Err != custom {
		t.Fatalf("%+v", d)
	}
	if s := d[0].Value.(string); len(s) > MaxDetailValueBytes+len("…") || !strings.HasSuffix(s, "…") {
		t.Fatalf("value not bounded: %d bytes", len(s))
	}
}

func TestOversizedRawValuesStayValidJSON(t *testing.T) {
	raw := `"` + strings.Repeat("x", 1000) + `"`
	err := withValue(decodeErrorf("bad"), []byte(raw))
	var de *DecodeError
	if !errors.As(err, &de) || len(de.Value) > MaxDetailValueBytes+16 || !json.Valid(de.Value) {
		t.Fatalf("%s", de.Value)
	}
}

func TestWrappedRequestDetailsPreserveAllLocations(t *testing.T) {
	inner := &MultiError{Errors: []error{
		ParamError("query", "q", RequiredError("absent")),
		BodyError(WithPath("x", problemf(ProblemType, "wrong type"))),
	}}
	if direct, wrapped := Details(inner, 2), Details(fmt.Errorf("request: %w", inner), 2); !reflect.DeepEqual(direct, wrapped) {
		t.Fatalf("direct %+v, wrapped %+v", direct, wrapped)
	}
}

func TestWrappedPlainErrorDetailsKeepTheirMessage(t *testing.T) {
	d := Details(fmt.Errorf("reading body: %w", io.ErrUnexpectedEOF), 0)
	if len(d) != 1 || d[0].Message != "reading body: unexpected EOF" {
		t.Fatalf("%+v", d)
	}
	d = Details(fmt.Errorf("outer: %w", BodyError(io.ErrUnexpectedEOF)), 0)
	if len(d) != 1 || d[0].Location != "body" || d[0].Message != "outer: body: unexpected EOF" {
		t.Fatalf("%+v", d)
	}
}

// summary renders details as location|path|constraint|message, one per detail.
func summary(ds []ErrorDetail) string {
	var out []string
	for _, d := range ds {
		out = append(out, d.Location+"|"+d.Path+"|"+d.Constraint+"|"+d.Message)
	}
	return strings.Join(out, "; ")
}

func TestWrappedJoinsKeepEveryError(t *testing.T) {
	a := func() error { return WithPath("a", problemf(ProblemType, "wrong a")) }
	b := func() error { return WithPath("b", problemf(ProblemRange, "wrong b")) }
	both := "|/a|type|wrong a; |/b|range|wrong b"
	inBody := "body|/a|type|wrong a; body|/b|range|wrong b"
	for _, c := range []struct {
		name string
		err  error
		want string
	}{
		{"wrapped join", fmt.Errorf("input: %w", errors.Join(a(), b())), both},
		{"doubly wrapped join", fmt.Errorf("outer: %w", fmt.Errorf("input: %w", errors.Join(a(), b()))), both},
		{"several %w", fmt.Errorf("input: %w and %w", a(), b()), both},
		{"wrapped MultiError", fmt.Errorf("input: %w", &MultiError{Errors: []error{a(), b()}}), both},
		{"join of wrapped errors", errors.Join(fmt.Errorf("x: %w", a()), fmt.Errorf("y: %w", b())), "|/a|type|x: /a: wrong a; |/b|range|y: /b: wrong b"},
		{"request error of a wrapped join", BodyError(fmt.Errorf("input: %w", errors.Join(a(), b()))), inBody},
		{"wrapped request error of a wrapped join", fmt.Errorf("serve: %w", BodyError(fmt.Errorf("input: %w", errors.Join(a(), b())))), inBody},
		{"path below a wrapped join", WithPath("p", fmt.Errorf("input: %w", errors.Join(a(), b()))), "|/p/a|type|wrong a; |/p/b|range|wrong b"},
		{"path below a wrapped MultiError", WithPath("p", fmt.Errorf("input: %w", &MultiError{Errors: []error{a(), b()}})), "|/p/a|type|wrong a; |/p/b|range|wrong b"},
		{"joined request errors and a wrapped plain error", fmt.Errorf("serve: %w", &MultiError{Errors: []error{
			fmt.Errorf("query: %w", ParamError("query", "q", RequiredError("absent"))),
			errors.Join(BodyError(fmt.Errorf("input: %w", errors.Join(a(), b()))), fmt.Errorf("reading body: %w", io.ErrUnexpectedEOF)),
		}}), "query||required|query: query parameter \"q\": absent; " + inBody + "; |||reading body: unexpected EOF"},
		// Text of wrappers around several problems belongs to none of them; a plain error's own wrappers are kept.
		{"plain error beside a decoding error", fmt.Errorf("outer: %w", fmt.Errorf("input: %w", errors.Join(a(), io.ErrUnexpectedEOF))), "|/a|type|wrong a; |||unexpected EOF"},
		{"wrapped plain error beside a decoding error", errors.Join(a(), fmt.Errorf("reading: %w (retry)", io.ErrUnexpectedEOF)), "|/a|type|wrong a; |||reading: unexpected EOF (retry)"},
		{"wrapped join of plain errors", fmt.Errorf("input: %w", errors.Join(io.EOF, io.ErrUnexpectedEOF)), "|||EOF; |||unexpected EOF"},
	} {
		if got := summary(Details(c.err, 0)); got != c.want {
			t.Errorf("%s:\n got %q\nwant %q", c.name, got, c.want)
		}
	}
	// Bounded like any other error tree.
	if d := Details(fmt.Errorf("input: %w", errors.Join(a(), b())), 1); len(d) != 1 || d[0].Path != "/a" {
		t.Fatalf("%+v", d)
	}
	// A path over a wrapped join applies to each of its failures.
	if f := FailedPaths(WithPath("p", fmt.Errorf("input: %w", errors.Join(a(), b())))); !reflect.DeepEqual(f, []string{"/p/a", "/p/b"}) {
		t.Fatalf("%v", f)
	}
}

func TestUnencodableHookMetadataKeepsProblemDocument(t *testing.T) {
	v := NewValidator()
	v.At("amount").AddLimit("app-rule", make(chan int), make(chan int), "cannot process this amount")
	w := httptest.NewRecorder()
	DetailedRequestErrorHandler(5)(w, httptest.NewRequest("POST", "/", nil), ValidationRequestError(v.Err()))
	var p Problem
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || len(p.Details) != 1 || p.Details[0].Path != "/amount" || p.Details[0].Constraint != "app-rule" {
		t.Fatalf("status %d, problem %s, error %v", w.Code, w.Body, err)
	}
}

func TestFirstErrorsAcceptsSliceValuedCauses(t *testing.T) {
	cause := ValidationErrors{{Path: "/name", Constraint: "custom", Message: "failed"}}
	err := &DecodeError{Err: cause}
	if got := FirstErrors(err); got != err {
		t.Fatalf("unexpected first error %v", got)
	}
}

func TestSafeIntDetailRetainsFullWidthLimit(t *testing.T) {
	v := NewValidator()
	SafeInt(v.At("n"), 1<<53)
	d := Details(v.Err(), 0)
	if len(d) != 1 || d[0].Limit != int64(1<<53-1) || d[0].Value != int64(1<<53) {
		t.Fatalf("safeint detail: %+v", d)
	}
}
