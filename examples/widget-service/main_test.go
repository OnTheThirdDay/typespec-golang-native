package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWidgetLifecycle(t *testing.T) {
	ts := httptest.NewServer(newHandler("t"))
	defer ts.Close()
	call := func(method, path, body string) (int, string) {
		req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer t")
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	if code, body := call("POST", "/widgets", `{"name":"Gizmo","color":"blue"}`); code != 201 || !strings.Contains(body, `"weightGrams":100`) {
		t.Fatalf("%d %s", code, body)
	}
	if code, _ := call("POST", "/widgets", `{"name":"","color":"blue"}`); code != 400 {
		t.Fatal("invalid widget accepted")
	}
	if code, body := call("GET", "/widgets?color=blue", ""); code != 200 || !strings.Contains(body, "Gizmo") {
		t.Fatalf("%d %s", code, body)
	}
	if code, _ := call("GET", "/widgets/42", ""); code != 404 {
		t.Fatal("missing widget")
	}
}

func TestParseSuggestion(t *testing.T) {
	s, err := ParseSuggestion([]byte(`{"name":"Gizmo","color":"red","weight_grams":null,"confidence":0.9}`))
	if err != nil || s.Name != "Gizmo" || !s.WeightGrams.IsNull() {
		t.Fatal(s, err)
	}
	if _, err := ParseSuggestion([]byte(`{"name":"Gizmo","color":"purple","weight_grams":1,"confidence":0.9}`)); err == nil {
		t.Fatal("undeclared enum value accepted")
	}
}
