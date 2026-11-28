package gen

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"example.com/gen/tsgo"
)

// srv produces events on demand: each tick is emitted only after the test has received the
// previous one, which proves that events are flushed individually (not buffered).
type srv struct {
	next      chan struct{}
	cancelled chan struct{}
	produced  atomic.Int32
	firstItem chan struct{}
}

func (s *srv) Ticks(ctx context.Context, r TicksRequestObject) (TicksResponseObject, error) {
	id := "e1"
	return Ticks200StreamResponse{Body: func(yield func(tsgo.SSE[TickEvents]) bool) {
		defer close(s.cancelled)
		for i := int32(1); ; i++ {
			select {
			case <-s.next:
			case <-ctx.Done():
				return
			}
			s.produced.Add(1)
			e := tsgo.SSE[TickEvents]{Event: NewTickEventsTick(Tick{N: i})}
			if i == 1 {
				e.ID = &id
			}
			if !yield(e) {
				return
			}
		}
	}}, nil
}

func (s *srv) Upload(ctx context.Context, r UploadRequestObject) (UploadResponseObject, error) {
	var names []string
	var res Upload200ResponseBody
	for item, err := range r.Body {
		if err != nil {
			msg := err.Error()
			res.Error = &msg
			break
		}
		if len(names) == 0 && s.firstItem != nil {
			close(s.firstItem) // the first item is available before the request body is complete
		}
		names = append(names, item.Name+":"+itoa(*item.Count))
	}
	res.Names = append([]string{}, names...)
	return Upload200JSONResponse{Body: res}, nil
}

func (s *srv) Export(ctx context.Context, r ExportRequestObject) (ExportResponseObject, error) {
	return Export200StreamResponse{Body: func(yield func(Item) bool) {
		for _, n := range []string{"a", "b"} {
			c := int32(len(n))
			if !yield(Item{Name: n, Count: &c}) {
				return
			}
		}
	}}, nil
}

func itoa(n int32) string { return strings.TrimSpace(strings.Repeat(" ", 0) + string(rune('0'+n))) }

func TestSSEIsStreamedIncrementally(t *testing.T) {
	s := &srv{next: make(chan struct{}, 1), cancelled: make(chan struct{})}
	ts := httptest.NewServer(NewHandler(s, ServerOptions{}))
	defer ts.Close()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", ts.URL+"/ticks", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("content type %q", res.Header.Get("Content-Type"))
	}
	br := bufio.NewReader(res.Body)
	readEvent := func() string {
		var lines []string
		for {
			l, err := br.ReadString('\n')
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			if l == "\n" {
				return strings.Join(lines, "")
			}
			lines = append(lines, l)
		}
	}
	for i := 1; i <= 3; i++ {
		s.next <- struct{}{} // allow exactly one more event
		ev := readEvent()
		if !strings.Contains(ev, `data: {"n":`+string(rune('0'+i))+`}`) || !strings.Contains(ev, "event: tick") {
			t.Fatalf("event %d: %q", i, ev)
		}
		if i == 1 && !strings.Contains(ev, "id: e1") {
			t.Fatalf("id field missing: %q", ev)
		}
		if got := s.produced.Load(); got != int32(i) {
			t.Fatalf("producer is ahead of the client: produced %d after reading %d", got, i)
		}
	}
	// Client disconnect cancels the producer through the request context.
	cancel()
	res.Body.Close()
	select {
	case <-s.cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("producer was not cancelled after the client went away")
	}
}

func TestSSEDecodeHelper(t *testing.T) {
	e, err := UnmarshalTickEventsSSE("tick", []byte(`{"n":7}`))
	if v, ok := e.AsTick(); err != nil || !ok || v.N != 7 {
		t.Fatal(e, err)
	}
	e, err = UnmarshalTickEventsSSE("", []byte("[DONE]"))
	if v, ok := e.AsDONE(); err != nil || !ok || v != "[DONE]" {
		t.Fatal("terminal event", err)
	}
	if _, err := UnmarshalTickEventsSSE("", []byte("[NOPE]")); err == nil {
		t.Fatal("unknown unnamed event accepted")
	}
	bad := "a\nb"
	if _, err := tsgo.EncodeSSERecord(tsgo.SSERecord{ID: &bad, Data: []byte("x")}); err == nil {
		t.Fatal("id with newline written")
	}
}

func TestJSONLRequestIsDecodedLazily(t *testing.T) {
	s := &srv{firstItem: make(chan struct{})}
	ts := httptest.NewServer(NewHandler(s, ServerOptions{}))
	defer ts.Close()
	pr, pw := io.Pipe()
	done := make(chan *http.Response)
	go func() {
		res, err := http.Post(ts.URL+"/items", "application/jsonl", pr)
		if err != nil {
			t.Error(err)
		}
		done <- res
	}()
	_, _ = pw.Write([]byte(`{"name":"x","count":2}` + "\n"))
	select {
	case <-s.firstItem: // decoded while the client is still sending
	case <-time.After(5 * time.Second):
		t.Fatal("first JSON Lines item was not delivered before the body was complete")
	}
	_, _ = pw.Write([]byte(`{"name":"y"}` + "\n\n" + `{"name":""}` + "\n" + `{"name":"z"}` + "\n"))
	pw.Close()
	res := <-done
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	// defaults are applied per item; validation fails on the third line and ends the stream
	if res.StatusCode != 400 || !strings.Contains(string(body), "line 4: validation failed: /name") || !strings.Contains(string(body), "less than 1") {
		t.Fatalf("%d %s", res.StatusCode, body)
	}
}

func TestJSONLResponseAndLimits(t *testing.T) {
	ts := httptest.NewServer(NewHandler(&srv{}, ServerOptions{MaxRequestBodyBytes: 32}))
	defer ts.Close()
	res, err := http.Get(ts.URL + "/export")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	if string(b) != "{\"name\":\"a\",\"count\":1}\n{\"name\":\"b\",\"count\":1}\n" || res.Header.Get("Content-Type") != "application/jsonl" {
		t.Fatalf("%q %v", b, res.Header)
	}
	// The body limit also bounds streamed request bodies.
	res, err = http.Post(ts.URL+"/items", "application/jsonl", strings.NewReader(strings.Repeat(`{"name":"long name"}`+"\n", 10)))
	if err != nil {
		t.Fatal(err)
	}
	b, _ = io.ReadAll(res.Body)
	if res.StatusCode != 413 || !strings.Contains(string(b), "request body too large") {
		t.Fatalf("limit not applied to the stream: %s", b)
	}
}

// invalidStreams implements every operation itself (no embedded srv: it holds an atomic counter).
type invalidStreams struct {
	goodFirst bool
}

func (s invalidStreams) Upload(_ context.Context, r UploadRequestObject) (UploadResponseObject, error) {
	for range r.Body {
		break
	}
	return Upload200JSONResponse{}, nil
}

func (s invalidStreams) Export(context.Context, ExportRequestObject) (ExportResponseObject, error) {
	return Export200StreamResponse{Body: func(yield func(Item) bool) {
		if s.goodFirst && !yield(Item{Name: "valid"}) {
			return
		}
		yield(Item{})
	}}, nil
}

func (s invalidStreams) Ticks(context.Context, TicksRequestObject) (TicksResponseObject, error) {
	return Ticks200StreamResponse{Body: func(yield func(tsgo.SSE[TickEvents]) bool) {
		if s.goodFirst && !yield(tsgo.SSE[TickEvents]{Event: NewTickEventsTick(Tick{N: 1})}) {
			return
		}
		yield(tsgo.SSE[TickEvents]{Event: NewTickEventsTick(Tick{})})
	}}, nil
}

func TestStreamValidationCommit(t *testing.T) {
	for _, path := range []string{"/ticks", "/export"} {
		for _, goodFirst := range []bool{false, true} {
			ts := httptest.NewServer(NewHandler(invalidStreams{goodFirst: goodFirst}, ServerOptions{ValidateResponses: true}))
			res, err := http.Get(ts.URL + path)
			if err != nil {
				ts.Close()
				t.Fatal(err)
			}
			b, err := io.ReadAll(res.Body)
			res.Body.Close()
			ts.Close()
			if goodFirst {
				if res.StatusCode != 200 || err != io.ErrUnexpectedEOF || len(b) == 0 || strings.Contains(string(b), "problem") {
					t.Fatalf("%s: %d %q %v", path, res.StatusCode, b, err)
				}
			} else if res.StatusCode != 500 || err != nil || res.Header.Get("Content-Type") != "application/problem+json" {
				t.Fatalf("%s: %d %s %v", path, res.StatusCode, b, err)
			}
		}
	}
}

func TestUnconsumedStreamCannotSucceed(t *testing.T) {
	h := NewHandler(invalidStreams{}, ServerOptions{})
	r := httptest.NewRequest("POST", "/items", strings.NewReader("{\"name\":\"x\"}\n{\"name\":\"\"}\n"))
	r.Header.Set("Content-Type", "application/jsonl")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "line 2") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}
