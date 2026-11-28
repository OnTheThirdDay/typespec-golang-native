package gen

import (
	"context"
	"io"
	"iter"
	"net/http/httptest"
	"testing"

	"example.com/gen/tsgo"
)

type srv struct{}

func (srv) Events(context.Context, EventsRequestObject) (EventsResponseObject, error) {
	var events iter.Seq[tsgo.SSE[Ev]] = func(yield func(tsgo.SSE[Ev]) bool) {
		_ = yield(tsgo.SSE[Ev]{Event: NewEvSingle(A{N: 1})}) &&
			yield(tsgo.SSE[Ev]{Event: NewEvChange(NewEvChangeB(B{S: "x"}))}) &&
			yield(tsgo.SSE[Ev]{Event: NewEvChange(NewEvChangeA(A{N: 2}))})
	}
	return Events200StreamResponse{Body: events}, nil
}

// A union-typed event variant keeps its event name; the data is the JSON of the chosen member.
func TestNestedEventUnionOnTheWire(t *testing.T) {
	w := httptest.NewRecorder()
	NewHandler(srv{}, ServerOptions{ValidateResponses: true}).ServeHTTP(w, httptest.NewRequest("GET", "/events", nil))
	body, _ := io.ReadAll(w.Body)
	want := "event: single\ndata: {\"n\":1}\n\nevent: change\ndata: {\"s\":\"x\"}\n\nevent: change\ndata: {\"n\":2}\n\n"
	if w.Code != 200 || string(body) != want {
		t.Fatalf("%d %q", w.Code, body)
	}
	for _, c := range []struct {
		data string
		isB  bool
	}{{`{"s":"x"}`, true}, {`{"n":2}`, false}} {
		e, err := UnmarshalEvSSE("change", []byte(c.data))
		ch, ok := e.AsChange()
		if err != nil || !ok {
			t.Fatalf("%s: %v", c.data, err)
		}
		if _, isB := ch.AsB(); isB != c.isB {
			t.Fatalf("%s decoded as %v", c.data, ch.Kind())
		}
	}
	if _, err := UnmarshalEvSSE("change", []byte(`{"q":true}`)); err == nil {
		t.Fatal("payload matching no member accepted")
	}
	if _, err := UnmarshalEvSSE("single", []byte(`{"s":"x"}`)); err == nil {
		t.Fatal("payload of another event accepted")
	}
}

func TestEnvelopeEventPayload(t *testing.T) {
	ev, err := UnmarshalEvSSE("count", []byte("-2"))
	count, ok := ev.AsCount()
	if err != nil || !ok || count.Count.Value == nil || *count.Count.Value != -2 {
		t.Fatalf("nested text data: %#v %v", count, err)
	}
	name, data, err := marshalEvSSE(ev)
	if name != "count" || string(data) != "-2" || err != nil {
		t.Fatalf("%s %q %v", name, data, err)
	}
	if _, _, err = marshalEvSSE(NewEvCount(Detail{})); err == nil {
		t.Fatal("absent event payload was transmitted")
	}
	fi, err := UnmarshalEvSSE("fixed", []byte(`"sent"`))
	if err != nil {
		t.Fatal(err)
	}
	_, data, err = marshalEvSSE(fi)
	if string(data) != `"sent"` || err != nil {
		t.Fatalf("%s %v", data, err)
	}
	if _, err = UnmarshalEvSSE("fixed", []byte(`"other"`)); err == nil {
		t.Fatal("incorrect literal")
	}
	s := "would disappear"
	if _, _, err = marshalEvSSE(NewEvFixed(Fixed{Note: &s})); err == nil {
		t.Fatal("silent loss of envelope metadata")
	}
}
