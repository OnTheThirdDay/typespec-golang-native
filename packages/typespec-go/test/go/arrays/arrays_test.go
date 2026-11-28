package gen

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"

	"example.com/gen/tsgo"
)

func paths(err error) []string {
	var out []string
	for _, d := range tsgo.Details(err, 0) {
		out = append(out, d.Path+":"+d.Constraint)
	}
	return out
}

func TestNamedArrayCodec(t *testing.T) {
	var docs Docs
	if err := json.Unmarshal([]byte(`[{"title":"a"},{"title":"b","tags":[]}]`), &docs); err != nil || len(docs) != 2 || docs[1].Tags == nil {
		t.Fatalf("%v %+v", err, docs)
	}
	b, err := json.Marshal(docs)
	if err != nil || string(b) != `[{"title":"a"},{"title":"b","tags":[]}]` {
		t.Fatalf("%s %v", b, err)
	}
	// A nil named array is written as [] (as an anonymous array); null is rejected.
	if b, _ := Docs(nil).MarshalJSON(); string(b) != "[]" {
		t.Fatal(string(b))
	}
	if err := json.Unmarshal([]byte(`null`), &docs); err == nil {
		t.Fatal("null accepted")
	}
	var p *tsgo.DecodeProblem
	if err := json.Unmarshal([]byte(`{"title":"a"}`), &docs); !errors.As(err, &p) || p.Kind != tsgo.ProblemType || p.Expected != "array" {
		t.Fatalf("%v", err)
	}
	// Assignable to and from the slice type.
	var plain []Doc = docs
	docs = plain
	_ = docs
}

func TestNamedArrayValidation(t *testing.T) {
	four := Docs{{Title: "a"}, {Title: ""}, {Title: "c"}, {Title: "d"}}
	err := four.Validate()
	if got := paths(err); !slices.Equal(got, []string{":maxItems", "/1/title:minLength"}) {
		t.Fatal(got)
	}
	// Inside a model: the array model's constraints and the property's own constraints apply.
	s := Shelf{Docs: four, Limited: &Docs{{Title: "a"}, {Title: "b"}}, Tags: &Tags{}}
	if got := paths(s.Validate()); !slices.Equal(got, []string{"/docs:maxItems", "/docs/1/title:minLength", "/limited:maxItems", "/tags:minItems"}) {
		t.Fatal(got)
	}
	nested := []Docs{{{Title: ""}}}
	if got := paths(Shelf{Nested: &nested}.Validate()); !slices.Equal(got, []string{"/nested/0/0/title:minLength"}) {
		t.Fatal(got)
	}
}

func TestNamedArrayDefaults(t *testing.T) {
	var s Shelf
	if err := json.Unmarshal([]byte(`{"docs":[{"title":"a"}],"pages":[{"title":"p"}],"empty":[]}`), &s); err != nil {
		t.Fatal(err)
	}
	s.ApplyDefaults()
	if !reflect.DeepEqual(s.Docs[0].Tags, &[]string{"new"}) || !reflect.DeepEqual((*s.Pages)[0].Tags, &[]string{"new"}) {
		t.Fatalf("%+v %+v", s.Docs[0], (*s.Pages)[0])
	}
	if s.Tags == nil || !slices.Equal(*s.Tags, Tags{"a"}) {
		t.Fatalf("%v", s.Tags)
	}
	docs := Docs{{Title: "x"}}
	docs.ApplyDefaults()
	if docs[0].Tags == nil || (*docs[0].Tags)[0] != "new" {
		t.Fatalf("%+v", docs)
	}
}

func TestPartiallyDecodedNamedArray(t *testing.T) {
	var docs Docs
	err := json.Unmarshal([]byte(`[{"title":""},{"title":5},{"title":"ok"}]`), &docs)
	p, ok := tsgo.Partial[Docs](err)
	if err == nil || docs != nil || !ok || len(p) != 3 || p[2].Title != "ok" {
		t.Fatalf("%v %v %v", err, ok, p)
	}
	if got := paths(tsgo.ValidateDecoded(err, p.ValidateWith)); !slices.Equal(got, []string{"/1/title:type", "/0/title:minLength"}) {
		t.Fatal(got)
	}
}

func TestZeroElementTuples(t *testing.T) {
	var s Shelf
	in := `{"docs":[],"empty":[],"scopes":{"type":"oauth2","flows":[{"type":"clientCredentials","tokenUrl":"https://example.com/token","scopes":[]}],"defaultScopes":[]}}`
	if err := json.Unmarshal([]byte(in), &s); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(s)
	if err != nil || string(b) != in {
		t.Fatalf("%s %v", b, err)
	}
	for _, bad := range []string{`{"docs":[],"empty":[1]}`, `{"docs":[],"empty":{}}`, `{"docs":[],"empty":null}`} {
		if err := json.Unmarshal([]byte(bad), &s); err == nil {
			t.Fatalf("%s accepted", bad)
		}
	}
	var p *tsgo.DecodeProblem
	if err := json.Unmarshal([]byte(`{"docs":[],"empty":[1]}`), &s); !errors.As(err, &p) || p.Kind != tsgo.ProblemItems || p.Maximum != 0 {
		t.Fatalf("%v", err)
	}
}

type srv struct{}

func (srv) Put(ctx context.Context, r PutRequestObject) (PutResponseObject, error) {
	if r.Tags != nil {
		r.Body.Tags = r.Tags
	}
	r.Body.More = &Docs{{Title: strings.Join(r.Need, "+")}}
	return Put200JSONResponse{Body: r.Body}, nil
}

func (srv) Docs(ctx context.Context, r DocsRequestObject) (DocsResponseObject, error) {
	return Docs200JSONResponse{Body: r.Body}, nil
}

func call(t *testing.T, method, target string, header map[string]string, body string) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range header {
		req.Header.Set(k, v)
	}
	NewHandler(srv{}, ServerOptions{}).ServeHTTP(rec, req)
	return rec.Code, strings.TrimSpace(rec.Body.String())
}

func TestNamedArraysOnTheWire(t *testing.T) {
	code, out := call(t, "POST", "/shelf?tags=x,y", map[string]string{"x-tags": "p,q"}, `{"docs":[{"title":"a"}],"empty":[]}`)
	if code != 200 || out != `{"docs":[{"title":"a","tags":["new"]}],"more":[{"title":"p+q"}],"tags":["x","y"],"empty":[]}` {
		t.Fatalf("%d %s", code, out)
	}
	// The array model's constraints apply to properties, parameters and bodies.
	if code, out := call(t, "POST", "/shelf", map[string]string{"x-tags": "p"}, `{"docs":[],"empty":[],"tags":[]}`); code != 400 || !strings.Contains(out, `"Path":"/body/tags","Constraint":"minItems"`) {
		t.Fatalf("%d %s", code, out)
	}
	if code, out := call(t, "POST", "/shelf", nil, `{"docs":[],"empty":[]}`); code != 400 || !strings.Contains(out, `header parameter \"x-tags\": required parameter is missing`) {
		t.Fatalf("%d %s", code, out)
	}
	if code, out := call(t, "POST", "/docs", nil, `[{"title":"a"},{"title":"b"},{"title":"c"},{"title":"d"}]`); code != 400 || !strings.Contains(out, "maxItems") {
		t.Fatalf("%d %s", code, out)
	}
	if code, out := call(t, "POST", "/docs", nil, `[{"title":"a"}]`); code != 200 || out != `[{"title":"a","tags":["new"]}]` {
		t.Fatalf("%d %s", code, out)
	}
}

func TestUserCollectionsNamedArrayAndRecord(t *testing.T) {
	data := `{"rows":{"payload":[[[]]]},"index":{"payload":{"x":{"y":{}}}}}`
	var v Collections
	if err := json.Unmarshal([]byte(data), &v); err != nil {
		t.Fatal(err)
	}
	if err := v.Validate(); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(v)
	if err != nil || string(b) != data {
		t.Fatalf("%s %v", b, err)
	}
}
