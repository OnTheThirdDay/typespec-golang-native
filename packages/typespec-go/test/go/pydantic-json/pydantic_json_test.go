package gen

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"
)

type reference struct {
	Float64 [][2]string `json:"float64"`
	Float32 [][2]string `json:"float32"`
	Strings [][2]string `json:"strings"`
	Keys    [][2]string `json:"keys"`
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
	return r
}

func check(t *testing.T, v json.Marshaler, want string) {
	t.Helper()
	got, err := v.MarshalJSON()
	if err != nil || string(got) != want {
		t.Errorf("got %s (%v), Pydantic writes %s", got, err, want)
	}
}

func TestFloatsAsPydantic(t *testing.T) {
	r := load(t)
	for _, c := range r.Float64 {
		f, err := strconv.ParseFloat(c[0], 64)
		if err != nil {
			t.Fatal(err)
		}
		check(t, F{X: f}, c[1])
		// Decoding is unchanged and round-trips the value.
		var back F
		if err := json.Unmarshal([]byte(c[1]), &back); err != nil || back.X != f {
			t.Errorf("%s: %v %v", c[1], back.X, err)
		}
	}
	for _, c := range r.Float32 {
		f, err := strconv.ParseFloat(c[0], 32)
		if err != nil {
			t.Fatal(err)
		}
		check(t, F32{X: float32(f)}, c[1])
	}
}

func TestStringsAsPydantic(t *testing.T) {
	r := load(t)
	for _, c := range r.Strings {
		check(t, S{S: c[0]}, c[1])
		var back S
		if err := json.Unmarshal([]byte(c[1]), &back); err != nil || back.S != c[0] {
			t.Errorf("%s: %q %v", c[1], back.S, err)
		}
	}
	for _, c := range r.Keys {
		check(t, R{M: map[string]string{c[0]: c[0]}}, c[1])
	}
}
