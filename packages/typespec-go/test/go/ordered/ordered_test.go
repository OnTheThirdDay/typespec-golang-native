package gen

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"example.com/gen/tsgo"
)

func TestDecodeMutateEncodeKeepsOrder(t *testing.T) {
	in := `{"plain":{"z":1,"a":2,"m":3},"nested":{"y":{"b":"1","a":"2"},"x":{}},"anything":{"q":[1,{"k":true}],"p":null},"models":{"second":{"n":7},"first":{}},"either":{"b":"1","a":"2"}}`
	var d Doc
	if err := json.Unmarshal([]byte(in), &d); err != nil {
		t.Fatal(err)
	}
	if strings.Join(d.Plain.Keys(), ",") != "z,a,m" {
		t.Fatal(d.Plain.Keys())
	}
	out, err := json.Marshal(d)
	if err != nil || string(out) != in {
		t.Fatalf("\n got %s\nwant %s (%v)", out, in, err)
	}
	d.Plain.Set("b", 4) // appended
	d.Plain.Set("z", 9) // replaced in place
	d.Plain.Delete("a")
	if got := string(mustJSON(t, d)); !strings.HasPrefix(got, `{"plain":{"z":9,"m":3,"b":4}`) {
		t.Fatal(got)
	}
	// An OrderedMap marshalled on its own (encoding/json) keeps its entries and order too.
	if got := string(mustJSON(t, d.Plain)); got != `{"z":9,"m":3,"b":4}` {
		t.Fatal(got)
	}
	var back tsgo.OrderedMap[int32]
	if err := json.Unmarshal([]byte(`{"y":1,"x":2}`), &back); err != nil || strings.Join(back.Keys(), ",") != "y,x" {
		t.Fatalf("%v %v", back.Keys(), err)
	}
	if rec, ok := d.Either.AsStringMap(); !ok || strings.Join(rec.Keys(), ",") != "b,a" {
		t.Fatalf("%+v", d.Either)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestDefaultsAndValidation(t *testing.T) {
	var d Doc
	if err := json.Unmarshal([]byte(`{"plain":{},"models":{"b":{},"a":{"n":-1}}}`), &d); err != nil {
		t.Fatal(err)
	}
	d.ApplyDefaults()
	if got := string(mustJSON(t, d)); got != `{"plain":{},"models":{"b":{"n":5},"a":{"n":-1}},"withDefault":{"z":1,"a":2,"m":3}}` {
		t.Fatal(got)
	}
	var ves tsgo.ValidationErrors
	if err := d.Validate(); !errors.As(err, &ves) || len(ves) != 1 || ves[0].Path != "/models/a/n" {
		t.Fatalf("%v", err)
	}
	if err := json.Unmarshal([]byte(`{"plain":{"a":1,"a":2}}`), &d); err == nil {
		t.Fatal("duplicate key accepted")
	}
}

func TestAdditionalPropertiesKeepOrder(t *testing.T) {
	var o Open
	if err := json.Unmarshal([]byte(`{"z":1,"id":"x","a":2}`), &o); err != nil {
		t.Fatal(err)
	}
	if strings.Join(o.AdditionalProperties.Keys(), ",") != "z,a" {
		t.Fatal(o.AdditionalProperties.Keys())
	}
	if got := string(mustJSON(t, o)); got != `{"id":"x","z":1,"a":2}` {
		t.Fatal(got)
	}
	o.AdditionalProperties.Set("id", 3)
	if _, err := json.Marshal(o); err == nil {
		t.Fatal("additional property colliding with a declared one was written")
	}
}

type srv struct{}

func (srv) Echo(ctx context.Context, r EchoRequestObject) (EchoResponseObject, error) {
	return Echo200JSONResponse{Body: r.Body}, nil
}

func (srv) Open(ctx context.Context, r OpenRequestObject) (OpenResponseObject, error) {
	return Open200JSONResponse{Body: r.Body}, nil
}

func TestServerKeepsOrder(t *testing.T) {
	body := `{"plain":{"z":1,"a":2},"withDefault":{"y":1,"b":2}}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/doc", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	NewHandler(srv{}, ServerOptions{}).ServeHTTP(rec, req)
	got, _ := io.ReadAll(rec.Body)
	if rec.Code != 200 || strings.TrimSpace(string(got)) != body {
		t.Fatalf("%d %s", rec.Code, got)
	}
}

func (srv) XML(ctx context.Context, r XMLRequestObject) (XMLResponseObject, error) {
	return XML200XMLResponse{Body: r.Body}, nil
}

func TestXMLRecordsKeepWireOrder(t *testing.T) {
	const inner = `<z>last</z><a>first</a>`
	document := func(entries string) string {
		return `<XMLRecords><scalars>` + entries + `</scalars><models><y id="1"/><b id="2"/></models></XMLRecords>`
	}
	for _, tc := range []struct {
		entries string
		status  int
	}{{inner, 200}, {inner + "<a>duplicate</a>", 400}, {inner + "text", 400}, {`<q:a xmlns:q="other">x</q:a>`, 400}} {
		req := httptest.NewRequest("POST", "/xml", strings.NewReader(document(tc.entries)))
		req.Header.Set("Content-Type", "application/xml")
		w := httptest.NewRecorder()
		NewHandler(srv{}, ServerOptions{ValidateResponses: true}).ServeHTTP(w, req)
		if w.Code != tc.status || tc.status == 200 && w.Body.String() != xml.Header+document(inner) {
			t.Fatalf("status %d, body %s", w.Code, w.Body)
		}
	}
	for _, bad := range []string{
		strings.Replace(document(inner), "<scalars>", `<scalars id="extra">`, 1),
		strings.Replace(document(inner), `<y id="1"/>`, `<y id="1"><extra/></y>`, 1),
	} {
		req := httptest.NewRequest("POST", "/xml", strings.NewReader(bad))
		req.Header.Set("Content-Type", "application/xml")
		w := httptest.NewRecorder()
		NewHandler(srv{}, ServerOptions{}).ServeHTTP(w, req)
		if w.Code != 400 {
			t.Fatalf("accepted %s: %d", bad, w.Code)
		}
	}
}
