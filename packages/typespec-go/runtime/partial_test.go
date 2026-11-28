package tsgo

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestFailedPositionsFollowTheValues(t *testing.T) {
	// An array of records whose item 1 fails in one entry: the failed position is that entry.
	c := ArrayCodec(MapCodec(IntCodec[int32]()))
	v, err := c.Decode([]byte(`[{"a":1},{"a":2,"b":"x"},{"c":3}]`))
	if err == nil || len(v) != 3 || v[1]["a"] != 2 || v[2]["c"] != 3 {
		t.Fatalf("%v %v", v, err)
	}
	if got := FailedPaths(WithPath("r", err)); !slices.Equal(got, []string{"/r/1/b"}) {
		t.Fatal(got)
	}
	// A value of another JSON type fails as a whole.
	_, err = c.Decode([]byte(`[{"a":1},"no"]`))
	if got := FailedPaths(err); !slices.Equal(got, []string{"/1"}) {
		t.Fatal(got)
	}
	// A failure without a partial value at a generated type's boundary is the whole value, even
	// when its path is deeper (a discriminator inside the value).
	whole := wholeFailure(WithPath("kind", problemf(ProblemRequired, "discriminator property is missing")))
	if got := FailedPaths(WithPath("x", whole)); !slices.Equal(got, []string{"/x"}) {
		t.Fatal(got)
	}
	// Truncated collections fail as a whole: their later elements were not decoded.
	many := "[" + strings.TrimSuffix(strings.Repeat(`"s",`, MaxCollectedErrors+5), ",") + "]"
	_, err = ArrayCodec(IntCodec[int8]()).Decode([]byte(many))
	if got := FailedPaths(err); !slices.Equal(got, []string{""}) {
		t.Fatal(got)
	}
}

func TestValidationSkipsFailedPositions(t *testing.T) {
	v := newDecodedValidator([]string{"/a", "/b/0/c"}, "")
	MinLength(v.At("a"), "", 1)               // failed: skipped
	MinLength(v.At("a").At("x"), "", 1)       // below a failed position: skipped
	MinLength(v.At("b").At(0).At("d"), "", 1) // sibling of a failed position: checked
	MinItems(v.At("b"), []int{}, 1)           // above a failed position: checked
	if got := v.Err().(ValidationErrors); len(got) != 2 || got[0].Path != "/b/0/d" || got[1].Path != "/b" {
		t.Fatalf("%v", got)
	}
	if v.At("b").RunExtensions() || v.At("b").At(0).RunExtensions() || !v.At("b").At(1).RunExtensions() || !NewValidator().RunExtensions() {
		t.Fatal("extensions must run only on values that decoded completely")
	}
	if NewConstraintValidator().RunExtensions() {
		t.Fatal("extensions must not run while selecting a union variant")
	}
}

func TestRequestFailures(t *testing.T) {
	var f RequestFailures
	if f.Stop(errors.New("x"), "query:a", false) != true || f.Failed() {
		t.Fatal("fail-fast must stop and record nothing")
	}
	f.Stop(ParamError("query", "a", errors.New("bad")), "query:a", true)
	_, derr := ArrayCodec(StringCodec).Decode([]byte(`["ok",1]`))
	f.Stop(DecodedBodyError(derr), "body", true)
	err := f.Err(func(v *Validator) {
		MinLength(v.At("query:a"), "", 1)      // the parameter failed: skipped
		MinLength(v.At("body").At(1), "", 1)   // failed item: skipped
		MinLength(v.At("body").At(0), "ok", 3) // decoded item: checked
	})
	var re *RequestError
	if !errors.As(err, &re) || re.Name != "a" || len(Details(err, 0)) != 3 || Details(err, 0)[2].Path != "/body/0" {
		t.Fatalf("%v %+v", err, Details(err, 0))
	}
}
