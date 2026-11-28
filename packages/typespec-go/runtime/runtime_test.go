package tsgo

import (
	"encoding/json"
	"errors"
	"math"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestIntCodec(t *testing.T) {
	c := IntCodec[int8]()
	for in, want := range map[string]int8{"1": 1, "-128": -128, "127": 127, "1.0": 1, "1e2": 100, "-0": 0} {
		got, err := c.Decode([]byte(in))
		if err != nil || got != want {
			t.Errorf("Decode(%s) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, in := range []string{"128", "-129", "1.5", `"1"`, "null", "true", "1e400"} {
		if _, err := c.Decode([]byte(in)); err == nil {
			t.Errorf("Decode(%s) succeeded", in)
		}
	}
	u := IntCodec[uint64]()
	if v, err := u.Decode([]byte("18446744073709551615")); err != nil || v != math.MaxUint64 {
		t.Fatalf("uint64 max: %v %v", v, err)
	}
	if _, err := u.Decode([]byte("-1")); err == nil {
		t.Fatal("negative uint accepted")
	}
}

func TestStringAndNull(t *testing.T) {
	if _, err := StringCodec.Decode([]byte("null")); err == nil {
		t.Fatal("null accepted as string")
	}
	b, _ := StringCodec.Encode("<a&b>")
	if string(b) != `"<a&b>"` {
		t.Fatalf("HTML escaping applied: %s", b)
	}
	n := NullableCodec(StringCodec)
	v, err := n.Decode([]byte("null"))
	if err != nil || !v.IsNull() {
		t.Fatal("null not decoded as Null")
	}
	v, _ = n.Decode([]byte(`"x"`))
	if x, ok := v.Get(); !ok || x != "x" {
		t.Fatal("value not decoded")
	}
}

func TestArrayAndMap(t *testing.T) {
	a := ArrayCodec(IntCodec[int32]())
	b, _ := a.Encode(nil)
	if string(b) != "[]" {
		t.Fatalf("nil slice encoded as %s", b)
	}
	_, err := a.Decode([]byte(`[1,"x"]`))
	var de *DecodeError
	if !errors.As(err, &de) || de.Path != "/1" {
		t.Fatalf("expected path /1, got %v", err)
	}
	m := MapCodec(StringCodec)
	out, err := m.Encode(map[string]string{"b": "2", "a": "1"})
	if err != nil || string(out) != `{"a":"1","b":"2"}` {
		t.Fatalf("map encode %s %v", out, err)
	}
	if _, err := m.Decode([]byte(`{"a":"1","a":"2"}`)); err == nil {
		t.Fatal("duplicate key accepted")
	}
}

func TestObjectReader(t *testing.T) {
	r, err := NewObjectReader([]byte(`{"a":"x","b":1,"c":true}`))
	if err != nil {
		t.Fatal(err)
	}
	var a string
	var b *int32
	ReadRequired(r, "a", &a, StringCodec)
	ReadOptional(r, "b", &b, IntCodec[int32]())
	if err := r.Finish(IgnoreUnknown); err != nil || a != "x" || *b != 1 {
		t.Fatal(err)
	}
	if err := r.Finish(RejectUnknown); err == nil || !strings.Contains(err.Error(), "/c") {
		t.Fatalf("unknown property not rejected: %v", err)
	}
	r, _ = NewObjectReader([]byte(`{}`))
	ReadRequired(r, "a", &a, StringCodec)
	if err := r.Finish(IgnoreUnknown); err == nil || !strings.Contains(err.Error(), "required") {
		t.Fatalf("missing required not reported: %v", err)
	}
	if _, err := NewObjectReader([]byte(`{} {}`)); err == nil {
		t.Fatal("trailing data accepted")
	}
}

func TestDateTimeEncodings(t *testing.T) {
	ts := time.Date(2022, 8, 26, 14, 38, 0, 0, time.UTC)
	s, _ := DateTimeRFC7231.Format(ts)
	if s != "Fri, 26 Aug 2022 14:38:00 GMT" {
		t.Fatal(s)
	}
	back, err := DateTimeRFC7231.Parse(s)
	if err != nil || !back.Equal(ts) {
		t.Fatal(err)
	}
	u := UnixTimestampCodec[int64]()
	b, _ := u.Encode(ts)
	if string(b) != "1661524680" {
		t.Fatal(string(b))
	}
	if _, err := u.Encode(ts.Add(time.Millisecond)); err == nil {
		t.Fatal("sub-second unix timestamp accepted")
	}
	if _, err := DateTimeRFC3339.Parse("2022-08-26"); err == nil {
		t.Fatal("date accepted as date-time")
	}
	if _, err := ParseDate("2022-02-30"); err == nil {
		t.Fatal("invalid date accepted")
	}
	tod, err := ParseTimeOfDay("13:06:12.5")
	if err != nil || tod.String() != "13:06:12.5" {
		t.Fatal(tod, err)
	}
}

func TestDuration(t *testing.T) {
	cases := map[string]string{"P40D": "P40D", "PT1H30M": "PT1H30M", "P1Y2M3W4DT5H6M7.25S": "P1Y2M3W4DT5H6M7.25S", "PT0S": "PT0S", "-PT1S": "-PT1S", "PT0.5S": "PT0.5S"}
	for in, want := range cases {
		d, err := ParseDuration(in)
		if err != nil || d.String() != want {
			t.Errorf("%s → %v %v", in, d, err)
		}
	}
	for _, in := range []string{"", "P", "PT", "1D", "P1H", "PT1D", "P1.5D", "PT1.5M1S", "PT1.0000000001S", "P1M1Y"} {
		if _, err := ParseDuration(in); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
	if _, err := (Duration{Months: 1}).Std(); !errors.Is(err, ErrCalendarDuration) {
		t.Fatal("calendar duration converted")
	}
	sec := DurationSecondsCodec("float64")
	d, err := sec.Decode([]byte("35.625"))
	if err != nil {
		t.Fatal(err)
	}
	std, _ := d.Std()
	if std != 35625*time.Millisecond {
		t.Fatal(std)
	}
	if b, _ := sec.Encode(d); string(b) != "35.625" {
		t.Fatal(string(b))
	}
	i32 := DurationSecondsCodec("int32")
	if _, err := i32.Encode(DurationOf(1500 * time.Millisecond)); err == nil {
		t.Fatal("fractional seconds encoded as int")
	}
}

func TestDecimalAndInteger(t *testing.T) {
	d, err := DecimalCodec.Decode([]byte("0.3333333333333333333333333333333333333"))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := DecimalCodec.Encode(d)
	if string(b) != "0.3333333333333333333333333333333333333" {
		t.Fatal("precision lost")
	}
	v := NewValidator()
	Decimal128(v, d)
	if v.Err() == nil {
		t.Fatal("decimal128 digits not checked")
	}
	i, err := IntegerCodec.Decode([]byte("123456789012345678901234567890"))
	if err != nil || i.String() != "123456789012345678901234567890" {
		t.Fatal(i, err)
	}
	if _, err := ParseDecimal("01"); err == nil {
		t.Fatal("non-JSON number accepted")
	}
}

func TestBase64(t *testing.T) {
	if _, err := Base64Text.Parse("dGVzdA"); err == nil {
		t.Fatal("unpadded std base64 accepted")
	}
	b, err := Base64URLText.Parse("dGVzdA")
	if err != nil || string(b) != "test" {
		t.Fatal(err)
	}
	if s, _ := Base64URLText.Format([]byte("test")); s != "dGVzdA" {
		t.Fatal(s)
	}
}

func TestValidator(t *testing.T) {
	v := NewValidator()
	MaxLength(v.At("name"), "héllo", 4)
	Minimum(v.At("items").At(2).At("n"), int32(1), 2, false)
	Merge := NewValidator()
	Merge.At("child").Merge(v.Err())
	var es ValidationErrors
	if !errors.As(Merge.Err(), &es) || len(es) != 2 || es[0].Path != "/child/name" || es[1].Path != "/child/items/2/n" {
		t.Fatalf("%#v", es)
	}
	v = NewValidator()
	MaxLength(v, "héllo", 5) // 5 code points, 6 bytes
	if v.Err() != nil {
		t.Fatal("length counted in bytes")
	}
}

func TestDecodeUnionOrder(t *testing.T) {
	var got string
	variants := []UnionVariant{
		{Name: "int", Kinds: []JSONKind{KindNumber}, Try: func(b []byte) (func(), bool, error) {
			if _, err := IntCodec[int32]().Decode(b); err != nil {
				return nil, false, err
			}
			return func() { got = "int" }, true, nil
		}},
		{Name: "float", Kinds: []JSONKind{KindNumber}, Try: func(b []byte) (func(), bool, error) {
			if _, err := Float64Codec.Decode(b); err != nil {
				return nil, false, err
			}
			return func() { got = "float" }, true, nil
		}},
		{Name: "string", Kinds: []JSONKind{KindString}, Try: func(b []byte) (func(), bool, error) {
			if _, err := StringCodec.Decode(b); err != nil {
				return nil, false, err
			}
			return func() { got = "string" }, true, nil
		}},
	}
	for in, want := range map[string]string{"1": "int", "1.5": "float", `"x"`: "string"} {
		if err := DecodeUnion([]byte(in), variants); err != nil || got != want {
			t.Errorf("%s → %s %v", in, got, err)
		}
	}
	if err := DecodeUnion([]byte("true"), variants); err == nil {
		t.Fatal("boolean accepted")
	}
}

func TestParameters(t *testing.T) {
	q := url.Values{"colors": {"blue,red%2C,green"}, "multi": {"a", "b"}, "pipes": {"a|b"}}
	xs, ok, err := DecodeQueryArray(q, "colors", "", false, StringText)
	if err != nil || !ok || len(xs) != 3 {
		t.Fatal(xs, err)
	}
	xs, _, err = DecodeQueryArray(q, "multi", "", true, StringText)
	if err != nil || strings.Join(xs, "") != "ab" {
		t.Fatal(xs, err)
	}
	xs, _, err = DecodeQueryArray(q, "pipes", "pipeDelimited", false, StringText)
	if err != nil || strings.Join(xs, "") != "ab" {
		t.Fatal(xs, err)
	}
	arr, err := DecodePathArray("a%2Cb,c", "p", "simple", false, StringText)
	if err != nil || len(arr) != 2 || arr[0] != "a,b" {
		t.Fatal(arr, err)
	}
	lbl, err := DecodePathArray(".a.b", "p", "label", true, StringText)
	if err != nil || strings.Join(lbl, "") != "ab" {
		t.Fatal(lbl, err)
	}
	m, err := DecodePathValue(";p=x", "p", "matrix", false, StringText)
	if err != nil || m != "x" {
		t.Fatal(m, err)
	}
	r := httptest.NewRequest("GET", "/a/b%2Fc/d", nil)
	segs := RawPathSegments(r)
	if PathSegment(segs, 1, false) != "b%2Fc" || PathSegment(segs, 1, true) != "b%2Fc/d" {
		t.Fatal(segs)
	}
}

func TestContentType(t *testing.T) {
	if mt, err := MatchContentType("application/JSON; charset=utf-8", []string{"application/json"}); err != nil || mt != "application/json" {
		t.Fatal(mt, err)
	}
	_, err := MatchContentType("text/plain", []string{"application/json"})
	var re *RequestError
	if !errors.As(err, &re) || re.StatusCode() != 415 {
		t.Fatal(err)
	}
}

func TestRawCodec(t *testing.T) {
	v, err := RawCodec.Decode([]byte(` {"a": [1, null]} `))
	if err != nil || string(v) != `{"a": [1, null]}` {
		t.Fatal(string(v), err)
	}
	if _, err := RawCodec.Decode([]byte(`{`)); err == nil {
		t.Fatal("invalid JSON accepted")
	}
	var raw json.RawMessage
	_ = raw
}

func FuzzDurationRoundTrip(f *testing.F) {
	for _, s := range []string{"P1Y", "PT1.5S", "-P3W", "P1DT2H"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		d, err := ParseDuration(s)
		if err != nil {
			return
		}
		d2, err := ParseDuration(d.String())
		if err != nil || d2 != d {
			t.Fatalf("%q → %q → %v %v", s, d.String(), d2, err)
		}
	})
}

func FuzzIntegerCodec(f *testing.F) {
	for _, s := range []string{"0", "-1", "1e3", "12345678901234567890", "1.0"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		v, err := IntegerCodec.Decode([]byte(s))
		if err != nil {
			return
		}
		b, _ := IntegerCodec.Encode(v)
		v2, err := IntegerCodec.Decode(b)
		if err != nil || v2.Cmp(v) != 0 {
			t.Fatalf("%q round trip failed", s)
		}
	})
}

func FuzzObjectReader(f *testing.F) {
	f.Add(`{"a":1,"b":[true]}`)
	f.Fuzz(func(t *testing.T, s string) {
		r, err := NewObjectReader([]byte(s))
		if err != nil {
			return
		}
		if !json.Valid([]byte(s)) {
			t.Fatalf("accepted invalid JSON %q", s)
		}
		_ = r
	})
}

func TestWireUnicode(t *testing.T) {
	for _, s := range []string{`"\ud800"`, `"\udc00"`, `"\ud812\u0041"`, "\"\xff\""} {
		if _, err := StringCodec.Decode([]byte(s)); err == nil {
			t.Errorf("accepted %q", s)
		}
		if _, err := NewObjectReader([]byte("{" + s + ":1}")); err == nil {
			t.Errorf("accepted key %q", s)
		}
		if _, err := RawCodec.Decode([]byte("[" + s + "]")); err == nil {
			t.Errorf("accepted raw %q", s)
		}
	}
	for _, s := range []string{`"\ud83d\ude03"`, `"\\ud800"`, `"�"`} {
		if _, err := StringCodec.Decode([]byte(s)); err != nil {
			t.Errorf("%s: %v", s, err)
		}
	}
	if _, err := MapCodec(StringCodec).Encode(map[string]string{"\xff": "ok"}); err == nil {
		t.Fatal("encoded invalid map key")
	}
	if _, err := StringCodec.Encode("\xff"); err == nil {
		t.Fatal("encoded invalid string")
	}
	if _, err := StringText.Parse("\xff"); err == nil {
		t.Fatal("accepted invalid text")
	}
}
