package gen

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"example.com/gen/tsgo"
)

const holderJSON = `{
  "nested": [{"v": 1}, "5", 5, null],
  "maybe": {"label": "ab", "kids": [{"label": "cd", "kids": [{"v": 2}, "x"]}]},
  "map": {"a": null, "b": {"v": 3}, "c": "t"},
  "big": 9223372036854775807,
  "ubig": 18446744073709551615,
  "exact": 0.1000000000000000000000000001,
  "f32": 0.1,
  "small": 2,
  "ratio": 0.2,
  "sc": "abcde",
  "narrower": "abc",
  "nullableDefault": null
}`

func decode(t *testing.T, s string) Holder {
	t.Helper()
	var h Holder
	if err := json.Unmarshal([]byte(s), &h); err != nil {
		t.Fatal(err)
	}
	return h
}

func TestNumericPrecisionAndRange(t *testing.T) {
	h := decode(t, holderJSON)
	if h.Big != 1<<63-1 || h.Ubig != 1<<64-1 || h.Exact.String() != "0.1000000000000000000000000001" {
		t.Fatalf("precision lost: %v %v %v", h.Big, h.Ubig, h.Exact)
	}
	out, _ := json.Marshal(h)
	for _, want := range []string{`"big":9223372036854775807`, `"ubig":18446744073709551615`, `"exact":0.1000000000000000000000000001`, `"f32":0.1`} {
		if !strings.Contains(string(out), want) {
			t.Errorf("%s not in %s", want, out)
		}
	}
	for _, bad := range []string{`"big": 9223372036854775808`, `"ubig": -1`, `"f32": 3.5e38`, `"small": 1.5`, `"exact": "0.1"`} {
		var x Holder
		in := strings.Replace(holderJSON, strings.SplitN(bad, ":", 2)[0]+`: `+valueOf(holderJSON, strings.SplitN(bad, ":", 2)[0]), bad, 1)
		if err := json.Unmarshal([]byte(in), &x); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}

// valueOf returns the original text of a top-level scalar property in holderJSON.
func valueOf(doc, key string) string {
	i := strings.Index(doc, key+": ")
	rest := doc[i+len(key)+2:]
	return rest[:strings.IndexAny(rest, ",\n")]
}

func TestBoundsAndInheritedConstraints(t *testing.T) {
	cases := map[string]string{
		`"small": 2`:        `"small": 3`,           // exclusive maximum 3
		`"small": 2,`:       `"small": -2,`,         // exclusive minimum -2
		`"ratio": 0.2`:      `"ratio": 0.1`,         // exclusive minimum 0.1
		`"ratio": 0.2,`:     `"ratio": 0.30000001,`, // maximum 0.3
		`"sc": "abcde"`:     `"sc": "abcdef"`,       // maxLength 5 from base scalar Code
		`"sc": "abcde",`:    `"sc": "a",`,           // minLength 2 from ShortCode
		`"narrower": "abc"`: `"narrower": "abcd"`,   // property maxLength 3 narrows the scalar
	}
	for from, to := range cases {
		h := decode(t, strings.Replace(holderJSON, from, to, 1))
		if err := h.Validate(); err == nil {
			t.Errorf("%s: validation passed", to)
		}
	}
	h := decode(t, holderJSON)
	if err := h.Validate(); err != nil {
		t.Fatal(err)
	}
	si := SmallInt(-6)
	h.Si = &si
	var ves tsgo.ValidationErrors
	if err := h.Validate(); !errors.As(err, &ves) || ves[0].Path != "/si" || ves[0].Constraint != "minimum" {
		t.Fatalf("scalar constraint on optional property: %v", err)
	}
	// deep recursive path
	h = decode(t, strings.Replace(holderJSON, `"label": "cd"`, `"label": "c"`, 1))
	if err := h.Validate(); !errors.As(err, &ves) || ves[0].Path != "/maybe/kids/0/label" {
		t.Fatalf("recursive path: %v", err)
	}
	var d Derived
	_ = json.Unmarshal([]byte(`{"id":"ab","id2":"abcde"}`), &d)
	if err := d.Validate(); !errors.As(err, &ves) || len(ves) != 2 {
		t.Fatalf("inherited property constraints: %v", err)
	}
}

func TestNestedAndRecursiveUnions(t *testing.T) {
	h := decode(t, holderJSON)
	if l, ok := h.Nested[0].MustGet().AsLeaf(); !ok || l.V != 1 {
		t.Fatal("leaf")
	}
	if s, ok := h.Nested[1].MustGet().AsString(); !ok || s != "5" {
		t.Fatal(`"5" must stay a string`)
	}
	if n, ok := h.Nested[2].MustGet().AsInt64(); !ok || n != 5 {
		t.Fatal("5 must be the int64 variant")
	}
	if !h.Nested[3].IsNull() {
		t.Fatal("null element")
	}
	tree, _ := h.Maybe.MustGet().AsTree()
	inner, _ := (*tree.Kids)[0].AsTree()
	if leaf, ok := (*inner.Kids)[0].AsLeaf(); !ok || leaf.V != 2 {
		t.Fatal("recursion through union")
	}
	if !h.Map["a"].IsNull() || h.Map["c"].MustGet().Kind() != NodeKindText {
		t.Fatal("record of nullable unions")
	}
	out, _ := json.Marshal(h)
	again := decode(t, string(out))
	out2, _ := json.Marshal(again)
	if !bytes.Equal(out, out2) {
		t.Fatalf("not stable:\n%s\n%s", out, out2)
	}
	// Overlapping object variants: {"label":"ab","v":1} is represented exactly by neither Tree nor
	// Leaf, so the documented policy selects the first variant that decodes and validates (Tree).
	// "v" is then an undeclared property of Tree: ignored under the default unknown-properties
	// policy, exactly as for a plain Tree value (use unknown-properties: reject to refuse it).
	var n Node
	if err := json.Unmarshal([]byte(`{"label":"ab","v":1}`), &n); err != nil || n.Kind() != NodeKindTree {
		t.Fatalf("overlap policy: %v %v", n.Kind(), err)
	}
	if wire, err := json.Marshal(n); err != nil || string(wire) != `{"label":"ab"}` {
		t.Fatalf("overlap: %s, %v", wire, err)
	}
	var plain Tree
	if err := json.Unmarshal([]byte(`{"label":"ab","v":1}`), &plain); err != nil {
		t.Fatal(err)
	}
	if wire, _ := json.Marshal(plain); string(wire) != `{"label":"ab"}` {
		t.Fatalf("union variant and plain model disagree: %s", wire)
	}
	// Exact-match preference: {"v":1} must not become a Tree with a missing label.
	if err := json.Unmarshal([]byte(`{"v":1}`), &n); err != nil || n.Kind() != NodeKindLeaf {
		t.Fatal("leaf object")
	}
}

func TestOptionalNullableTriState(t *testing.T) {
	abs := decode(t, strings.Replace(holderJSON, `"maybe": {"label": "ab", "kids": [{"label": "cd", "kids": [{"v": 2}, "x"]}]},`, "", 1))
	null := decode(t, strings.Replace(holderJSON, `"maybe": {"label": "ab", "kids": [{"label": "cd", "kids": [{"v": 2}, "x"]}]},`, `"maybe": null,`, 1))
	if abs.Maybe != nil || null.Maybe == nil || !null.Maybe.IsNull() {
		t.Fatal("absent vs null")
	}
	a, _ := json.Marshal(abs)
	b, _ := json.Marshal(null)
	if strings.Contains(string(a), `"maybe"`) || !strings.Contains(string(b), `"maybe":null`) {
		t.Fatalf("tri-state not preserved: %s / %s", a, b)
	}
}

func TestDefaults(t *testing.T) {
	h := decode(t, holderJSON)
	h.ApplyDefaults()
	if h.WithDefault == nil || h.WithDefault.Label != "dd" {
		t.Fatal("object default")
	}
	if !h.NullableDefault.IsNull() {
		t.Fatal("explicit null must not be replaced by the default")
	}
	h2 := decode(t, holderJSON)
	h2.ApplyDefaults()
	(*h.KidsDefault)[0].V = 99
	if (*h2.KidsDefault)[0].V != 1 {
		t.Fatal("mutable default shared between values")
	}
	abs := decode(t, strings.Replace(holderJSON, `,
  "nullableDefault": null`, "", 1))
	abs.ApplyDefaults()
	if v, ok := abs.NullableDefault.Get(); !ok || v != "x" {
		t.Fatal("absent nullable default")
	}
}

func TestMalformedInput(t *testing.T) {
	inputs := []string{"", "{", `{"nested": [}`, `[]`, `null`, `{"nested": {}}`, `{"big": 1}` + "x", strings.Repeat("[", 100000)}
	for _, in := range inputs {
		var h Holder
		if err := json.Unmarshal([]byte(in), &h); err == nil {
			t.Errorf("%.20q accepted", in)
		}
	}
	var n Node
	deep := strings.Repeat(`{"label":"ab","kids":[`, 2000) + `"x"` + strings.Repeat(`]}`, 2000)
	if err := json.Unmarshal([]byte(deep), &n); err != nil {
		t.Fatalf("deep but valid recursion: %v", err)
	}
}

type impl struct{}

func (impl) RoundTrip(ctx context.Context, r RoundTripRequestObject) (RoundTripResponseObject, error) {
	return RoundTrip200JSONResponse{Body: r.Body}, nil
}

var slowCancelled = make(chan struct{}, 1)

func (impl) Slow(ctx context.Context, r SlowRequestObject) (SlowResponseObject, error) {
	select {
	case <-ctx.Done():
		slowCancelled <- struct{}{}
		return nil, ctx.Err()
	case <-time.After(10 * time.Second):
		return Slow204Response{}, nil
	}
}

func (impl) Derived(ctx context.Context, r DerivedRequestObject) (DerivedResponseObject, error) {
	return Derived204Response{}, nil
}

func TestConcurrentRequests(t *testing.T) {
	ts := httptest.NewServer(NewHandler(impl{}, ServerOptions{ValidateResponses: true}))
	defer ts.Close()
	var wg sync.WaitGroup
	errs := make(chan error, 200)
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body := strings.Replace(holderJSON, `"sc": "abcde"`, fmt.Sprintf(`"sc": "c%03d"`, i), 1)
			res, err := http.Post(ts.URL+"/combo", "application/json", strings.NewReader(body))
			if err != nil {
				errs <- err
				return
			}
			b, _ := io.ReadAll(res.Body)
			res.Body.Close()
			if res.StatusCode != 200 || !strings.Contains(string(b), fmt.Sprintf(`"sc":"c%03d"`, i)) {
				errs <- fmt.Errorf("%d: %d %s", i, res.StatusCode, b)
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

func TestCancellation(t *testing.T) {
	ts := httptest.NewServer(NewHandler(impl{}, ServerOptions{}))
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", ts.URL+"/slow", nil)
	if _, err := http.DefaultClient.Do(req); err == nil {
		t.Fatal("expected client timeout")
	}
	select {
	case <-slowCancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("handler context was not cancelled when the client went away")
	}
}

func FuzzHolderDecode(f *testing.F) {
	f.Add([]byte(holderJSON))
	f.Add([]byte(`{"nested":[],"map":{},"big":0,"ubig":0,"exact":0,"f32":0,"small":0,"ratio":0.2,"sc":"ab","narrower":"ab"}`))
	f.Fuzz(func(t *testing.T, data []byte) {
		var h Holder
		if err := json.Unmarshal(data, &h); err != nil {
			return
		}
		out, err := json.Marshal(h)
		if err != nil {
			t.Fatalf("decoded value does not encode: %v", err)
		}
		var h2 Holder
		if err := json.Unmarshal(out, &h2); err != nil {
			t.Fatalf("re-decoding %s: %v", out, err)
		}
		out2, _ := json.Marshal(h2)
		if !bytes.Equal(out, out2) {
			t.Fatalf("encoding not canonical:\n%s\n%s", out, out2)
		}
		_ = h.Validate()
	})
}
