package gen

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// The package is generated with the default `unknown-properties: ignore`: a closed model
// (`...Record<never>`) still rejects undeclared properties, and open models still ignore them.

const validRoot = `{"closed":{"name":"a"},"derived":{"id":"d"},"closedFromOpen":{"name":"n","extra":1},` +
	`"spread":{"name":"s","more":"m"},"gen":{"value":"v"},"tree":{"label":"t","kids":[{"label":"u","kids":[]}]},` +
	`"empty":{},"open":{"name":"o"},"reopened":{"id":"r"},"closedExtras":{"a":"x","b":"y"}}`

func TestClosedModelsRejectUndeclaredProperties(t *testing.T) {
	var root Root
	if err := json.Unmarshal([]byte(validRoot), &root); err != nil {
		t.Fatalf("valid input rejected: %v", err)
	}
	out, err := json.Marshal(root)
	if err != nil || string(out) != validRoot {
		t.Fatalf("round trip: %s %v", out, err)
	}
	// Each closed position, with an undeclared property, must be rejected at that path.
	for path, in := range map[string]string{
		"/closed/zz":         strings.Replace(validRoot, `"closed":{"name":"a"}`, `"closed":{"name":"a","zz":1}`, 1),
		"/derived/zz":        strings.Replace(validRoot, `"derived":{"id":"d"}`, `"derived":{"id":"d","zz":1}`, 1),
		"/closedFromOpen/zz": strings.Replace(validRoot, `"extra":1}`, `"extra":1,"zz":1}`, 1),
		"/spread/zz":         strings.Replace(validRoot, `"more":"m"}`, `"more":"m","zz":1}`, 1),
		"/gen/zz":            strings.Replace(validRoot, `"value":"v"}`, `"value":"v","zz":1}`, 1),
		"/tree/kids/0/zz":    strings.Replace(validRoot, `{"label":"u","kids":[]}`, `{"label":"u","kids":[],"zz":1}`, 1),
		"/empty/zz":          strings.Replace(validRoot, `"empty":{}`, `"empty":{"zz":1}`, 1),
		"/closedExtras/zz":   strings.Replace(validRoot, `"b":"y"}`, `"b":"y","zz":"s"}`, 1),
	} {
		if in == validRoot {
			t.Fatalf("%s: test input not modified", path)
		}
		err := json.Unmarshal([]byte(in), &root)
		if err == nil || !strings.Contains(err.Error(), path) || !strings.Contains(err.Error(), "unknown property") {
			t.Errorf("%s: %v", path, err)
		}
	}
	// Open models keep the global policy; a reopened model keeps typed extras.
	in := strings.Replace(validRoot, `"open":{"name":"o"}`, `"open":{"name":"o","zz":1}`, 1)
	in = strings.Replace(in, `"reopened":{"id":"r"}`, `"reopened":{"id":"r","zz":"kept"}`, 1)
	in = strings.Replace(in, `"empty":{}}`, `"empty":{},"top":1}`, 1)
	if err := json.Unmarshal([]byte(in), &root); err != nil {
		t.Fatalf("open model rejected an undeclared property: %v", err)
	}
	if root.Reopened.AdditionalProperties["zz"] != "kept" {
		t.Fatalf("reopened extras: %+v", root.Reopened)
	}
	// Typed extras of a reopened model are still typed.
	bad := strings.Replace(validRoot, `"reopened":{"id":"r"}`, `"reopened":{"id":"r","zz":1}`, 1)
	if err := json.Unmarshal([]byte(bad), &root); err == nil {
		t.Fatal("reopened extras accepted a number for Record<string>")
	}
}

func TestClosedVariantCannotAbsorbUndeclaredProperty(t *testing.T) {
	var p Picks
	if err := json.Unmarshal([]byte(`{"pick":{"name":"a"}}`), &p); err != nil || p.Pick.Kind() != PickKindClosed {
		t.Fatalf("%v %v", p.Pick.Kind(), err)
	}
	if err := json.Unmarshal([]byte(`{"pick":{"name":"a","note":"n"}}`), &p); err != nil || p.Pick.Kind() != PickKindWide {
		t.Fatalf("%v %v", p.Pick.Kind(), err)
	}
}

type server struct{}

func (server) Root(_ context.Context, r RootRequestObject) (RootResponseObject, error) {
	return Root200JSONResponse{Body: r.Body}, nil
}
func (server) Picks(_ context.Context, r PicksRequestObject) (PicksResponseObject, error) {
	return Picks200JSONResponse{Body: r.Body}, nil
}
func (server) Create(_ context.Context, r CreateRequestObject) (CreateResponseObject, error) {
	return Create200JSONResponse{Body: Widget{ID: "w1", Name: r.Body.Name, Color: r.Body.Color}}, nil
}
func (server) Update(_ context.Context, r UpdateRequestObject) (UpdateResponseObject, error) {
	return Update200JSONResponse{Body: Widget{ID: "w1", Name: r.Body.Name}}, nil
}
func (server) Form(_ context.Context, r FormRequestObject) (FormResponseObject, error) {
	return Form204Response{}, nil
}
func (server) OpenForm(_ context.Context, r OpenFormRequestObject) (OpenFormResponseObject, error) {
	return OpenForm204Response{}, nil
}

func status(t *testing.T, method, path, contentType, body string) int {
	t.Helper()
	h := NewHandler(server{}, ServerOptions{ValidateResponses: true})
	w := httptest.NewRecorder()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", contentType)
	h.ServeHTTP(w, r)
	return w.Code
}

func TestClosedRequestBodies(t *testing.T) {
	const js, mp, form = "application/json", "application/merge-patch+json", "application/x-www-form-urlencoded"
	for _, c := range []struct {
		method, path, ct, body string
		want                   int
	}{
		{"POST", "/widgets", js, `{"name":"n"}`, 200},
		{"POST", "/widgets", js, `{"name":"n","zz":1}`, 400},
		// The create variant does not declare the read-only id, so a closed model rejects it
		// (as the official OpenAPI document does: additionalProperties: {not: {}} on WidgetCreate).
		{"POST", "/widgets", js, `{"name":"n","id":"x"}`, 400},
		{"PATCH", "/widgets", mp, `{"name":"n","color":null}`, 200},
		{"PATCH", "/widgets", mp, `{"name":"n","zz":null}`, 400},
		{"POST", "/form", form, `name=a&tags=x&tags=y`, 204},
		{"POST", "/form", form, `name=a&zz=1`, 400},
		{"POST", "/form", form, `name=a&hidden=1`, 400},
		// Open form bodies ignore undeclared keys but never-typed fields must still be absent.
		{"POST", "/open-form", form, `name=a&zz=1`, 204},
		{"POST", "/open-form", form, `name=a&hidden=1`, 400},
		{"POST", "/root", js, validRoot, 200},
		{"POST", "/root", js, strings.Replace(validRoot, `"empty":{}`, `"empty":{"zz":1}`, 1), 400},
	} {
		if got := status(t, c.method, c.path, c.ct, c.body); got != c.want {
			t.Errorf("%s %s %s: got %d, want %d", c.method, c.path, c.body, got, c.want)
		}
	}
}

func TestClosedEncodingWritesDeclaredPropertiesOnly(t *testing.T) {
	// Encoding writes only declared properties, so a closed response cannot carry extras.
	out, err := json.Marshal(Widget{ID: "i", Name: "n"})
	if err != nil || string(out) != `{"id":"i","name":"n"}` {
		t.Fatalf("%s %v", out, err)
	}
}
