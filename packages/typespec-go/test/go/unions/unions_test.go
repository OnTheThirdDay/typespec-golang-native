package gen

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"example.com/gen/tsgo"
)

// failure decodes into v and returns the path and message of the decoding error.
func failure(t *testing.T, input string, v any) (*tsgo.DecodeError, string) {
	t.Helper()
	err := json.Unmarshal([]byte(input), v)
	var de *tsgo.DecodeError
	if !errors.As(err, &de) {
		t.Fatalf("%s: expected a DecodeError, got %v", input, err)
	}
	return de, err.Error()
}

func TestSelectionIsUnchanged(t *testing.T) {
	var d Drawing
	in := `{"shapes":[{"kind":"circle","radius":1},{"kind":"square","side":2},{"kind":"line","points":[{"x":1,"y":2}]},{"kind":"text","body":{"format":"rich","html":"<b>"}}]}`
	if err := json.Unmarshal([]byte(in), &d); err != nil {
		t.Fatal(err)
	}
	kinds := []DrawingShapesItemKind{DrawingShapesItemKindCircle, DrawingShapesItemKindSquare, DrawingShapesItemKindLine, DrawingShapesItemKindText}
	for i, k := range kinds {
		if d.Shapes[i].Kind() != k {
			t.Fatalf("shape %d: %v", i, d.Shapes[i].Kind())
		}
	}
	if text, _ := d.Shapes[3].AsText(); text.Body.Kind() != FragmentKindRich {
		t.Fatal("nested union")
	}
	var in2 Inputs
	if err := json.Unmarshal([]byte(`{"many":{"kind":"k7","v":7},"noConst":{"c":true},"versioned":{"revision":2,"a":3},"typeNamed":{"type":"x","x":1}}`), &in2); err != nil {
		t.Fatal(err)
	}
	if in2.Many.Kind() != ManyKindBig7 || in2.NoConst.Kind() != NoConstKindC || in2.Versioned.Kind() != VersionedKindV2 || in2.TypeNamed.Kind() != TypeNamedKindX {
		t.Fatalf("%+v", in2)
	}
}

func TestTheVariantIdentifiedByItsConstantsIsReported(t *testing.T) {
	var d Drawing
	de, msg := failure(t, `{"shapes":[{"kind":"circle","radius":"big"}]}`, &d)
	var ve *tsgo.VariantError
	if de.Path != "/shapes/0/radius" || !errors.As(de, &ve) || ve.Variant != "Circle" {
		t.Fatalf("path %q, %v", de.Path, msg)
	}
	for _, other := range []string{"Square", "Line", "Text"} {
		if strings.Contains(msg, other) {
			t.Fatalf("unrelated variant %s reported: %s", other, msg)
		}
	}
	// Closed variant: the undeclared property is the reported failure.
	de, _ = failure(t, `{"shapes":[{"kind":"square","side":1},{"kind":"square","side":1,"extra":true}]}`, &d)
	if de.Path != "/shapes/1/extra" {
		t.Fatalf("path %q", de.Path)
	}
	// Nested unions: each level reports the intended variant.
	de, msg = failure(t, `{"shapes":[{"kind":"text","body":{"format":"rich","html":5}}]}`, &d)
	if de.Path != "/shapes/0/body/html" || !strings.Contains(msg, "union variant Rich") || !strings.Contains(msg, "union variant Text") || strings.Contains(msg, "Plain") {
		t.Fatalf("path %q: %s", de.Path, msg)
	}
	// Twelve variants: one is reported.
	var in Inputs
	de, msg = failure(t, `{"many":{"kind":"k7","v":"seven"}}`, &in)
	if de.Path != "/many/v" || !errors.As(de, &ve) || ve.Variant != "Big7" || strings.Count(msg, "Big") != 1 {
		t.Fatalf("path %q: %s", de.Path, msg)
	}
	// Numeric constants under an unconventional name; numbers compare by value.
	de, _ = failure(t, `{"versioned":{"revision":2.0,"a":"s"}}`, &in)
	if de.Path != "/versioned/a" || !errors.As(de, &ve) || ve.Variant != "V2" {
		t.Fatalf("path %q %v", de.Path, de)
	}
	// A property named "type" is evidence only where it is a declared constant.
	de, _ = failure(t, `{"typeNamed":{"type":"x","x":"bad"}}`, &in)
	if de.Path != "/typeNamed/x" || !errors.As(de, &ve) || ve.Variant != "X" {
		t.Fatalf("path %q %v", de.Path, de)
	}
}

func TestUnmatchedConstantsAndUnidentifiedValues(t *testing.T) {
	var d Drawing
	de, msg := failure(t, `{"shapes":[{"kind":"hexagon","sides":6}]}`, &d)
	var ue *tsgo.UnionError
	if de.Path != "/shapes/0/kind" || !errors.As(de, &ue) || len(ue.Variants) != 4 {
		t.Fatalf("path %q: %s", de.Path, msg)
	}
	if !strings.Contains(msg, `"hexagon" identifies no union variant (expected "circle" or "square" or "line" or "text")`) {
		t.Fatal(msg)
	}
	de, msg = failure(t, `{"shapes":[{"radius":1}]}`, &d)
	if de.Path != "/shapes/0/kind" || !strings.Contains(msg, "missing identifies no union variant") {
		t.Fatalf("path %q: %s", de.Path, msg)
	}
	// Without constants every candidate is kept (structured), the message is bounded.
	var in Inputs
	de, msg = failure(t, `{"noConst":{"z":1}}`, &in)
	if de.Path != "/noConst" || !errors.As(de, &ue) || len(ue.Variants) != 5 || ue.Kind != tsgo.KindObject {
		t.Fatalf("path %q: %s", de.Path, msg)
	}
	if !strings.Contains(msg, "and 2 more") || len(msg) > 1000 {
		t.Fatal(msg)
	}
	for i, name := range []string{"A", "B", "C", "D", "E"} {
		var vde *tsgo.DecodeError
		if ue.Variants[i].Variant != name || !errors.As(ue.Variants[i].Err, &vde) {
			t.Fatalf("variant %d: %+v", i, ue.Variants[i])
		}
	}
	// JSON kinds no variant accepts.
	if _, msg := failure(t, `{"noConst":"text"}`, &in); !strings.Contains(msg, "no union variant accepts a JSON string") {
		t.Fatal(msg)
	}
}

func TestConstraintViolationsAreValidationErrors(t *testing.T) {
	var d Drawing
	// The value decodes as a Circle; the violated constraint is a validation failure.
	if err := json.Unmarshal([]byte(`{"shapes":[{"kind":"circle","radius":1,"size":500}]}`), &d); err != nil {
		t.Fatal(err)
	}
	var ves tsgo.ValidationErrors
	if err := d.Validate(); !errors.As(err, &ves) || len(ves) != 1 || ves[0].Path != "/shapes/0/size" || ves[0].Constraint != "maximum" {
		t.Fatalf("%v", err)
	}
}

type drawServer struct{}

func (drawServer) Draw(ctx context.Context, r DrawRequestObject) (DrawResponseObject, error) {
	return Draw204Response{}, nil
}

func TestRequestErrorHandlersReceiveStructuredErrors(t *testing.T) {
	var got error
	h := NewHandler(drawServer{}, ServerOptions{RequestErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
		got = err
		tsgo.DefaultRequestErrorHandler(w, r, err)
	}})
	post := func(body string) int {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/draw", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	if code := post(`{"shapes":[{"kind":"circle","radius":"big"}]}`); code != 400 {
		t.Fatal(code)
	}
	var re *tsgo.RequestError
	var de *tsgo.DecodeError
	var ve *tsgo.VariantError
	if !errors.As(got, &re) || re.Kind != tsgo.ErrBody || !errors.As(got, &de) || de.Path != "/shapes/0/radius" || !errors.As(got, &ve) || ve.Variant != "Circle" {
		t.Fatalf("%v", got)
	}
	if code := post(`{"shapes":[{"kind":"circle","radius":1,"size":500}]}`); code != 400 {
		t.Fatal(code)
	}
	var ves tsgo.ValidationErrors
	if !errors.As(got, &re) || re.Kind != tsgo.ErrValidation || !errors.As(got, &ves) || ves[0].Path != "/body/shapes/0/size" || errors.As(got, &de) {
		t.Fatalf("%v", got)
	}
	got = nil
	if code := post(`{"shapes":[{"kind":"square","side":3}]}`); code != 204 || got != nil {
		t.Fatal(code, got)
	}
}
