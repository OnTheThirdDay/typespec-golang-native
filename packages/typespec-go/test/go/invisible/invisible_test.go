package gen

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type srv struct{ last any }

func (s *srv) Create(ctx context.Context, r CreateRequestObject) (CreateResponseObject, error) {
	s.last = r.Body
	return Create200JSONResponse{Body: WidgetRead{ID: "new", Name: r.Body.Name}}, nil
}

func (s *srv) Update(ctx context.Context, r UpdateRequestObject) (UpdateResponseObject, error) {
	s.last = r.Body
	return Update200JSONResponse{Body: WidgetRead{ID: r.ID, Name: "x"}}, nil
}

func (s *srv) Submit(ctx context.Context, r SubmitRequestObject) (SubmitResponseObject, error) {
	s.last = r.Body
	return Submit204Response{}, nil
}

func call(t *testing.T, s *srv, method, path, ct, body string) int {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", ct)
	NewHandler(s, ServerOptions{}).ServeHTTP(rec, req)
	return rec.Code
}

func TestVisibilityExcludedPropertiesAreAcceptedAndDiscarded(t *testing.T) {
	s := &srv{}
	// Read-only properties (top level, renamed, nested closed model) in a create request.
	body := `{"id":"client-chosen","name":"w","secret":"s","created_at":"2024-01-02T03:04:05Z","owner":{"ownerId":"o","name":"n"}}`
	if code := call(t, s, "POST", "/widgets", "application/json", body); code != http.StatusOK {
		t.Fatal(code)
	}
	got := s.last.(WidgetCreate)
	if got.Name != "w" || *got.Secret != "s" || got.Owner.Name != "n" {
		t.Fatalf("%+v", got)
	}
	// Discarded: WidgetCreate has no ID field; re-encoding does not reproduce it.
	out, _ := json.Marshal(got)
	if strings.Contains(string(out), "client-chosen") || strings.Contains(string(out), "ownerId") {
		t.Fatalf("%s", out)
	}
	// Create-only property in a merge patch: accepted and discarded.
	if code := call(t, s, "PATCH", "/widgets/1", "application/merge-patch+json", `{"secret":"s","id":"x","name":"m"}`); code != http.StatusOK {
		t.Fatal(code)
	}
	if out, _ := json.Marshal(s.last); strings.Contains(string(out), "secret") {
		t.Fatalf("%s", out)
	}
	if code := call(t, s, "POST", "/forms", "application/x-www-form-urlencoded", "name=f&id=7"); code != http.StatusNoContent || s.last.(FormCreate).Name != "f" {
		t.Fatal(code)
	}
}

func TestUndeclaredPropertiesAreStillRejected(t *testing.T) {
	s := &srv{}
	for _, c := range []struct{ method, path, ct, body string }{
		{"POST", "/widgets", "application/json", `{"name":"w","color":"red"}`},
		{"POST", "/widgets", "application/json", `{"name":"w","owner":{"name":"n","extra":1}}`},
		{"PATCH", "/widgets/1", "application/merge-patch+json", `{"name":"m","color":"red"}`},
		{"POST", "/forms", "application/x-www-form-urlencoded", "name=f&color=red"},
	} {
		if code := call(t, s, c.method, c.path, c.ct, c.body); code != http.StatusBadRequest {
			t.Fatalf("%s %s: %d", c.path, c.body, code)
		}
	}
	// Ignoring is not a type check either way, but the declared properties keep theirs.
	if code := call(t, s, "POST", "/widgets", "application/json", `{"name":5}`); code != http.StatusBadRequest {
		t.Fatal(code)
	}
}

func TestCanonicalModelsKeepEveryProperty(t *testing.T) {
	var w Widget
	if err := json.Unmarshal([]byte(`{"id":"1","name":"w","created_at":"2024-01-02T03:04:05Z"}`), &w); err != nil || w.ID != "1" || w.CreatedAt == nil {
		t.Fatalf("%+v %v", w, err)
	}
	if err := json.Unmarshal([]byte(`{"id":"1","name":"w","color":"red"}`), &w); err == nil {
		t.Fatal("closed canonical model accepted an undeclared property")
	}
}
