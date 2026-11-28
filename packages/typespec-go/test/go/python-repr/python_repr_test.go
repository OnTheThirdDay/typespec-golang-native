package gen

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"

	"example.com/gen/tsgo"
)

// testdata/reference.json holds [value, json.dumps(value)] pairs written by CPython (float64
// values as float.hex(), float32 values as their shortest decimal).
type reference struct {
	Python  string      `json:"python"`
	Float64 [][2]string `json:"float64"`
	Float32 [][2]string `json:"float32"`
	List    [][2]any    `json:"list"`
}

func load(t *testing.T) reference {
	t.Helper()
	b, err := os.ReadFile("testdata/reference.json")
	if err != nil {
		t.Fatal(err)
	}
	var r reference
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	if len(r.Float64) < 2000 || len(r.Float32) < 1000 {
		t.Fatalf("reference too small: %d %d", len(r.Float64), len(r.Float32))
	}
	return r
}

func TestFloat64AsPythonJSONDumps(t *testing.T) {
	r := load(t)
	failures := 0
	for _, c := range r.Float64 {
		f, err := strconv.ParseFloat(c[0], 64)
		if err != nil {
			t.Fatal(err)
		}
		got, err := F{X: f}.MarshalJSON()
		if want := `{"x":` + c[1] + `}`; err != nil || string(got) != want {
			if failures++; failures <= 10 {
				t.Errorf("%s: got %s (%v), json.dumps writes %s", c[0], got, err, c[1])
			}
		}
		// Decoding is unchanged and round-trips the value (the sign of zero included).
		var back F
		if err := json.Unmarshal(got, &back); err != nil || back.X != f || strconv.FormatFloat(back.X, 'g', -1, 64) != strconv.FormatFloat(f, 'g', -1, 64) {
			t.Errorf("%s: %v %v", got, back.X, err)
		}
	}
}

func TestFloat32AsPythonJSONDumps(t *testing.T) {
	r := load(t)
	for _, c := range r.Float32 {
		f, err := strconv.ParseFloat(c[0], 32)
		if err != nil {
			t.Fatal(err)
		}
		got, err := F32{X: float32(f)}.MarshalJSON()
		if want := `{"x":` + c[1] + `}`; err != nil || string(got) != want {
			t.Errorf("%s: got %s (%v), json.dumps writes %s", c[0], got, err, c[1])
		}
	}
}

func TestFloatsInsideContainers(t *testing.T) {
	r := load(t)
	for _, c := range r.List {
		var xs []float64
		for _, h := range c[0].([]any) {
			f, _ := strconv.ParseFloat(h.(string), 64)
			xs = append(xs, f)
		}
		got, err := L{Xs: xs}.MarshalJSON()
		if want := `{"xs":` + c[1].(string) + `}`; err != nil || string(got) != want {
			t.Errorf("got %s (%v), want %s", got, err, want)
		}
	}
	// Records, tuples and nullable values use the same codec.
	n := Nested{R: map[string]float64{"a": 1e-5, "b": 1e16}, T: NestedT{Item0: 0.0001, Item1: 1e-5}}
	zero, neg := 0.0, -1.0
	n.O = tsgo.Ptr(tsgo.Value(zero * neg)) // negative zero
	got, err := n.MarshalJSON()
	if want := `{"r":{"a":1e-05,"b":1e+16},"t":[0.0001,1e-05],"o":-0.0}`; err != nil || string(got) != want {
		t.Errorf("got %s (%v), want %s", got, err, want)
	}
}

func TestNonFiniteValuesAreRejected(t *testing.T) {
	inf, _ := strconv.ParseFloat("+Inf", 64)
	for _, f := range []float64{inf, -inf, inf - inf} {
		if b, err := (F{X: f}).MarshalJSON(); err == nil || !strings.Contains(err.Error(), "NaN and infinities") {
			t.Errorf("%v: %s %v", f, b, err)
		}
	}
}
