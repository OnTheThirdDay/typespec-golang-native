package tsgo

import (
	"math/big"
	"strings"
	"testing"
	"time"
)

func TestSameNumberTextIsExact(t *testing.T) {
	same := [][2]string{
		{"1", "1.0"}, {"1", "1e0"}, {"100", "1e2"}, {"0.1", "1e-1"}, {"0", "-0"}, {"0", "0.000e5"},
		{"9007199254740993", "9007199254740993.000"}, {"1.10", "1.1"}, {"-2.5", "-25e-1"}, {"123", "+123"},
	}
	for _, c := range same {
		if !SameNumberText(c[0], c[1]) {
			t.Errorf("%s != %s", c[0], c[1])
		}
	}
	different := [][2]string{
		{"1", "-1"}, {"0.1", "0.10000000000000000001"}, {"9007199254740993", "9007199254740992"},
		{"1.1", "1.10000000000000000001"}, {"1e2", "1e3"}, {"1", "x"}, {"1", ""}, {"1e", "1"}, {"1e99999999999999999999", "1"},
	}
	for _, c := range different {
		if SameNumberText(c[0], c[1]) {
			t.Errorf("%s == %s", c[0], c[1])
		}
	}
}

func TestExactNumbersAreBoundedNotApproximated(t *testing.T) {
	ok := map[string]string{"1e2": "100", "100e-2": "1", "15e-1": "", "123456789012345678901234567890": "123456789012345678901234567890"}
	for in, want := range ok {
		n, err := IntegerCodec.Decode([]byte(in))
		if want == "" {
			if err == nil {
				t.Errorf("%s accepted as integer", in)
			}
			continue
		}
		if err != nil || n.String() != want {
			t.Errorf("%s: %v %v", in, n, err)
		}
	}
	for _, in := range []string{"1e10001", "1e-10001", strings.Repeat("7", MaxExactDigits+1)} {
		if _, err := IntegerCodec.Decode([]byte(in)); err == nil {
			t.Errorf("integer %.20s… accepted beyond the exact bounds", in)
		}
		if _, err := DecimalCodec.Decode([]byte(in)); err == nil {
			t.Errorf("decimal %.20s… accepted beyond the exact bounds", in)
		}
	}
	// At the bounds the value is exact.
	d, err := DecimalCodec.Decode([]byte("1e10000"))
	if err != nil || d.Rat().Num().String() != "1"+strings.Repeat("0", 10000) {
		t.Fatalf("1e10000: %v", err)
	}
	// A long spelling with a large exponent but a moderate value is converted from its
	// canonical form, not by raising 10 to the spelled exponent.
	tiny := "0." + strings.Repeat("0", 20000) + "1e20002"
	if r, ok := exactRat(tiny); !ok || r.String() != "10/1" {
		t.Fatalf("%v %v", r, ok)
	}
}

// Regression: math/big parsed 1e1000000 in ~20 ms, so a 1 MB array of such tokens cost minutes
// of CPU. Bounded parsing rejects each token in constant time.
func TestHugeExponentsAreRejectedCheaply(t *testing.T) {
	body := "[" + strings.Repeat("1e1000000,", 20000) + "1]"
	start := time.Now()
	if _, err := ArrayCodec(IntCodec[int64]()).Decode([]byte(body)); err == nil {
		t.Fatal("accepted")
	}
	if _, err := ArrayCodec(IntegerCodec).Decode([]byte(body)); err == nil {
		t.Fatal("accepted")
	}
	if _, err := ArrayCodec(DecimalCodec).Decode([]byte(body)); err == nil {
		t.Fatal("accepted")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("rejecting huge exponents took %v", elapsed)
	}
	if SameNumberText("1e1000000", "1e1000001") {
		t.Fatal("different exponents compared equal")
	}
}

func TestDecimal128Boundaries(t *testing.T) {
	for _, tc := range []struct {
		value string
		valid bool
	}{
		{"9.999999999999999999999999999999999e6144", true}, {"1e6145", false},
		{"-1e-6176", true}, {"1.1e-6176", false}, {"9e-6177", false},
		{"10000000000000000000000000000000000", true}, {"10000000000000000000000000000000001", false},
		{"-0e9000", true},
	} {
		v := NewValidator()
		Decimal128(v, MustDecimal(tc.value))
		if (v.Err() == nil) != tc.valid {
			t.Errorf("%s: %v", tc.value, v.Err())
		}
	}
}

func FuzzDecimalEquivalence(f *testing.F) {
	for _, s := range []string{"-0", "1.000", "9.9e-31", "12345678901234567890", "1e6145"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		if len(s) > 120 {
			return
		}
		d, err := ParseDecimal(s)
		if err != nil {
			return
		}
		r, ok := new(big.Rat).SetString(s)
		if !ok || d.Rat().Cmp(r) != 0 {
			t.Fatalf("inexact decimal %q", s)
		}
	})
}
