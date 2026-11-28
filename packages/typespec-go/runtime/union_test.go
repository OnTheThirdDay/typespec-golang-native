package tsgo

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// countingError counts how often its message is formatted.
type countingError struct{ n *int }

func (e countingError) Error() string { *e.n++; return "formatted" }

func failing(name string, err error, consts ...UnionConst) UnionVariant {
	return UnionVariant{Name: name, Kinds: []JSONKind{KindObject}, Consts: consts, Try: func([]byte) (func(), bool, error) { return nil, false, err }}
}

func TestUnionFailuresAreFormattedOnlyWhenReported(t *testing.T) {
	formatted := 0
	ok := false
	variants := []UnionVariant{
		failing("A", &DecodeError{Path: "/a", Err: countingError{&formatted}}),
		failing("B", countingError{&formatted}),
		{Name: "C", Try: func([]byte) (func(), bool, error) { return func() { ok = true }, true, nil }},
	}
	if err := DecodeUnion([]byte(`{"c":1}`), variants); err != nil || !ok || formatted != 0 {
		t.Fatalf("err %v, selected %v, formatted %d times", err, ok, formatted)
	}
}

func TestUnionErrorSelection(t *testing.T) {
	kind := func(v string) UnionConst { return UnionConst{Property: "kind", Value: v} }
	variants := []UnionVariant{
		failing("A", &DecodeError{Path: "/x", Err: errors.New("bad x")}, kind(`"a"`)),
		failing("B", &DecodeError{Path: "/kind", Err: errors.New("expected b")}, kind(`"b"`), UnionConst{Property: "v", Value: "1"}),
		failing("C", &DecodeError{Path: "/kind", Err: errors.New("expected c")}, kind(`"c"`)),
	}
	// One variant's constants match: its error, with its path.
	err := DecodeUnion([]byte(`{"kind":"a","x":true}`), variants)
	var de *DecodeError
	var ve *VariantError
	if !errors.As(err, &de) || de.Path != "/x" || !errors.As(err, &ve) || ve.Variant != "A" || err.Error() != "/x: bad x (union variant A)" {
		t.Fatalf("%v", err)
	}
	// Every constant must match (B also declares v = 1, compared as JSON numbers).
	err = DecodeUnion([]byte(`{"kind":"b","v":1.0}`), variants)
	if !errors.As(err, &ve) || ve.Variant != "B" {
		t.Fatalf("%v", err)
	}
	// Nothing matches the shared constant: reported at its path, all failures kept.
	err = DecodeUnion([]byte(`{"kind":"b","v":2}`), variants)
	var ue *UnionError
	if !errors.As(err, &de) || de.Path != "/kind" || !errors.As(err, &ue) || len(ue.Variants) != 3 || !strings.Contains(err.Error(), `"b" identifies no union variant (expected "a" or "b" or "c")`) {
		t.Fatalf("%v", err)
	}
	// Variants without constants stay candidates.
	err = DecodeUnion([]byte(`{"kind":"z"}`), append(variants, failing("D", &DecodeError{Path: "/d", Err: errors.New("missing d")})))
	if !errors.As(err, &de) || de.Path != "/d" || !errors.As(err, &ve) || ve.Variant != "D" {
		t.Fatalf("%v", err)
	}
	// Invalid JSON objects are not inspected; every failure is reported.
	err = DecodeUnion([]byte(`{"kind":`), variants)
	if !errors.As(err, &ue) || len(ue.Variants) != 3 {
		t.Fatalf("%v", err)
	}
}

func TestUnionErrorMessagesAreBounded(t *testing.T) {
	var variants []UnionVariant
	long := strings.Repeat("x", 10_000)
	for i := 0; i < 50; i++ {
		variants = append(variants, failing(fmt.Sprintf("V%d", i), &DecodeError{Path: "/p", Err: errors.New(long + "é")}))
	}
	err := DecodeUnion([]byte(`{}`), variants)
	var ue *UnionError
	if !errors.As(err, &ue) || len(ue.Variants) != 50 {
		t.Fatalf("%v", err)
	}
	msg := err.Error()
	if len(msg) > 1000 || !strings.Contains(msg, "V2: ") || strings.Contains(msg, "V3: ") || !strings.HasSuffix(msg, "; and 47 more)") {
		t.Fatalf("%d bytes: %.300s", len(msg), msg)
	}
	// Nested unions stay bounded too.
	nested := variants
	for depth := 0; depth < 5; depth++ {
		inner := nested
		nested = nil
		for i := 0; i < 4; i++ {
			nested = append(nested, UnionVariant{Name: fmt.Sprint(i), Try: func(b []byte) (func(), bool, error) { return nil, false, DecodeUnion(b, inner) }})
		}
	}
	if msg := DecodeUnion([]byte(`{}`), nested).Error(); len(msg) > 1000 {
		t.Fatalf("%d bytes", len(msg))
	}
}
