package gen

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"example.com/gen/tsgo"
)

const fullWidget = `{
  "id": "w1", "name": "Widget", "color": "grn", "tags": ["a"], "meta": {"x": 1},
  "slug": "abc", "nick": null, "aka": "w", "score": 42, "ratio": 0.25,
  "created": "2024-01-02T03:04:05Z", "seen": "Tue, 02 Jan 2024 03:04:05 GMT", "ttl": 30,
  "day": "2024-01-02", "data": "aGk=", "kind": "widget", "mode": "slow", "open": "custom",
  "value": "text", "pair": ["p", 2], "big": 123456789012345678901234567890,
  "amount": 0.1000000000000000000001, "anything": {"free": [1, true, null]}, "prio": 10,
  "child": {"id": "c", "name": "Child", "tags": [], "slug": "child", "nick": "n", "score": 1,
            "created": "2024-01-02T03:04:05Z", "day": "2024-01-02", "kind": "widget",
            "mode": "fast", "open": "a", "value": 7}
}`

func jsonEqual(t *testing.T, a, b []byte) {
	t.Helper()
	var x, y any
	if err := json.Unmarshal(a, &x); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &y); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(x, y) {
		t.Fatalf("JSON differs:\n%s\n%s", a, b)
	}
}

func decodeWidget(t *testing.T, s string) Widget {
	t.Helper()
	var w Widget
	if err := json.Unmarshal([]byte(s), &w); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return w
}

func TestRoundTrip(t *testing.T) {
	w := decodeWidget(t, fullWidget)
	if w.Color == nil || *w.Color != ColorGreen || w.Mode != WidgetModeSlow || w.Open != "custom" {
		t.Fatalf("unexpected values %+v", w)
	}
	if !w.Nick.IsNull() || w.Aka == nil || w.Aka.MustGet() != "w" {
		t.Fatal("nullable handling")
	}
	if w.Seen == nil || !w.Seen.Equal(time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)) {
		t.Fatal("rfc7231")
	}
	if d, _ := w.TTL.Std(); d != 30*time.Second {
		t.Fatal("seconds duration")
	}
	if string(*w.Data) != "hi" || w.Day != (tsgo.Date{Year: 2024, Month: 1, Day: 2}) {
		t.Fatal("bytes/date")
	}
	if w.Big.String() != "123456789012345678901234567890" || w.Amount.String() != "0.1000000000000000000001" {
		t.Fatal("arbitrary precision lost")
	}
	if s, ok := w.Value.AsString(); !ok || s != "text" {
		t.Fatal("union string variant")
	}
	if v, ok := w.Child.Value.AsInt32(); !ok || v != 7 {
		t.Fatal("union int variant")
	}
	if w.Pair.Item0 != "p" || w.Pair.Item1 != 2 {
		t.Fatal("tuple")
	}
	out, err := json.Marshal(w)
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, out, []byte(fullWidget))
	if err := w.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestPresenceAndNull(t *testing.T) {
	base := `{"id":"x","name":"n","tags":[],"slug":"s","nick":%s,"score":1,"created":"2024-01-02T03:04:05Z","day":"2024-01-02","kind":"widget","mode":"fast","open":"a","value":1%s}`
	fill := func(nick, extra string) string {
		return strings.Replace(strings.Replace(base, "%s", nick, 1), "%s", extra, 1)
	}
	if w := decodeWidget(t, fill(`"v"`, "")); w.Aka != nil {
		t.Fatal("absent optional must be nil")
	}
	if w := decodeWidget(t, fill(`"v"`, `,"aka":null`)); w.Aka == nil || !w.Aka.IsNull() {
		t.Fatal("explicit null must be kept")
	}
	cases := map[string]string{
		"missing required":      strings.Replace(fill(`"v"`, ""), `"name":"n",`, "", 1),
		"null for non-nullable": strings.Replace(fill(`"v"`, ""), `"name":"n"`, `"name":null`, 1),
		"null optional array":   fill(`"v"`, `,"meta":null`),
		"wrong literal":         strings.Replace(fill(`"v"`, ""), `"kind":"widget"`, `"kind":"gadget"`, 1),
		"unknown enum value":    fill(`"v"`, `,"color":"blue"`),
		"closed literal union":  strings.Replace(fill(`"v"`, ""), `"mode":"fast"`, `"mode":"medium"`, 1),
		"int32 overflow":        strings.Replace(fill(`"v"`, ""), `"score":1`, `"score":3000000000`, 1),
		"duplicate key":         strings.Replace(fill(`"v"`, ""), `"id":"x"`, `"id":"x","id":"y"`, 1),
		"nick absent":           strings.Replace(base, `"nick":%s,`, "", 1),
		"union no match":        strings.Replace(fill(`"v"`, ""), `"value":1`, `"value":1.5`, 1),
		"tuple arity":           fill(`"v"`, `,"pair":["a"]`),
		"rfc3339 required":      strings.Replace(fill(`"v"`, ""), `"2024-01-02T03:04:05Z"`, `"Tue, 02 Jan 2024 03:04:05 GMT"`, 1),
	}
	for name, s := range cases {
		var w Widget
		if err := json.Unmarshal([]byte(s), &w); err == nil {
			t.Errorf("%s: decoding succeeded", name)
		}
	}
	var w Widget
	err := json.Unmarshal([]byte(strings.Replace(fill(`"v"`, ""), `"score":1`, `"score":"1"`, 1)), &w)
	var de *tsgo.DecodeError
	if !errors.As(err, &de) || de.Path != "/score" {
		t.Fatalf("expected decode error at /score, got %v", err)
	}
}

func TestOpenEnumAndUnknownProperties(t *testing.T) {
	w := decodeWidget(t, strings.Replace(fullWidget, `"id": "w1"`, `"id": "w1", "extra": 1`, 1))
	if w.ID != "w1" {
		t.Fatal("unknown property should be ignored by default")
	}
	if !WidgetOpen("anything").Valid() || WidgetOpenA != "a" {
		t.Fatal("open enum")
	}
}

func TestUnionsAndPolymorphism(t *testing.T) {
	var z Zoo
	in := `{"pets":[{"kind":"cat","lives":9},{"kind":"dog","good":true}],
	        "wrapped":{"kind":"dog","value":{"kind":"dog","good":false}},
	        "fish":[{"kind":"shark","age":3,"teeth":20},{"kind":"salmon","age":1},{"kind":"tuna","age":2}]}`
	if err := json.Unmarshal([]byte(in), &z); err != nil {
		t.Fatal(err)
	}
	if c, ok := z.Pets[0].AsCat(); !ok || c.Lives != 9 || z.Pets[1].Kind() != PetKindDog {
		t.Fatal("discriminated union")
	}
	if d, ok := z.Wrapped.AsDog(); !ok || d.Good {
		t.Fatal("envelope union")
	}
	if s, ok := z.Fish[0].AsShark(); !ok || s.Teeth != 20 {
		t.Fatal("polymorphic derived")
	}
	if b, ok := z.Fish[2].AsBase(); !ok || b.Kind != "tuna" {
		t.Fatal("polymorphic fallback to base")
	}
	out, _ := json.Marshal(z)
	jsonEqual(t, out, []byte(in))
	var p Pet
	if err := json.Unmarshal([]byte(`{"kind":"cow"}`), &p); err == nil {
		t.Fatal("unknown discriminator accepted")
	}
	if _, err := json.Marshal(Pet{}); err == nil {
		t.Fatal("unset union encoded")
	}
	if err := (Zoo{Pets: []Pet{{}}}).Validate(); err == nil || !strings.Contains(err.Error(), "/pets/0") {
		t.Fatalf("unset union not reported: %v", err)
	}
	v := NewWidgetValueBase(Base{ID: "b"})
	b, _ := json.Marshal(v)
	if string(b) != `{"id":"b"}` {
		t.Fatal(string(b))
	}
}

func TestDefaults(t *testing.T) {
	w := decodeWidget(t, `{"id":"x","name":"n","tags":[],"slug":"s","nick":null,"score":1,"created":"2024-01-02T03:04:05Z","day":"2024-01-02","kind":"widget","mode":"fast","open":"a","value":1,
	  "child":{"id":"c","name":"c","tags":[],"slug":"s","nick":null,"score":1,"created":"2024-01-02T03:04:05Z","day":"2024-01-02","kind":"widget","mode":"fast","open":"a","value":1,"ratio":2}}`)
	if w.Color != nil {
		t.Fatal("decode must not apply defaults")
	}
	w.ApplyDefaults()
	if w.Color == nil || *w.Color != ColorRed || w.Ratio == nil || *w.Ratio != 0.5 {
		t.Fatal("defaults not applied")
	}
	if *w.Child.Ratio != 2 || w.Child.Color == nil {
		t.Fatal("nested defaults must apply without overriding explicit values")
	}
}

func TestValidation(t *testing.T) {
	w := decodeWidget(t, fullWidget)
	w.Name = ""
	w.Score = 101
	w.Slug = "NOT-LOWER"
	w.Child.Name = ""
	next := "not a url"
	err := (Catalog{Widgets: PageWidget{Items: []Widget{w}, Next: &next}}).Validate()
	var ves tsgo.ValidationErrors
	if !errors.As(err, &ves) {
		t.Fatalf("expected validation errors, got %v", err)
	}
	got := map[string]string{}
	for _, e := range ves {
		got[e.Path] = e.Constraint
	}
	want := map[string]string{
		"/widgets/items/0/name":       "minLength",
		"/widgets/items/0/score":      "maximum",
		"/widgets/items/0/slug":       "pattern",
		"/widgets/items/0/child/name": "minLength",
		"/widgets/next":               "url",
	}
	for p, c := range want {
		if got[p] != c {
			t.Errorf("%s: want %s, got %q (all: %v)", p, c, got[p], got)
		}
	}
	if err := Color("blue").Validate(); err == nil {
		t.Fatal("enum membership not validated")
	}
	if _, err := json.Marshal(Color("blue")); err == nil {
		t.Fatal("invalid enum encoded")
	}
}

func TestDiscriminatedDefaultVariant(t *testing.T) {
	var xs []Tagged
	in := `[{"kind":"known","x":1},{"kind":"mystery","extra":"e"}]`
	if err := json.Unmarshal([]byte(in), &xs); err != nil {
		t.Fatal(err)
	}
	if k, ok := xs[0].AsKnown(); !ok || k.X != 1 {
		t.Fatal("known variant")
	}
	if o, ok := xs[1].AsDefault(); !ok || o.Kind != "mystery" || *o.Extra != "e" {
		t.Fatal("undeclared discriminator must select the default variant")
	}
	out, _ := json.Marshal(xs)
	jsonEqual(t, out, []byte(in))
}

func TestFallbackCannotEncodeAKnownDiscriminator(t *testing.T) {
	v := NewTaggedDefault(Other{Kind: "known"})
	if v.Validate() == nil {
		t.Fatal("fallback validated with a named tag")
	}
	if _, err := json.Marshal(v); err == nil {
		t.Fatal("fallback serialized as the known variant")
	}
}
