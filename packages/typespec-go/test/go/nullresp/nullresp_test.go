package gen

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"example.com/gen/tsgo"
)

type srv struct{ got *Item }

func sample() Item {
	return Item{
		C:      tsgo.Null[string](),
		Nested: &Inner{},
		List:   &[]Inner{{Y: tsgo.Ptr[int32](1)}},
		Map:    &map[string]Inner{"k": {}},
		Either: tsgo.Ptr(NewItemEitherInner(Inner{})),
		Pair:   &ItemPair{Item0: Inner{}, Item1: 2},
		Pet:    tsgo.Ptr(NewPetUnionDog(Dog{})),
		Plain:  &Other{Z: "z"},
	}
}

const sampleResponse = `{"a":null,"c":null,"nested":{"x":null},"list":[{"x":null,"y":1}],"map":{"k":{"x":null}},"either":{"x":null},"pair":[{"x":null},2],"pet":{"kind":"dog","name":null,"bark":null},"plain":{"z":"z"}}`

func (s *srv) Read(ctx context.Context, r ReadRequestObject) (ReadResponseObject, error) {
	return Read200JSONResponse{Body: sample()}, nil
}

func (s *srv) Echo(ctx context.Context, r EchoRequestObject) (EchoResponseObject, error) {
	s.got = &r.Body
	return Echo200JSONResponse{Body: r.Body}, nil
}

func (s *srv) Export(ctx context.Context, r ExportRequestObject) (ExportResponseObject, error) {
	return Export200StreamResponse{Body: func(yield func(Inner) bool) {
		_ = yield(Inner{}) && yield(Inner{X: tsgo.Ptr(tsgo.Value[int32](3))})
	}}, nil
}

func (s *srv) Events(ctx context.Context, r EventsRequestObject) (EventsResponseObject, error) {
	return Events200StreamResponse{Body: func(yield func(tsgo.SSE[InnerEvents]) bool) {
		yield(tsgo.SSE[InnerEvents]{Event: NewInnerEventsInner(Inner{})})
	}}, nil
}

func get(t *testing.T, h http.Handler, method, path, body string) string {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("%s %s: %d %s", method, path, rec.Code, rec.Body)
	}
	b, _ := io.ReadAll(rec.Body)
	return strings.TrimSpace(string(b))
}

func TestResponsesWriteUnsetNullablePropertiesAsNull(t *testing.T) {
	h := NewHandler(&srv{}, ServerOptions{})
	if got := get(t, h, "GET", "/item", ""); got != sampleResponse {
		t.Fatalf("\n got %s\nwant %s", got, sampleResponse)
	}
	if got := get(t, h, "GET", "/inners", ""); got != "{\"x\":null}\n{\"x\":3}" {
		t.Fatalf("%q", got)
	}
	if got := get(t, h, "GET", "/events", ""); !strings.Contains(got, `data: {"x":null}`) {
		t.Fatalf("%q", got)
	}
}

func TestValuesRequestsAndStandaloneEncodingAreUnchanged(t *testing.T) {
	v := sample()
	before := sample()
	// Standalone serialization still omits unset properties.
	b, err := json.Marshal(v)
	if err != nil || string(b) != `{"c":null,"nested":{},"list":[{"y":1}],"map":{"k":{}},"either":{},"pair":[{},2],"pet":{"kind":"dog"},"plain":{"z":"z"}}` {
		t.Fatalf("%s %v", b, err)
	}
	s := &srv{}
	h := NewHandler(s, ServerOptions{})
	// Requests keep the absent / null / value distinction; the response reflects it.
	got := get(t, h, "POST", "/item", `{"c":"v","a":null,"nested":{"x":4}}`)
	if s.got.A == nil || !s.got.A.IsNull() || s.got.B != nil || s.got.Nested.X == nil || s.got.Nested.X.MustGet() != 4 {
		t.Fatalf("%+v", s.got)
	}
	if got != `{"a":null,"c":"v","nested":{"x":4}}` {
		t.Fatal(got)
	}
	_ = get(t, h, "GET", "/item", "")
	if !reflect.DeepEqual(v, before) {
		t.Fatal("encoding changed the application's value")
	}
}
