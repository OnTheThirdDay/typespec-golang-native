package gen

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"example.com/gen/tsgo"
)

// Application checks (validation-hooks). Every call is recorded with its position, so that the
// tests can tell which values they ran on.
var (
	mu    sync.Mutex
	calls []string
)

func record(kind string, v *tsgo.Validator) {
	mu.Lock()
	defer mu.Unlock()
	calls = append(calls, kind+"@"+v.Path())
}

func takeCalls() []string {
	mu.Lock()
	defer mu.Unlock()
	c := calls
	calls = nil
	return c
}

var ErrNote = errors.New("notes must not mention secrets")

func (o Order) ValidateExtension(v *tsgo.Validator) {
	record("Order", v)
	if o.Note != nil && strings.Contains(*o.Note, "secret") {
		v.At("note").AddErrorValue("no-secrets", *o.Note, ErrNote)
	}
}

func (i Item) ValidateExtension(v *tsgo.Validator) {
	record("Item", v)
	if i.SKU == "XX" {
		v.At("sku").AddLimit("sku-blocklist", []string{"XX"}, i.SKU, "sku %s is blocked", i.SKU)
	}
}

func (c Cat) ValidateExtension(v *tsgo.Validator) { record("Cat", v) }

func (a FlexA) ValidateExtension(v *tsgo.Validator) {
	record("FlexA", v)
	if a.N == 5 {
		v.At("n").Add("flex-hook", "5 is reserved")
	}
}

type srv struct{}

func (srv) Create(ctx context.Context, r CreateRequestObject) (CreateResponseObject, error) {
	return Create200JSONResponse{Body: r.Body}, nil
}

func (srv) SelectA(ctx context.Context, r SelectARequestObject) (SelectAResponseObject, error) {
	return SelectA204Response{}, nil
}

func (srv) SelectB(ctx context.Context, r SelectBRequestObject) (SelectBResponseObject, error) {
	return SelectB204Response{}, nil
}

func (srv) UploadJSON(ctx context.Context, r UploadJSONRequestObject) (UploadJSONResponseObject, error) {
	return UploadJSON204Response{}, nil
}

func (srv) UploadText(ctx context.Context, r UploadTextRequestObject) (UploadTextResponseObject, error) {
	return UploadText204Response{}, nil
}

func post(t *testing.T, opts ServerOptions, query string, header map[string]string, body string) (int, error) {
	t.Helper()
	return send(t, opts, "POST", "/orders"+query, header, body)
}

func send(t *testing.T, opts ServerOptions, method, target string, header map[string]string, body string) (int, error) {
	t.Helper()
	var got error
	opts.RequestErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		got = err
		tsgo.DefaultRequestErrorHandler(w, r, err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range header {
		req.Header.Set(k, v)
	}
	takeCalls()
	NewHandler(srv{}, opts).ServeHTTP(rec, req)
	return rec.Code, got
}

var collect = ServerOptions{CollectErrors: true}

// summary lists details as path:kind:constraint (and :variant when identified).
func summary(err error) []string {
	var out []string
	for _, d := range tsgo.Details(err, 0) {
		s := d.Path + ":" + string(d.Kind) + ":" + d.Constraint
		if d.Variant != "" {
			s += ":" + d.Variant
		}
		out = append(out, s)
	}
	return out
}

func expect(t *testing.T, err error, want ...string) {
	t.Helper()
	if got := summary(err); !slices.Equal(got, want) {
		t.Fatalf("details\n got %q\nwant %q\nerror: %v", got, want, err)
	}
}

func detail(t *testing.T, err error, path string) tsgo.ErrorDetail {
	t.Helper()
	for _, d := range tsgo.Details(err, 0) {
		if d.Path == path {
			return d
		}
	}
	t.Fatalf("no detail at %s: %q", path, summary(err))
	return tsgo.ErrorDetail{}
}

// #16: every failure of an identified union variant is kept, with its path and the variant.
func TestIdentifiedVariantKeepsEveryFailure(t *testing.T) {
	body := `{"id":"abc","items":[],"pet":{"kind":"cat","name":1,"age":"x"}}`
	_, err := post(t, collect, "", nil, body)
	expect(t, err, "/pet/name:decode:type:Cat", "/pet/age:decode:type:Cat")
	if d := detail(t, err, "/pet/age"); len(d.Unions) != 1 || d.Unions[0] != (tsgo.UnionChoice{Path: "/pet", Variant: "Cat"}) {
		t.Fatalf("%+v", d.Unions)
	}
	// Fail-fast reporting keeps the first failure, as before.
	_, err = post(t, ServerOptions{}, "", nil, body)
	if expect(t, err, "/pet/name:decode:type:Cat"); err.Error() != "body: /pet/name: expected string, got number (union variant Cat)" {
		t.Fatal(err)
	}
	// Directly: errors.As finds the variant of the first failure; the error lists both.
	var o Order
	err = json.Unmarshal([]byte(body), &o)
	var ve *tsgo.VariantError
	var me *tsgo.MultiError
	if !errors.As(err, &ve) || ve.Variant != "Cat" || !errors.As(err, &me) || len(me.Errors) != 2 {
		t.Fatalf("%#v", err)
	}
}

func TestNestedUnionsReportEveryVariant(t *testing.T) {
	_, err := post(t, collect, "", nil, `{"id":"abc","items":[],"tree":{"kind":"branch","inner":{"code":5},"weight":"x"}}`)
	expect(t, err, "/tree/inner/code:decode:type:Leaf", "/tree/weight:decode:type:Branch")
	d := detail(t, err, "/tree/inner/code")
	want := []tsgo.UnionChoice{{Path: "/tree", Variant: "Branch"}, {Path: "/tree/inner", Variant: "Leaf"}}
	if !slices.Equal(d.Unions, want) {
		t.Fatalf("%+v", d.Unions)
	}
}

func TestDiscriminatedVariantsKeepMessagesAndPaths(t *testing.T) {
	_, err := post(t, collect, "", nil, `{"id":"abc","items":[],"event":{"kind":"created","data":{"id":"x","at":"y"}},"shape":{"type":"circle","radius":"r","label":"long"}}`)
	// The decoded parts of identified variants are validated where their values are.
	expect(t, err, "/shape/radius:decode:type:Circle", "/event/data/at:decode:type:Created",
		"/body/shape/label:validation:maxLength", "/body/event/data/id:validation:minLength")
	if msg := detail(t, err, "/event/data/at").Message; msg != "expected integer, got string" && msg != "expected number, got string" {
		t.Fatal(msg) // the discriminator names the variant: messages are unchanged
	}
}

// #17: stable kinds and metadata of decoding failures.
func TestDecodingProblemsAreData(t *testing.T) {
	_, err := post(t, collect, "", nil, `{"items":"no","color":"blue","small":300,"fixed":"v2","shape":{"type":"triangle"},"pair":[{"sku":"ab","qty":1}],"note":5,"tree":{"kind":"leaf"}}`)
	expect(t, err,
		"/id:decode:required",
		"/items:decode:type",
		"/tree/kind:decode:discriminator",
		"/color:decode:enum",
		"/small:decode:range",
		"/shape/type:decode:discriminator",
		"/pair:decode:items",
		"/fixed:decode:literal",
		"/note:decode:type",
	)
	if d := detail(t, err, "/items"); d.Expected != "array" || d.Got != "string" || string(d.Value.(json.RawMessage)) != `"no"` {
		t.Fatalf("%+v", d)
	}
	if d := detail(t, err, "/color"); fmt.Sprint(d.Allowed) != "[red green]" {
		t.Fatalf("%+v", d)
	}
	if d := detail(t, err, "/small"); d.Expected != "uint8" || d.Minimum != uint64(0) || d.Maximum != uint64(255) {
		t.Fatalf("%+v", d)
	}
	if d := detail(t, err, "/fixed"); fmt.Sprint(d.Allowed) != "[v1]" {
		t.Fatalf("%+v", d)
	}
	if d := detail(t, err, "/shape/type"); fmt.Sprint(d.Allowed) != "[circle square]" {
		t.Fatalf("%+v", d)
	}
	if d := detail(t, err, "/tree/kind"); fmt.Sprint(d.Allowed) != "[branch tip]" || len(d.Variants) != 2 {
		t.Fatalf("%+v", d)
	}
	if d := detail(t, err, "/pair"); d.Minimum != 2 || d.Maximum != 2 {
		t.Fatalf("%+v", d)
	}
	// errors.As reaches the problem from any error.
	var p *tsgo.DecodeProblem
	if !errors.As(err, &p) || p.Kind != tsgo.ProblemRequired {
		t.Fatalf("%v", p)
	}
	// The problem document carries the metadata.
	rec := httptest.NewRecorder()
	tsgo.DetailedRequestErrorHandler(0)(rec, httptest.NewRequest("POST", "/", nil), err)
	for _, s := range []string{`"constraint":"range"`, `"expected":"uint8"`, `"maximum":255`, `"allowed":["red","green"]`} {
		if !strings.Contains(rec.Body.String(), s) {
			t.Fatalf("%s missing in %s", s, rec.Body.String())
		}
	}
}

func TestParameterProblemsAreData(t *testing.T) {
	_, err := post(t, collect, "?limit=abc&color=blue", nil, `{"id":"abc","items":[]}`)
	expect(t, err, ":parameter:format", ":parameter:enum")
	if d := tsgo.Details(err, 0)[0]; d.Location != "query" || d.Parameter != "limit" || d.Expected != "int32" {
		t.Fatalf("%+v", d)
	}
	_, err = post(t, collect, "", nil, ``)
	expect(t, err, ":decode:required")
}

// #18: the values that decoded are validated although siblings failed.
func TestSiblingsOfFailuresAreValidated(t *testing.T) {
	body := `{"id":"ab","items":[{"sku":"x","qty":0},{"sku":5,"qty":0},{"sku":"XX","qty":1}],"note":1}`
	_, err := post(t, collect, "", nil, body)
	expect(t, err,
		"/items/1/sku:decode:type",
		"/note:decode:type",
		"/body/id:validation:minLength",
		"/body/items:validation:maxItems",
		"/body/items/0/sku:validation:minLength",
		"/body/items/0/qty:validation:minimum",
		"/body/items/1/qty:validation:minimum",
		"/body/items/2/sku:validation:sku-blocklist",
	)
	// Application checks ran on the items that decoded completely, not on the partial item 1
	// nor on the order (incomplete).
	if c := takeCalls(); !slices.Equal(c, []string{"Item@/body/items/0", "Item@/body/items/2"}) {
		t.Fatalf("%v", c)
	}
	if d := detail(t, err, "/body/items/2/sku"); d.Location != "body" || d.Value != "XX" || fmt.Sprint(d.Limit) != "[XX]" {
		t.Fatalf("%+v", d)
	}
	// Fail-fast: the first failure only, no validation.
	_, err = post(t, ServerOptions{}, "", nil, body)
	expect(t, err, "/items/1/sku:decode:type")
	if c := takeCalls(); len(c) != 0 {
		t.Fatalf("%v", c)
	}
}

func TestNoErrorsFromValuesThatDidNotDecode(t *testing.T) {
	// A missing required property (id has @minLength), a failed union (no variant), a failed
	// enum and a failed record value: their zero values are never checked.
	_, err := post(t, collect, "", nil, `{"items":[{"qty":1}],"pet":{"name":"x"},"color":1,"flex":{"n":"x"}}`)
	expect(t, err, "/id:decode:required", "/items/0/sku:decode:required", "/pet/kind:decode:discriminator", "/color:decode:type", "/flex:decode:union")
	if c := takeCalls(); len(c) != 0 {
		t.Fatalf("checks ran on values that did not decode: %v", c)
	}
}

func TestPartialTuplesAndTruncation(t *testing.T) {
	_, err := post(t, collect, "", nil, `{"id":"abc","items":[],"pair":[{"sku":"x","qty":1},"n"]}`)
	expect(t, err, "/pair/1:decode:type", "/body/pair/0/sku:validation:minLength")
	// Beyond MaxCollectedErrors the collection stops: the array counts as failed as a whole (its
	// later items were not decoded), so none of it is validated; its siblings still are.
	items := strings.TrimSuffix(strings.Repeat(`{"sku":1,"qty":0},`, 150), ",")
	_, err = post(t, collect, "", nil, `{"id":"ab","items":[`+items+`]}`)
	d := tsgo.Details(err, 1000)
	if len(d) != tsgo.MaxCollectedErrors+1 || d[len(d)-1].Path != "/body/id" {
		t.Fatalf("%d details, last %+v", len(d), d[len(d)-1])
	}
}

func TestApplicationChecksNeverSelectVariants(t *testing.T) {
	// FlexA decodes {"n":5} exactly: it is selected, then its check rejects the value (with hooks
	// taking part in selection, FlexB would have been selected and the request accepted).
	code, err := post(t, ServerOptions{}, "", nil, `{"id":"abc","items":[],"flex":{"n":5}}`)
	if code != 400 {
		t.Fatalf("%d %v", code, err)
	}
	expect(t, err, "/body/flex/n:validation:flex-hook")
	// The check ran once, on the selected variant, after decoding.
	if c := takeCalls(); !slices.Equal(c, []string{"FlexA@/body/flex", "Order@/body"}) {
		t.Fatalf("%v", c)
	}
	var o Order
	if err := json.Unmarshal([]byte(`{"id":"abc","items":[],"flex":{"n":5}}`), &o); err != nil || o.Flex.Kind() != FlexKindA {
		t.Fatalf("%v %v", err, o.Flex)
	}
	if c := takeCalls(); len(c) != 0 {
		t.Fatalf("checks ran while decoding: %v", c)
	}
}

func TestCustomErrorsCarryValues(t *testing.T) {
	_, err := post(t, collect, "", nil, `{"id":"abc","items":[],"note":"a secret"}`)
	expect(t, err, "/body/note:validation:no-secrets")
	if d := detail(t, err, "/body/note"); d.Value != "a secret" || !errors.Is(d.Err, ErrNote) || !errors.Is(err, ErrNote) {
		t.Fatalf("%+v", d)
	}
}

func TestParametersAreCollectedWithTheBody(t *testing.T) {
	q := "?limit=0&color=blue"
	h := map[string]string{"x-tag": "a"}
	body := `{"id":"ab","items":[{"sku":1,"qty":1}]}`
	_, err := post(t, collect, q, h, body)
	expect(t, err, ":parameter:enum", "/items/0/sku:decode:type",
		"/query:limit:validation:minimum", "/header:x-tag:validation:minLength", "/body/id:validation:minLength")
	if d := detail(t, err, "/query:limit"); d.Location != "query" || d.Parameter != "limit" {
		t.Fatalf("%+v", d)
	}
	var re *tsgo.RequestError
	if !errors.As(err, &re) || re.Location != "query" || re.Name != "color" {
		t.Fatalf("%v", err) // the message and errors.As target are the first failure's
	}
	_, err = post(t, ServerOptions{}, q, h, body)
	expect(t, err, ":parameter:enum")
}

func TestPartialValuesOutsideServers(t *testing.T) {
	data := []byte(`{"id":"ab","items":[{"sku":"x","qty":5},{"sku":true,"qty":1}]}`)
	var o Order
	err := json.Unmarshal(data, &o)
	if err == nil || o.ID != "" {
		t.Fatalf("%v %+v", err, o) // the target is unchanged on failure
	}
	p, ok := tsgo.Partial[Order](err)
	if !ok || p.ID != "ab" || len(p.Items) != 2 || p.Items[0].SKU != "x" || p.Items[1].Qty != 1 {
		t.Fatalf("%v %+v", ok, p)
	}
	if got := tsgo.FailedPaths(err); !slices.Equal(got, []string{"/items/1/sku"}) {
		t.Fatal(got)
	}
	all := tsgo.ValidateDecoded(err, p.ValidateWith)
	expect(t, all, "/items/1/sku:decode:type", "/id:validation:minLength", "/items/0/sku:validation:minLength")
	var de *tsgo.DecodeError
	if !errors.As(all, &de) || de.Path != "/items/1/sku" {
		t.Fatal(all)
	}
}

func TestTruncatedBodyNeverInvokesItemHooks(t *testing.T) {
	item := `{"sku":false,"qty":1}`
	body := `{"id":"abc","items":[` + strings.Repeat(item+",", tsgo.MaxCollectedErrors) + item + `]}`
	status, err := post(t, collect, "", nil, body)
	if status != 400 || err == nil {
		t.Fatalf("%d %v", status, err)
	}
	if c := takeCalls(); len(c) != 0 {
		t.Fatalf("hooks called %d times inside an undecoded collection: %s", len(c), c[0])
	}
}

func TestWideEnumErrorValuesAreExactJSON(t *testing.T) {
	const allowed = `"allowed":[9007199254740993,18446744073709551615]`
	var input WideInput
	decodeErr := json.Unmarshal([]byte(`{"value":2}`), &input)
	for _, err := range []error{decodeErr, (WideInput{Value: Wide(2)}).Validate()} {
		if err == nil {
			t.Fatal("accepted undeclared enum value")
		}
		w := httptest.NewRecorder()
		tsgo.DetailedRequestErrorHandler(1)(w, httptest.NewRequest("GET", "/", nil), err)
		if !json.Valid(w.Body.Bytes()) || !strings.Contains(w.Body.String(), allowed) || !strings.Contains(w.Body.String(), `"value":2`) {
			t.Fatalf("unexpected problem %s", w.Body)
		}
	}
	for _, raw := range []string{"9007199254740993", "18446744073709551615"} {
		data := `{"value":` + raw + "}"
		if err := json.Unmarshal([]byte(data), &input); err != nil {
			t.Fatal(err)
		}
		b, err := json.Marshal(input)
		if err != nil || string(b) != data {
			t.Fatalf("%s %v", b, err)
		}
	}
}

func TestTransportErrorsCollectIndependentValues(t *testing.T) {
	_, err := post(t, collect, "?limit=%zz", map[string]string{"x-tag": "x"}, `{"id":"a","items":[]}`)
	expect(t, err, ":parameter:format", "/header:x-tag:validation:minLength", "/body/id:validation:minLength")
	status, err := post(t, collect, "?limit=0", map[string]string{"Content-Type": "text/plain", "x-tag": "x"}, `not JSON`)
	if status != http.StatusUnsupportedMediaType {
		t.Fatalf("%d %v", status, err)
	}
	expect(t, err, ":content-type:", "/query:limit:validation:minimum", "/header:x-tag:validation:minLength")
	if c := takeCalls(); len(c) != 0 {
		t.Fatalf("hooks ran on a body with an unsupported media type: %v", c)
	}
}

func TestSelectionFailuresAreReportedAlone(t *testing.T) {
	// After selection, a malformed query is a format problem collected with the other values.
	status, err := send(t, collect, "GET", "/select?mode=a&limit=0", map[string]string{"x-tag": "x"}, "")
	if status != http.StatusBadRequest {
		t.Fatalf("%d %v", status, err)
	}
	expect(t, err, "/query:limit:validation:minimum", "/header:x-tag:validation:minLength")
	// The operation is selected by the literal query value: a malformed query ends the request
	// before any value is decoded, as a parameter error without a DecodeProblem.
	status, err = send(t, collect, "GET", "/select?mode=a&limit=%zz", map[string]string{"x-tag": "x"}, "")
	var problem *tsgo.DecodeProblem
	if status != http.StatusBadRequest || errors.As(err, &problem) {
		t.Fatalf("%d %v", status, err)
	}
	expect(t, err, ":parameter:")
	// No @sharedRoute operation accepts the media type: 415 alone, the query is not decoded.
	status, err = send(t, collect, "POST", "/upload?limit=0", map[string]string{"Content-Type": "image/png"}, "x")
	if status != http.StatusUnsupportedMediaType {
		t.Fatalf("%d %v", status, err)
	}
	expect(t, err, ":content-type:")
	// Once uploadJson is selected, its values are collected as usual.
	_, err = send(t, collect, "POST", "/upload?limit=0", nil, `{"sku":""}`)
	expect(t, err, "/qty:decode:required", "/query:limit:validation:minimum", "/body/sku:validation:minLength")
}
