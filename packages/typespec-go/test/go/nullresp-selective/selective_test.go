package gen

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

type srv struct{}

var lastShared *Shared

func (srv) Shared(ctx context.Context, r SharedRequestObject) (SharedResponseObject, error) {
	lastShared = &r.Body
	return Shared200JSONResponse{Body: r.Body}, nil
}

func (srv) Read(ctx context.Context, r ReadRequestObject) (ReadResponseObject, error) {
	return Read200JSONResponse{Body: Item{Inner: &Inner{}, List: &[]Inner{{}}, Other: &Other{}, Derived: &Derived{}}}, nil
}

func (srv) Echo(ctx context.Context, r EchoRequestObject) (EchoResponseObject, error) {
	return Echo200JSONResponse{Body: r.Body}, nil
}

func (srv) Page(ctx context.Context, r PageRequestObject) (PageResponseObject, error) {
	return Page200JSONResponse{Body: PageInner{Items: []Inner{{}}}}, nil
}

func call(t *testing.T, method, path, body string) string {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	NewHandler(srv{}, ServerOptions{}).ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("%s %s: %d %s", method, path, rec.Code, rec.Body)
	}
	b, _ := io.ReadAll(rec.Body)
	return strings.TrimSpace(string(b))
}

func TestOnlySelectedPropertiesAreWrittenAsNull(t *testing.T) {
	// Item.a (property), Other (model), Base.b (inherited by Derived); not Item.b, Inner, Derived.d, Base.c.
	if got := call(t, "GET", "/item", ""); got != `{"a":null,"inner":{},"list":[{}],"other":{"z":null},"derived":{"b":null}}` {
		t.Fatal(got)
	}
	// A template selected by its declaration name applies to every instance.
	if got := call(t, "GET", "/page", ""); got != `{"items":[{}],"next":null}` {
		t.Fatal(got)
	}
}

func TestSelectedModelSharedWithRequests(t *testing.T) {
	// Request decoding keeps absent and null apart; only the response writes the unset one as null.
	if got := call(t, "POST", "/shared", `{}`); got != `{"s":null}` || lastShared.S != nil {
		t.Fatalf("%s %+v", got, lastShared)
	}
	if got := call(t, "POST", "/shared", `{"s":null}`); got != `{"s":null}` || lastShared.S == nil || !lastShared.S.IsNull() {
		t.Fatalf("%s %+v", got, lastShared)
	}
	if b, _ := json.Marshal(Shared{}); string(b) != `{}` {
		t.Fatal(string(b))
	}
}

func TestModelsReusedByRequestsAreUnchanged(t *testing.T) {
	if got := call(t, "POST", "/inner", `{}`); got != `{}` {
		t.Fatal(got)
	}
	if got := call(t, "POST", "/inner", `{"x":null}`); got != `{"x":null}` {
		t.Fatal(got)
	}
	if _, ok := any(Inner{}).(interface{ MarshalResponseJSON() ([]byte, error) }); ok {
		t.Fatal("an unselected model has a response encoding")
	}
	// Standalone serialization is unchanged for selected models too.
	if b, _ := json.Marshal(Item{Other: &Other{}}); string(b) != `{"other":{}}` {
		t.Fatal(string(b))
	}
}
