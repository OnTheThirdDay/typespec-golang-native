package gen_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"

	gen "example.com/gen"
	rt "example.com/gen/tsgo"
)

func bodyProblem(t *testing.T, handler func(http.ResponseWriter, *http.Request, error), err error) (int, rt.Problem, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest("POST", "/review", nil), err)
	dec := json.NewDecoder(strings.NewReader(rec.Body.String()))
	dec.UseNumber()
	var problem rt.Problem
	if rec.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("content type %v", rec.Header())
	}
	if e := dec.Decode(&problem); e != nil {
		t.Fatalf("status %d, undecodable problem %q: %v", rec.Code, rec.Body.String(), e)
	}
	return rec.Code, problem, rec.Body.String()
}

func detailKeys(paths []rt.ErrorDetail) []string {
	var a []string
	for _, d := range paths {
		a = append(a, fmt.Sprintf("%s|%s|%s|%s|%s", d.Kind, d.Location, d.Parameter, d.Path, d.Constraint))
	}
	return a
}

func paths(ds []rt.ValidationError) []string {
	var r []string
	for _, e := range ds {
		r = append(r, e.Path)
	}
	return r
}

func generatedViolations(t *testing.T) rt.ValidationErrors {
	t.Helper()
	var v rt.ValidationErrors
	if !errors.As((gen.Item{SKU: "a", Qty: 0}).Validate(), &v) || !slices.Equal(paths(v), []string{"/sku", "/qty"}) {
		t.Fatalf("expected two generated constraints, got %v", v)
	}
	return v
}

func TestRealGeneratedDecodeAndPartial(t *testing.T) {
	var order gen.Order
	err := json.Unmarshal([]byte(`{"id":"a","items":[{"sku":true,"qty":0}],"color":"plum","small":300}`), &order)
	partial, ok := rt.Partial[gen.Order](err)
	if !ok || partial.ID != "a" || len(partial.Items) != 1 {
		t.Fatal("missing actual partial", err)
	}
	wrapped := fmt.Errorf("decode row 7: %w", err)
	d := rt.Details(wrapped, 0)
	want := []string{"decode|||/items/0/sku|type", "decode|||/color|enum", "decode|||/small|range"}
	if !slices.Equal(detailKeys(d), want) {
		t.Fatal(detailKeys(d))
	}
	if d[0].Expected != "string" || d[0].Got != "boolean" || fmt.Sprint(d[1].Allowed) != "[red green]" || d[2].Minimum != uint64(0) || d[2].Maximum != uint64(255) || string(d[0].Value.(json.RawMessage)) != "true" || string(d[2].Value.(json.RawMessage)) != "300" {
		t.Fatalf("raw metadata %+v", d)
	}
	if got := rt.FailedPaths(wrapped); !slices.Equal(got, []string{"/items/0/sku", "/color", "/small"}) {
		t.Fatalf("failed %q", got)
	}
	checked := rt.ValidateDecoded(wrapped, func(v *rt.Validator) {
		if v.RunExtensions() || v.At("items").At(0).RunExtensions() || v.At("items").At(0).At("sku").RunExtensions() || !v.At("items").At(0).At("qty").RunExtensions() {
			t.Error("hook eligibility")
		}
		partial.ValidateWith(v)
	})
	if got := detailKeys(rt.Details(checked, 0)); !slices.Equal(got, append(want, "validation|||/id|minLength", "validation|||/items/0/qty|minimum")) {
		t.Fatalf("checks %v", got)
	}
}

func TestRecordedCollectionFailureAndEscapes(t *testing.T) {
	_, err := rt.ArrayCodec(rt.IntCodec[int8]()).Decode([]byte("[" + strings.TrimSuffix(strings.Repeat("\"x\",", rt.MaxCollectedErrors+2), ",") + "]"))
	enclosed := rt.WithPath("q/~", fmt.Errorf("list: %w", err))
	if got := rt.FailedPaths(enclosed); !slices.Equal(got, []string{"/q~1~0"}) {
		t.Fatal(got)
	}
	if d := rt.Details(enclosed, 2); len(d) != 2 || d[0].Path != "/q~1~0/0" || d[1].Path != "/q~1~0/1" {
		t.Fatal(detailKeys(d))
	}
	var f rt.RequestFailures
	f.Stop(rt.DecodedBodyError(enclosed), "body", true)
	f.Err(func(v *rt.Validator) {
		if v.At("body").At("q/~").At(70).RunExtensions() || !v.At("body").At("sibling").RunExtensions() {
			t.Error("collection boundary")
		}
	})
}

func TestOrderingLocationsVariantsAndExactNumbers(t *testing.T) {
	var order gen.Order
	err := json.Unmarshal([]byte(`{"id":"ok","items":[],"pet":{"kind":"cat","name":17,"age":"x"}}`), &order)
	known := &rt.DecodeProblem{Kind: rt.ProblemRange, Expected: "uint64", Got: "number", Minimum: uint64(0), Maximum: ^uint64(0), Message: "outside range"}
	group := fmt.Errorf("row: %w", errors.Join(rt.ParamError("header", "outer", rt.BodyError(rt.WithPath("doc/~", err))), &rt.MultiError{Errors: []error{rt.ParamError("query", "limit", known)}}))
	d := rt.Details(group, 9)
	if got := detailKeys(d); !slices.Equal(got, []string{"decode|body||/doc~1~0/pet/name|type", "decode|body||/doc~1~0/pet/age|type", "parameter|query|limit||range"}) {
		t.Fatal(got)
	}
	if d[0].Variant != "Cat" || !slices.Equal(d[0].Unions, []rt.UnionChoice{{Path: "/doc~1~0/pet", Variant: "Cat"}}) || d[1].Variant != "Cat" || d[2].Maximum != ^uint64(0) || string(d[0].Value.(json.RawMessage)) != "17" {
		t.Fatal(d)
	}
	_, p, wire := bodyProblem(t, rt.DetailedRequestErrorHandler(9), group)
	if len(p.Details) != 3 || !strings.Contains(wire, "\"maximum\":18446744073709551615") {
		t.Fatalf("wire %s", wire)
	}
}

func TestValidationEntriesRemainValidation(t *testing.T) {
	es := generatedViolations(t)
	for _, f := range []struct {
		name  string
		value error
	}{
		{"slice", es}, {"joined_entries", errors.Join(es[0], &es[1])}, {"pointer_to_slice", &es},
	} {
		t.Run(f.name, func(t *testing.T) {
			e := rt.BodyError(rt.WithPath("row", f.value))
			d := rt.Details(e, 0)
			want := []string{"validation|body||/row/sku|minLength", "validation|body||/row/qty|minimum"}
			if got := detailKeys(d); !slices.Equal(got, want) {
				t.Errorf("details %v", got)
			} else {
				for i, x := range d {
					if !reflect.DeepEqual(x.Limit, es[i].Limit) || !reflect.DeepEqual(x.Value, es[i].Value) {
						t.Errorf("metadata %+v", x)
					}
				}
			}
			if got := rt.FailedPaths(e); !slices.Equal(got, []string{"/row/sku", "/row/qty"}) {
				t.Errorf("FailedPaths %v", got)
			}
			rt.ValidateDecoded(e, func(v *rt.Validator) {
				if !v.At("row").At("untouched").RunExtensions() {
					t.Error("suppressed independently decoded sibling hook")
				}
			})
			v := rt.NewValidator()
			v.At("import").Merge(e)
			md := rt.Details(v.Err(), 0)
			if got := detailKeys(md); !slices.Equal(got, []string{"validation|||/import/row/sku|minLength", "validation|||/import/row/qty|minimum"}) {
				t.Errorf("merge %v", got)
			}
			for _, h := range []func(http.ResponseWriter, *http.Request, error){rt.DefaultRequestErrorHandler, rt.DetailedRequestErrorHandler(1)} {
				_, problem, _ := bodyProblem(t, h, e)
				if got := paths(problem.Errors); !slices.Equal(got, []string{"/row/sku", "/row/qty"}) ||
					problem.Errors[0].Constraint != es[0].Constraint || problem.Errors[1].Message != es[1].Message {
					t.Errorf("HTTP errors %v", got)
				}
			}
		})
	}
}

type domainFailure struct{ validation rt.ValidationErrors }

func (e *domainFailure) Error() string { return "customer validation failed" }

func (e *domainFailure) As(target any) bool {
	v, ok := target.(*rt.ValidationErrors)
	if ok {
		*v = e.validation
	}
	return ok
}

func TestExistingGoAsAdapterAtLeaf(t *testing.T) {
	es := generatedViolations(t)
	e := fmt.Errorf("lookup: %w", &domainFailure{es})
	var adapterResult rt.ValidationErrors
	if !errors.As(e, &adapterResult) || len(adapterResult) != 2 {
		t.Fatal("bad test adapter")
	}
	v := rt.NewValidator()
	v.At("customer").Merge(e)
	var merged rt.ValidationErrors
	if !errors.As(v.Err(), &merged) || !slices.Equal(paths(merged), []string{"/customer/sku", "/customer/qty"}) {
		t.Errorf("Merge paths %v, details %v", paths(merged), detailKeys(rt.Details(v.Err(), 0)))
	}
	for _, h := range []func(http.ResponseWriter, *http.Request, error){rt.DefaultRequestErrorHandler, rt.DetailedRequestErrorHandler(1)} {
		_, problem, _ := bodyProblem(t, h, e)
		if !slices.Equal(paths(problem.Errors), []string{"/sku", "/qty"}) {
			t.Errorf("HTTP errors %v", paths(problem.Errors))
		}
	}
}

func TestLocationFromEnclosingRequest(t *testing.T) {
	es := generatedViolations(t)
	normal := rt.Details(rt.BodyError(es), 0)
	generic := rt.Details(rt.BodyError(rt.ValidationRequestError(es)), 0)
	if len(normal) != 2 || len(generic) != 2 || normal[0].Location != "body" {
		t.Fatalf("unexpected details %v / %v", detailKeys(normal), detailKeys(generic))
	}
	if generic[0].Location != "body" {
		t.Errorf("location became %q at %s", generic[0].Location, generic[0].Path)
	}
	query := rt.ParamError("query", "a/b", rt.ValidationRequestError(es))
	for _, source := range []error{query, rt.BodyError(query)} {
		ds := rt.Details(source, 1)
		if len(ds) != 1 || ds[0].Kind != rt.ErrorValidation || ds[0].Location != "query" || ds[0].Parameter != "a/b" {
			t.Fatalf("inherited parameter %+v", ds)
		}
	}
}

func TestHTTPCompleteValidationListAndBoundedDetails(t *testing.T) {
	es := generatedViolations(t)
	err := &rt.MultiError{Errors: []error{
		&rt.RequestError{Kind: rt.ErrContentType, Location: "header", Name: "Content-Type", Err: errors.New("bad content type")},
		fmt.Errorf("data: %w", errors.Join(rt.WithPath("first", es), rt.WithPath("second", es))),
	}}
	for _, r := range []struct {
		h       func(http.ResponseWriter, *http.Request, error)
		details int
	}{{rt.DefaultRequestErrorHandler, 0}, {rt.DetailedRequestErrorHandler(2), 2}} {
		status, p, _ := bodyProblem(t, r.h, err)
		if status != 415 || p.Status != 415 || p.Detail != err.Error() || len(p.Details) != r.details || !slices.Equal(paths(p.Errors), []string{"/first/sku", "/first/qty", "/second/sku", "/second/qty"}) {
			t.Errorf("HTTP response %+v", p)
		}
	}
}
