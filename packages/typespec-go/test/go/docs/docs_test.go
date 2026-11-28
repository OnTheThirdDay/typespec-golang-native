package gen

import (
	"encoding/json"
	"testing"
)

func TestDocumentedTypesWork(t *testing.T) {
	var w Widget
	if err := json.Unmarshal([]byte(`{"name":"n","kind":"b"}`), &w); err != nil || w.Kind != KindB {
		t.Fatalf("%+v %v", w, err)
	}
	var s Shape
	if err := json.Unmarshal([]byte(`"x"`), &s); err != nil {
		t.Fatal(err)
	}
}
