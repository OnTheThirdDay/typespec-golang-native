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

var ErrReserved = errors.New("the id is reserved")

// Application-defined checks (validation-hooks): they run after decoding and the generated checks.
func (m Order) ValidateExtension(v *tsgo.Validator) {
	if m.ID == "forbidden" {
		v.At("id").AddError("reserved-id", ErrReserved)
	}
}

func (l *Line) ValidateExtension(v *tsgo.Validator) {
	if l.SKU == "XX" {
		v.At("sku").Add("sku-format", "sku XX is not allowed")
	}
}

func (c Code) ValidateExtension(v *tsgo.Validator) {
	if c == "BAD" {
		v.Add("blocklist", "code %s is blocked", string(c))
	}
}

type srv struct{}

func (srv) Create(ctx context.Context, r CreateRequestObject) (CreateResponseObject, error) {
	return Create200JSONResponse{Body: r.Body}, nil
}

func post(t *testing.T, opts ServerOptions, query, body string) (int, error, string) {
	t.Helper()
	var got error
	handler := opts.RequestErrorHandler
	if handler == nil {
		handler = tsgo.DefaultRequestErrorHandler
		if opts.ErrorDetails {
			handler = tsgo.DetailedRequestErrorHandler(opts.MaxErrors)
		}
	}
	opts.RequestErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		got = err
		handler(w, r, err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/orders"+query, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	NewHandler(srv{}, opts).ServeHTTP(rec, req)
	return rec.Code, got, rec.Body.String()
}

const manyErrors = `{"id":1,"lines":[{"sku":5,"qty":"x"},{"sku":"ok","qty":1}],"meta":{"a":"no","b":2},"kind":"z"}`

func TestFailFastByDefault(t *testing.T) {
	code, err, _ := post(t, ServerOptions{}, "", manyErrors)
	var de *tsgo.DecodeError
	if code != 400 || !errors.As(err, &de) || de.Path != "/id" {
		t.Fatalf("%d %v", code, err)
	}
	if d := tsgo.Details(err, 0); len(d) != 1 || d[0].Kind != tsgo.ErrorDecode || d[0].Location != "body" || d[0].Path != "/id" || string(d[0].Value.(json.RawMessage)) != "1" {
		t.Fatalf("%+v", d)
	}
}

func TestCollectErrors(t *testing.T) {
	_, err, _ := post(t, ServerOptions{CollectErrors: true}, "", manyErrors)
	// The message and errors.As are those of the first failure, as in fail-fast mode.
	var de *tsgo.DecodeError
	if !errors.As(err, &de) || de.Path != "/id" || !strings.HasPrefix(err.Error(), "body: /id:") {
		t.Fatalf("%v", err)
	}
	var paths []string
	for _, d := range tsgo.Details(err, 0) {
		if d.Kind != tsgo.ErrorDecode || d.Location != "body" {
			t.Fatalf("%+v", d)
		}
		paths = append(paths, d.Path)
	}
	if strings.Join(paths, " ") != "/id /lines/0/sku /lines/0/qty /meta/a /kind" {
		t.Fatalf("%v", paths)
	}
}

func TestValidationDetails(t *testing.T) {
	_, err, _ := post(t, ServerOptions{CollectErrors: true}, "", `{"id":"o","lines":[{"sku":"a","qty":0}],"code":"abc"}`)
	want := map[string][2]any{"/body/lines/0/sku": {"minLength", 2}, "/body/lines/0/qty": {"minimum", int32(1)}, "/body/code": {"pattern", "^[A-Z]+$"}}
	d := tsgo.Details(err, 0)
	if len(d) != len(want) {
		t.Fatalf("%+v", d)
	}
	for _, x := range d {
		w, ok := want[x.Path]
		if !ok || x.Kind != tsgo.ErrorValidation || x.Constraint != w[0] || x.Limit != w[1] || x.Value == nil {
			t.Fatalf("%+v", x)
		}
	}
}

func TestUnionAndParameterDetails(t *testing.T) {
	_, err, _ := post(t, ServerOptions{CollectErrors: true}, "", `{"id":"o","lines":[],"shape":{"c":true}}`)
	d := tsgo.Details(err, 0)
	if len(d) != 1 || d[0].Path != "/shape" || strings.Join(d[0].Variants, ",") != "Object,Object1" {
		t.Fatalf("%+v", d)
	}
	_, err, _ = post(t, ServerOptions{}, "?limit=x", `{"id":"o","lines":[]}`)
	d = tsgo.Details(err, 0)
	if len(d) != 1 || d[0].Kind != tsgo.ErrorParameter || d[0].Location != "query" || d[0].Parameter != "limit" {
		t.Fatalf("%+v", d)
	}
}

func TestDetailedProblemResponse(t *testing.T) {
	code, _, body := post(t, ServerOptions{CollectErrors: true, ErrorDetails: true}, "", manyErrors)
	var p tsgo.Problem
	if code != 400 || json.Unmarshal([]byte(body), &p) != nil || len(p.Details) != 5 || p.Details[0].Kind != "decode" {
		t.Fatalf("%d %s", code, body)
	}
	// Without the option the problem document is unchanged.
	_, _, body = post(t, ServerOptions{}, "", manyErrors)
	if strings.Contains(body, `"details"`) {
		t.Fatal(body)
	}
}

func TestValidationHooks(t *testing.T) {
	code, err, _ := post(t, ServerOptions{}, "", `{"id":"forbidden","lines":[{"sku":"XX","qty":1}],"code":"BAD"}`)
	if code != 400 || !errors.Is(err, ErrReserved) {
		t.Fatalf("%d %v", code, err)
	}
	got := map[string]string{}
	for _, d := range tsgo.Details(err, 0) {
		got[d.Path] = d.Constraint
	}
	want := map[string]string{"/body/id": "reserved-id", "/body/lines/0/sku": "sku-format", "/body/code": "blocklist"}
	for p, c := range want {
		if got[p] != c {
			t.Fatalf("%v", got)
		}
	}
	// Hooks only add errors: a valid value passes them.
	if code, err, _ := post(t, ServerOptions{}, "", `{"id":"ok","lines":[{"sku":"AB","qty":1}],"code":"OK"}`); code != 200 {
		t.Fatalf("%d %v", code, err)
	}
}

func TestCollectionIsBounded(t *testing.T) {
	items := strings.TrimSuffix(strings.Repeat(`{"sku":1,"qty":1},`, 500), ",")
	_, err, _ := post(t, ServerOptions{CollectErrors: true}, "", `{"id":"o","lines":[`+items+`]}`)
	if n := len(tsgo.Details(err, 1000)); n != tsgo.MaxCollectedErrors {
		t.Fatalf("%d details", n)
	}
	if n := len(tsgo.Details(err, 10)); n != 10 {
		t.Fatalf("%d details", n)
	}
}
