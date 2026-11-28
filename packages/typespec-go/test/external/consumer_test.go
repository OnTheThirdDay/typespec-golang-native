package consumer

// The consumer package imports Shop.Common from the independently generated shared package:
// the Go types are the shared ones (compile-time identity), and decoding, defaults, validation
// and the HTTP contract behave as if they were generated here.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	shared "example.com/shared"
	"example.com/shared/tsgo"
)

func TestSharedTypeIdentity(t *testing.T) {
	var o Order
	var _ shared.ID = o.ID
	var _ shared.Money = o.Total
	var _ *tsgo.Nullable[shared.Status] = o.Status
	var _ shared.WidgetShape = o.Shape // anonymous union of an alias, identified by its fingerprint
	var _ []shared.PetUnion = o.Pets
	var _ *shared.Widget = o.Widget
	var _ *shared.PageWidget = o.Page
	var _ *shared.Closed = o.Closed
	var _ *PageOrder = o.History // template instance over a consumer type: generated here
	var _ *shared.Labels = o.Labels
	// Values cross the package boundary without conversion.
	w := shared.Widget{Name: "w", Price: shared.Money{Currency: "EUR"}, Kind: shared.WidgetKindA}
	o.Widget = &w
	create := WidgetCreate{Price: w.Price, Kind: w.Kind}
	_ = create
}

func TestSharedSemantics(t *testing.T) {
	in := `{"id":7,"total":{"amount":1.50,"currency":"EUR"},"status":null,"shape":{"square":2},` +
		`"pets":[{"kind":"dog","name":"rex","bark":true},{"kind":"bird","name":"tweety"}],"widget":{"id":"1","name":"w","price":{"amount":1,"currency":"usd"},"kind":"a"},"closed":{"a":"x"}}`
	var o Order
	if err := json.Unmarshal([]byte(in), &o); err != nil {
		t.Fatal(err)
	}
	if id, ok := o.ID.AsInt64(); !ok || id != 7 {
		t.Fatalf("%+v", o.ID)
	}
	if !o.Status.IsNull() || o.Shape.Kind() != shared.WidgetShapeKindObject1 {
		t.Fatalf("%+v", o)
	}
	if dog, ok := o.Pets[0].AsDog(); !ok || !dog.Bark {
		t.Fatalf("%+v", o.Pets[0])
	}
	if _, ok := o.Pets[1].AsBase(); !ok {
		t.Fatalf("undeclared discriminator: %+v", o.Pets[1])
	}
	// Defaults of shared types apply through the consumer's model.
	o.ApplyDefaults()
	if o.Widget.Status == nil || *o.Widget.Status != shared.StatusActive {
		t.Fatalf("%+v", o.Widget)
	}
	// Validation of shared types, with paths from the consumer's root.
	var ves tsgo.ValidationErrors
	if err := o.Validate(); !errors.As(err, &ves) || len(ves) != 1 || ves[0].Path != "/widget/price/currency" || ves[0].Constraint != "pattern" {
		t.Fatalf("%v", err)
	}
	// Closed shared models stay closed.
	if err := json.Unmarshal([]byte(strings.Replace(in, `{"a":"x"}`, `{"a":"x","b":1}`, 1)), &o); err == nil {
		t.Fatal("closed shared model accepted an undeclared property")
	}
	out, err := json.Marshal(Order{ID: shared.NewIDString("x"), Total: shared.Money{Currency: "EUR"}, Shape: shared.NewWidgetShapeObject(shared.WidgetShapeObject{Circle: 1}), Pets: []shared.PetUnion{}})
	if err != nil || !strings.HasPrefix(string(out), `{"id":"x",`) || !strings.HasSuffix(string(out), `"shape":{"circle":1},"pets":[]}`) {
		t.Fatalf("%s %v", out, err)
	}
}

type server struct{ created *WidgetCreate }

func (s *server) Create(ctx context.Context, r CreateRequestObject) (CreateResponseObject, error) {
	return Create200JSONResponse{Body: Order{}}, nil
}

func (s *server) CreateWidget(ctx context.Context, r CreateWidgetRequestObject) (CreateWidgetResponseObject, error) {
	s.created = &r.Body
	return CreateWidget200JSONResponse{Body: shared.Widget{ID: "new", Name: r.Body.Name, Price: r.Body.Price, Kind: r.Body.Kind, Status: r.Body.Status}}, nil
}

func (s *server) Audit(ctx context.Context, r AuditRequestObject) (AuditResponseObject, error) {
	return Audit200JSONResponse{Body: shared.Audited{ID: "a", Plain: r.Body.Plain, Stamped: shared.AuditedStamped{V: r.Body.Stamped.V, At: "now"}}}, nil
}

func TestSharedNamedArrays(t *testing.T) {
	// The array model's own constraint and its items' (a shared pattern) apply through the
	// consumer's validation, with paths at the consumer's position.
	o := Order{Labels: &shared.Labels{"EUR", "usd", "AUD"}}
	var ves tsgo.ValidationErrors
	if err := o.Validate(); !errors.As(err, &ves) {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, v := range ves {
		got[v.Path] = v.Constraint
	}
	if got["/labels"] != "maxItems" || got["/labels/1"] != "pattern" {
		t.Fatalf("%v", got)
	}
	var back Order
	if err := json.Unmarshal([]byte(`{"id":"x","total":{"amount":1,"currency":"EUR"},"shape":{"circle":1},"pets":[],"labels":["EUR"]}`), &back); err != nil || len(*back.Labels) != 1 {
		t.Fatalf("%v %v", err, back.Labels)
	}
}

func TestAnonymousTypesKeepTheirIdentity(t *testing.T) {
	// The Create projection is generated here; its unchanged anonymous member is the shared type,
	// although Twins declares three structurally identical anonymous members.
	var c AuditedCreate
	var _ shared.AuditedPlain = c.Plain
	var _ AuditedStampedCreate = c.Stamped
	var o Order
	var _ *shared.Twins = o.Twins
	var tw shared.Twins
	var _ shared.TwinsLeft = tw.Left
	var _ shared.TwinsRight = tw.Right
}

func (s *server) ListWidgets(ctx context.Context, r ListWidgetsRequestObject) (ListWidgetsResponseObject, error) {
	return ListWidgets200JSONResponse{Body: shared.PageWidget{Items: []shared.Widget{}, Total: 0}}, nil
}

func TestHTTPContractWithSharedTypes(t *testing.T) {
	s := &server{}
	h := NewHandler(s, ServerOptions{})
	do := func(method, path, body string, header ...string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		for i := 0; i+1 < len(header); i += 2 {
			req.Header.Set(header[i], header[i+1])
		}
		h.ServeHTTP(rec, req)
		return rec
	}
	// The create variant of a shared model is generated here; its nested types are the shared ones.
	rec := do("POST", "/widgets", `{"id":"client","name":"w","price":{"amount":1,"currency":"EUR"},"kind":"b"}`)
	if rec.Code != http.StatusOK || s.created == nil || s.created.Kind != shared.WidgetKindB || *s.created.Status != shared.StatusActive {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), `"id":"new"`) {
		t.Fatal(rec.Body.String())
	}
	// Shared enums and scalars as parameters: their text form comes from the shared package.
	if rec := do("GET", "/widgets?status=retired", "", "x-currency", "EUR"); rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if rec := do("GET", "/widgets?status=bogus", ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("%d", rec.Code)
	}
	if rec := do("GET", "/widgets", "", "x-currency", "euro"); rec.Code != http.StatusBadRequest {
		t.Fatalf("pattern of a shared scalar parameter not checked: %d", rec.Code)
	}
	if rec := do("POST", "/widgets", `{"name":"w","price":{"amount":1,"currency":"eur"},"kind":"b"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("validation of a shared nested type: %d", rec.Code)
	}
}

func TestDistinctTemplateArgumentDeclarations(t *testing.T) {
	var s Shipment
	var _ shared.Deliveries = s.Packages
	left, right := reflect.TypeOf(s.Packages.First), reflect.TypeOf(s.Packages.Second)
	if left == right || left.PkgPath() != "example.com/shared" || right.PkgPath() != left.PkgPath() {
		t.Fatalf("shared instantiations %s and %s", left, right)
	}
	if reflect.TypeOf(s.Packages.First.Inner) == reflect.TypeOf(s.Packages.Second.Inner) {
		t.Fatal("distinct argument declarations shared the same nested type")
	}
	data := `{"packages":{"first":{"value":{"code":"a"},"inner":{"value":{"code":"b"}}},"second":{"value":{"code":"c"},"inner":{"value":{"code":"d"}}}}}`
	if err := json.Unmarshal([]byte(data), &s); err != nil {
		t.Fatal(err)
	}
	out, err := json.Marshal(s)
	if err != nil || string(out) != data {
		t.Fatalf("%s %v", out, err)
	}
}
