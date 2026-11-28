package gen

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

// Finding 4: the variant whose re-encoding equals the input (including nested properties) wins.
func TestOverlapSelectsVariantThatKeepsNestedFields(t *testing.T) {
	var o Overlap
	in := `{"o":{"x":"a","y":5}}`
	if err := json.Unmarshal([]byte(in), &o); err != nil {
		t.Fatal(err)
	}
	if o.Kind() != OverlapKindWide {
		t.Fatalf("selected %v, nested y would be discarded", o.Kind())
	}
	w, _ := o.AsWide()
	if w.O.Y != 5 {
		t.Fatalf("decoded %+v", w)
	}
	out, err := json.Marshal(o)
	if err != nil || string(out) != in {
		t.Fatalf("%s %v", out, err)
	}
	// Input that only the narrow variant represents exactly keeps selecting it.
	if err := json.Unmarshal([]byte(`{"o":{"x":"a"}}`), &o); err != nil || o.Kind() != OverlapKindNarrow {
		t.Fatalf("%v %v", o.Kind(), err)
	}
}

// Defaults applied to a decoded union variant must be serialized, not rejected or dropped. The
// undeclared "extra" property makes the input inexact for every variant (ignored by policy).
func TestUnionDefaultsRoundTrip(t *testing.T) {
	var d Defaulted
	if err := json.Unmarshal([]byte(`{"label":"l","extra":1}`), &d); err != nil {
		t.Fatal(err)
	}
	d.ApplyDefaults()
	out, err := json.Marshal(d)
	if err != nil || string(out) != `{"label":"l","size":7}` {
		t.Fatalf("%s %v", out, err)
	}
}

type echoServer struct{}

func (echoServer) Echo(_ context.Context, r EchoRequestObject) (EchoResponseObject, error) {
	return Echo200JSONResponse{Body: r.Body}, nil
}

func (echoServer) Big(_ context.Context, r BigRequestObject) (BigResponseObject, error) {
	var b Big
	b.ApplyDefaults()
	return Big200JSONResponse{Body: b, Q: *r.Q}, nil
}

// End to end: the server applies defaults to the union body and echoes it on the wire.
func TestEchoUnionWithDefaults(t *testing.T) {
	h := NewHandler(echoServer{}, ServerOptions{ValidateResponses: true})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/echo", strings.NewReader(`{"overlap":{"o":{"x":"a","y":1}},"defaulted":{"label":"l","extra":true}}`))
	r.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, r)
	if w.Code != 200 || w.Body.String() != `{"overlap":{"o":{"x":"a","y":1}},"defaulted":{"label":"l","size":7}}` {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}

// Finding 3: defaults keep every digit, on the wire and in the decoded Go values.
func TestLargeDefaultsAreExact(t *testing.T) {
	var b Big
	b.ApplyDefaults()
	if *b.I64 != 9007199254740993 || *b.U64 != 18446744073709551615 || *b.Neg != -9223372036854775808 || (*b.List)[0] != 9007199254740999 || *b.AsText != 9007199254740995 {
		t.Fatalf("%d %d %d %v %d", *b.I64, *b.U64, *b.Neg, *b.List, *b.AsText)
	}
	if got := b.Amount.String(); got != "0.10000000000000000000000000001" {
		t.Fatalf("decimal default %s", got)
	}
	h := NewHandler(echoServer{}, ServerOptions{ValidateResponses: true})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/big", nil))
	body, _ := io.ReadAll(w.Body)
	want := `{"i64":9007199254740993,"u64":18446744073709551615,"neg":-9223372036854775808,"amount":0.10000000000000000000000000001,"list":[9007199254740999],"asText":"9007199254740995"}`
	if w.Code != 200 || string(body) != want || w.Header().Get("x-q") != "9007199254740993" {
		t.Fatalf("%d %s %q", w.Code, body, w.Header().Get("x-q"))
	}
	// The query bound is exact as well: 2^53 (one below the bound) is rejected.
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/big?q=9007199254740992", nil))
	if w.Code != 400 {
		t.Fatalf("bound not exact: %d %s", w.Code, w.Body)
	}
}

// Patterns match code points (Unicode mode), as JSON Schema validators and Pydantic do.
func TestPatternsMatchCodePoints(t *testing.T) {
	ok := func(p Patterns) bool { return p.Validate() == nil }
	s := func(v string) *string { return &v }
	cases := []struct {
		p    Patterns
		want bool
	}{
		{Patterns{One: s("😀")}, true},
		{Patterns{One: s("ab")}, false},
		{Patterns{Backspace: s("\b")}, true},
		{Patterns{Backspace: s(`\`)}, false},
		{Patterns{Backspace: s("x")}, false},
		{Patterns{Upper: s("ÄB")}, true},
		{Patterns{Upper: s("aB")}, false},
		{Patterns{Pair: s("😀")}, true},
		{Patterns{Range: s("😁")}, true},
		{Patterns{Range: s("😃")}, false},
	}
	for i, c := range cases {
		if ok(c.p) != c.want {
			t.Errorf("case %d: valid=%v, want %v", i, ok(c.p), c.want)
		}
	}
}

func (echoServer) Choice(_ context.Context, r ChoiceRequestObject) (ChoiceResponseObject, error) {
	return Choice200JSONResponse{Body: r.Body}, nil
}

func (echoServer) NegotiateJSON(context.Context, NegotiateJSONRequestObject) (NegotiateJSONResponseObject, error) {
	return NegotiateJSON200JSONResponse{Body: Choice{M: NewMixedYes("ok")}}, nil
}

func (echoServer) NegotiateText(context.Context, NegotiateTextRequestObject) (NegotiateTextResponseObject, error) {
	return NegotiateText200TextResponse{Body: "text"}, nil
}

func TestMixedEnumIsClosed(t *testing.T) {
	for in, ok := range map[string]bool{`{"m":"ok"}`: true, `{"m":1}`: true, `{"m":"no"}`: false, `{"m":2}`: false, `{"m":"1"}`: false, `{"m":1.0}`: true} {
		var c Choice
		err := json.Unmarshal([]byte(in), &c)
		if err == nil {
			err = c.Validate()
		}
		if (err == nil) != ok {
			t.Errorf("%s: %v", in, err)
		}
	}
	var c Choice
	_ = json.Unmarshal([]byte(`{"m":1}`), &c)
	if out, _ := json.Marshal(c); string(out) != `{"m":1}` {
		t.Fatalf("%s", out)
	}
}

func TestAcceptQualityAndMalformedQuery(t *testing.T) {
	h := NewHandler(echoServer{}, ServerOptions{})
	for accept, want := range map[string]string{
		"text/plain;q=0.5, application/json": "application/json",
		"application/json;q=0.1, text/plain": "text/plain",
		"*/*;q=0.9, text/plain;q=0":          "application/json",
		"":                                   "application/json",
	} {
		r := httptest.NewRequest("GET", "/negotiate", nil)
		if accept != "" {
			r.Header.Set("Accept", accept)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if got := w.Header().Get("Content-Type"); w.Code != 200 || !strings.HasPrefix(got, want) {
			t.Errorf("Accept %q: %d %q, want %s", accept, w.Code, got, want)
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/big?q=%zz", nil))
	if w.Code != 400 {
		t.Fatalf("malformed query: %d %s", w.Code, w.Body)
	}
}

// A literal variant constructed with another value is reported by Validate.
func TestMixedEnumConstructorIsValidated(t *testing.T) {
	if err := (Choice{M: NewMixedYes("bogus")}).Validate(); err == nil {
		t.Fatal("literal variant with a different value validated")
	}
	if err := (Choice{M: NewMixedN(1)}).Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestFloatRangeIsNotSilentlyChanged(t *testing.T) {
	for in, ok := range map[string]bool{
		`{"f":0,"g":0}`:          true,
		`{"f":0e5,"g":-0.0}`:     true,
		`{"f":1e-300,"g":1e-30}`: true,
		`{"f":1e-400,"g":0}`:     false, // underflows float64
		`{"f":0,"g":1e-50}`:      false, // underflows float32
		`{"f":1e400,"g":0}`:      false,
		`{"f":0,"g":1e39}`:       false,
	} {
		var v Floats
		if err := json.Unmarshal([]byte(in), &v); (err == nil) != ok {
			t.Errorf("%s: %v", in, err)
		}
	}
}

func TestUnicodePropertyPredicatesAndEmptyEnum(t *testing.T) {
	for _, tc := range []struct {
		s  string
		ok bool
	}{{"Ω", true}, {"αβ", true}, {"Α1", false}, {"A", false}} {
		x := ScriptFields{Greek: tc.s, Any: " \n🙂", Foreign: "🙂α"}
		if (x.Validate() == nil) != tc.ok {
			t.Errorf("Greek script extensions %q: %v", tc.s, x.Validate())
		}
	}
	var empty Empty
	if empty.Valid() || empty.Validate() == nil || json.Unmarshal([]byte(`""`), &empty) == nil {
		t.Fatal("empty enum accepted a value")
	}
}

func TestFractionalMembershipBeforeRounding(t *testing.T) {
	for _, input := range []string{`{"fraction":0.30000000000000001,"point":0.3}`, `{"fraction":0.2,"point":0.299999999999999999}`} {
		var v Precise
		if err := json.Unmarshal([]byte(input), &v); err == nil {
			t.Fatal(input)
		}
	}
	var v Precise
	if err := json.Unmarshal([]byte(`{"fraction":2e-1,"point":0.300}`), &v); err != nil {
		t.Fatal(err)
	}
}

func (echoServer) LiteralQuery(context.Context, LiteralQueryRequestObject) (LiteralQueryResponseObject, error) {
	return LiteralQuery204Response{}, nil
}

func TestFloatLiteralsAreExactEverywhere(t *testing.T) {
	for in, ok := range map[string]bool{
		`{"pair":0.5,"mixed":0.7}`:                    true,
		`{"pair":1.50,"mixed":"x"}`:                   true,
		`{"pair":5e-1,"mixed":7e-1}`:                  true,
		`{"pair":0.50000000000000000001,"mixed":0.7}`: false,
		`{"pair":0.5,"mixed":0.70000000000000000001}`: false, // not the literal, and not a string
	} {
		var v MoreLiterals
		err := json.Unmarshal([]byte(in), &v)
		if err == nil {
			err = v.Validate()
		}
		if (err == nil) != ok {
			t.Errorf("%s: %v", in, err)
		}
	}
	h := NewHandler(echoServer{}, ServerOptions{})
	for q, want := range map[string]int{"0.25": 204, "0.250": 204, "25e-2": 204, "0.25000000000000000001": 400, "0.26": 400} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "/literal?q="+q, nil))
		if w.Code != want {
			t.Errorf("q=%s: %d %s", q, w.Code, w.Body)
		}
	}
}
