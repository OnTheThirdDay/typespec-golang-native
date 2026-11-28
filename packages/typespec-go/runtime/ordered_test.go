package tsgo

import (
	"bytes"
	"encoding/json"
	"errors"
	"slices"
	"testing"
)

// The standalone methods of OrderedMap use the runtime's default policies (those of generated
// code without serialization options); encoding/json then transforms what MarshalJSON returns.
func TestOrderedMapStandaloneEncoding(t *testing.T) {
	f := OrderedMapOf(KeyValue[float64]{"z", 1e6}, KeyValue[float64]{"a", 0.1})
	b, err := f.MarshalJSON()
	// Floats as the runtime's Float64Codec writes them (not encoding/json's form, 1000000).
	if err != nil || string(b) != `{"z":1e+06,"a":0.1}` {
		t.Fatalf("%s %v", b, err)
	}
	s := OrderedMapOf(KeyValue[string]{"<k>", "<&>"}, KeyValue[string]{"u", "\u2028"})
	direct, _ := s.MarshalJSON()
	// Keys and values follow one policy: no HTML escaping, U+2028 escaped (EscapeDefault).
	if string(direct) != `{"<k>":"<&>","u":"\u2028"}` {
		t.Fatalf("%s", direct)
	}
	// encoding/json escapes HTML characters in what MarshalJSON returns, unless told not to.
	viaMarshal, _ := json.Marshal(s)
	if string(viaMarshal) != `{"\u003ck\u003e":"\u003c\u0026\u003e","u":"\u2028"}` {
		t.Fatalf("%s", viaMarshal)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	if got := bytes.TrimSpace(buf.Bytes()); !bytes.Equal(got, direct) {
		t.Fatalf("%s", got)
	}
	// Other policies are selected per codec, never globally: the same map with minimal escaping.
	min, _ := OrderedMapCodec(MinimalStringCodec, EscapeMinimal).Encode(s)
	if string(min) != "{\"<k>\":\"<&>\",\"u\":\"\u2028\"}" {
		t.Fatalf("%s", min)
	}
	// encoding/json escapes U+2028 even then (in what MarshalJSON returns, too).
	type wrapper struct{ M OrderedMap[string] }
	w, _ := json.Marshal(wrapper{s})
	if !bytes.Contains(w, []byte(`\u2028`)) {
		t.Fatalf("%s", w)
	}
}

func TestOrderedMapStandaloneDecoding(t *testing.T) {
	var m OrderedMap[string]
	if err := json.Unmarshal([]byte(`{"b":"1","a":"2"}`), &m); err != nil || !equalKeys(m.Keys(), "b", "a") {
		t.Fatalf("%v %v", err, m.Keys())
	}
	// Values are checked by the runtime codecs, as in generated code: encoding/json would
	// replace the invalid surrogate with U+FFFD.
	var p *DecodeProblem
	if err := json.Unmarshal([]byte(`{"a":"\ud800"}`), &m); !errors.As(err, &p) || p.Kind != ProblemUnicode {
		t.Fatalf("%v", err)
	}
	var ints OrderedMap[int8]
	if err := json.Unmarshal([]byte(`{"a":1.0,"b":300}`), &ints); !errors.As(err, &p) || p.Kind != ProblemRange {
		t.Fatalf("%v", err)
	}
	if err := json.Unmarshal([]byte(`{"a":1.0}`), &ints); err != nil || mustGet(ints, "a") != 1 {
		t.Fatalf("%v", err)
	}
	// Types with their own JSON methods use them; others use encoding/json.
	var raw OrderedMap[json.RawMessage]
	if err := json.Unmarshal([]byte(`{"x":{"y":[1, 2]}}`), &raw); err != nil || string(mustGet(raw, "x")) != `{"y":[1, 2]}` {
		t.Fatalf("%v", err)
	}
	type plain struct{ N int }
	var ps OrderedMap[plain]
	if err := json.Unmarshal([]byte(`{"k":{"N":3}}`), &ps); err != nil || mustGet(ps, "k").N != 3 {
		t.Fatalf("%v", err)
	}
	if b, err := ps.MarshalJSON(); err != nil || string(b) != `{"k":{"N":3}}` {
		t.Fatalf("%s %v", b, err)
	}
	if err := json.Unmarshal([]byte(`{"k":{"N":"x"}}`), &ps); !errors.As(err, &p) || p.Kind != ProblemType {
		t.Fatalf("%v", err)
	}
}

func equalKeys(got []string, want ...string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func mustGet[T any](m OrderedMap[T], k string) T {
	v, _ := m.Get(k)
	return v
}

func TestOrderedMapAssignmentSharesKeysAndValues(t *testing.T) {
	original := OrderedMapOf(KeyValue[int32]{"a", 1}, KeyValue[int32]{"b", 2})
	copy := original
	copy.Delete("a")
	original.Set("c", 3)
	copy.Set("c", 4)
	for _, m := range []OrderedMap[int32]{original, copy} {
		b, err := m.MarshalJSON()
		if err != nil || string(b) != `{"b":2,"c":4}` || m.Len() != 2 {
			t.Fatalf("keys %q, JSON %s, error %v", m.Keys(), b, err)
		}
	}
}

func FuzzOrderedMapCopies(f *testing.F) {
	f.Add([]byte{3, 7, 0, 2, 6, 1, 3})
	f.Fuzz(func(t *testing.T, changes []byte) {
		base := OrderedMapOf(KeyValue[int32]{"a", 0})
		handles := [2]OrderedMap[int32]{base, base}
		keys := []string{"a"}
		values := map[string]int32{"a": 0}
		for i, op := range changes {
			handle := &handles[op&1]
			key := string(rune('a' + op>>2))
			if op&2 != 0 {
				if _, ok := values[key]; !ok {
					keys = append(keys, key)
				}
				handle.Set(key, int32(i))
				values[key] = int32(i)
			} else {
				handle.Delete(key)
				delete(values, key)
				keys = slices.DeleteFunc(keys, func(k string) bool { return k == key })
			}
		}
		for _, m := range handles {
			if !slices.Equal(m.Keys(), keys) {
				t.Fatalf("keys %q, want %q", m.Keys(), keys)
			}
			for k, v := range m.All() {
				if want, ok := values[k]; !ok || want != v {
					t.Fatalf("key %q has %d, want %d (present %v)", k, v, want, ok)
				}
			}
		}
	})
}

func TestOrderedMapsPreserveNestedPartialValuesAndNilMarshalers(t *testing.T) {
	var decoded OrderedMap[OrderedMap[string]]
	err := json.Unmarshal([]byte(`{"outer":{"good":"yes","bad":false}}`), &decoded)
	partial, ok := Partial[OrderedMap[OrderedMap[string]]](err)
	if !ok || mustGet(mustGet(partial, "outer"), "good") != "yes" || decoded.Len() != 0 || !slices.Equal(FailedPaths(err), []string{"/outer/bad"}) {
		t.Fatalf("partial %v, failed paths %v, error %v", partial.Keys(), FailedPaths(err), err)
	}
	m := OrderedMapOf(KeyValue[*Date]{"empty", nil})
	b, err := m.MarshalJSON()
	if err != nil || string(b) != `{"empty":null}` {
		t.Fatalf("%s %v", b, err)
	}
}
