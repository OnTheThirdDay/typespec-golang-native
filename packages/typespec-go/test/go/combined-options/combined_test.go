package gen

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"example.com/gen/tsgo"
)

func (r Reading) ValidateExtension(v *tsgo.Validator) {
	if r.Value < 0 {
		v.At("value").Add("non-negative", "readings are never negative")
	}
}

type srv struct{}

func (srv) Submit(ctx context.Context, r SubmitRequestObject) (SubmitResponseObject, error) {
	return Submit200JSONResponse{Body: r.Body}, nil
}

func call(t *testing.T, opts ServerOptions, body string) (int, string, error) {
	t.Helper()
	var got error
	opts.RequestErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		got = err
		tsgo.DefaultRequestErrorHandler(w, r, err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/report", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	NewHandler(srv{}, opts).ServeHTTP(rec, req)
	b, _ := io.ReadAll(rec.Body)
	return rec.Code, strings.TrimSpace(string(b)), got
}

func TestCombinedOptions(t *testing.T) {
	in := `{"readings":{"z<1>":{"value":1,"unit":" m"},"a":{"value":1e-5,"unit":"é"}},"totals":{"b":16777216,"a":0.1},"tags":{"k":"<&>"}}`
	code, out, err := call(t, ServerOptions{}, in)
	// Order kept, floats in Pydantic form, minimal escaping, unset nullable written as null.
	want := `{"readings":{"z<1>":{"value":1.0,"unit":"` + " " + `m","note":null},"a":{"value":0.00001,"unit":"é","note":null}},"totals":{"b":16777216.0,"a":0.1},"tags":{"k":"<&>"}}`
	if code != 200 || out != want {
		t.Fatalf("%d %v\n got %s\nwant %s", code, err, out, want)
	}
	// Hooks and constraints inside ordered records, collected with their paths: reading b decoded
	// completely (its constraint and its hook are checked although a failed); a did not, so its
	// hook does not run and its zero value is not checked.
	_, _, err = call(t, ServerOptions{CollectErrors: true}, `{"readings":{"b":{"value":-1,"unit":"0123456789"},"a":{"value":"x","unit":"m"}}}`)
	var paths []string
	for _, d := range tsgo.Details(err, 0) {
		paths = append(paths, d.Path+":"+string(d.Kind)+":"+d.Constraint)
	}
	if strings.Join(paths, " ") != "/readings/a/value:decode:type /body/readings/b/unit:validation:maxLength /body/readings/b/value:validation:non-negative" {
		t.Fatalf("%v", paths)
	}
	var r Report
	if err := json.Unmarshal([]byte(`{"readings":{"b":{"value":-1,"unit":"0123456789"},"a":{"value":2,"unit":"m"}}}`), &r); err != nil {
		t.Fatal(err)
	}
	var ves tsgo.ValidationErrors
	if err := r.Validate(); !errors.As(err, &ves) || len(ves) != 2 || ves[0].Path != "/readings/b/unit" || ves[1].Path != "/readings/b/value" || ves[1].Constraint != "non-negative" {
		t.Fatalf("%v", err)
	}
}
