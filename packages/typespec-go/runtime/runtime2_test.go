package tsgo

import (
	"bytes"
	"encoding/json"
	"fmt"
	"iter"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestURITemplateExpansions(t *testing.T) {
	cases := []struct {
		raw, op string
		explode bool
		want    string
	}{
		{"a,b", "", false, "a|b"},
		{"a%2Cb,c", "", false, "a,b|c"},
		{".a.b", ".", true, "a|b"},
		{".a,b", ".", false, "a|b"},
		{"/a/b", "/", true, "a|b"},
		{"/a,b", "/", false, "a|b"},
		{";p=a;p=b", ";", true, "a|b"},
		{";p=a,b", ";", false, "a|b"},
		{";p", ";", false, ""},
		{"x%2Fy", "+", false, "x/y"},
	}
	for _, c := range cases {
		items, err := SplitExpansion(c.raw, c.op, "p", c.explode)
		if err != nil || strings.Join(items, "|") != c.want {
			t.Errorf("%q %q %v: %v %v", c.raw, c.op, c.explode, items, err)
		}
	}
	pairs, err := SplitExpansionPairs(";a=1;b=2", ";", "p", true)
	if err != nil || len(pairs) != 2 || pairs[1] != [2]string{"b", "2"} {
		t.Fatal(pairs, err)
	}
	if _, err := SplitExpansionPairs("a,1,b", "", "p", false); err == nil {
		t.Fatal("odd record accepted")
	}
	if _, err := SplitExpansion("a", ".", "p", false); err == nil {
		t.Fatal("label without prefix accepted")
	}
	m, err := ParseExpansionRecord("/a=1/b=2", "/", "p", true, IntText[int32]())
	if err != nil || m["a"] != 1 || m["b"] != 2 {
		t.Fatal(m, err)
	}
	q := url.Values{"a": {"1"}, "b": {"2"}, "other": {"x"}}
	rec, ok, err := QueryRecord(q, "p", true, []string{"other"}, IntText[int32]())
	if err != nil || !ok || len(rec) != 2 {
		t.Fatal(rec, err)
	}
	if _, _, err := QueryRecord(url.Values{"p": {"a,1,a,2"}}, "p", false, nil, IntText[int32]()); err == nil {
		t.Fatal("duplicate record key accepted")
	}
}

func TestXMLRoundTripAndNamespaces(t *testing.T) {
	root := NewXMLNode(XMLName{Space: "urn:a", Prefix: "a", Local: "Root"})
	root.SetAttr(XMLName{Local: "id"}, `1<"2">`)
	root.AddText(XMLName{Local: "plain"}, "x & y")
	root.AddText(XMLName{Space: "urn:b", Local: "unprefixed"}, "z")
	b, err := EncodeXML(root)
	if err != nil {
		t.Fatal(err)
	}
	n, err := ParseXML(b)
	if err != nil {
		t.Fatal(err)
	}
	if n.Name.Space != "urn:a" || n.Children[0].Name.Space != "" || n.Children[1].Name.Space != "urn:b" {
		t.Fatalf("namespaces changed: %s", b)
	}
	if v, _ := n.Attr(XMLName{Local: "id"}); v != `1<"2">` || n.Children[0].Text != "x & y" {
		t.Fatalf("escaping: %s", b)
	}
	if _, err := ParseXML([]byte(`<!DOCTYPE x [<!ENTITY e "boom">]><x>&e;</x>`)); err == nil {
		t.Fatal("DTD accepted")
	}
	if _, err := ParseXML([]byte(`<a/><b/>`)); err == nil {
		t.Fatal("two roots accepted")
	}
	clash := NewXMLNode(XMLName{Space: "urn:a", Prefix: "a", Local: "R"})
	clash.AddText(XMLName{Space: "urn:a", Prefix: "b", Local: "c"}, "")
	if _, err := EncodeXML(clash); err == nil {
		t.Fatal("conflicting prefixes accepted")
	}
}

func TestSSEEncodingAndParsing(t *testing.T) {
	id := "1"
	retry := 1500 * time.Millisecond
	b, err := EncodeSSERecord(SSERecord{Event: "e", Data: []byte("a\nb"), ID: &id, Retry: &retry})
	if err != nil || string(b) != "id: 1\nretry: 1500\nevent: e\ndata: a\ndata: b\n\n" {
		t.Fatalf("%q %v", b, err)
	}
	recs := ParseSSE([]byte(": comment\nevent: e\ndata: a\ndata: b\nid: 7\nretry: x\n\ndata: z\n\n"))
	if len(recs) != 2 || string(recs[0].Data) != "a\nb" || *recs[0].ID != "7" || recs[0].Retry != nil || string(recs[1].Data) != "z" {
		t.Fatalf("%+v", recs)
	}
	rr := httptest.NewRecorder()
	seq := func(yield func(SSE[string]) bool) {
		_ = yield(SSE[string]{Event: "x"}) && yield(SSE[string]{Event: "y"})
	}
	err = WriteSSE(rr, nil, 200, iter.Seq[SSE[string]](seq), func(s string) (string, []byte, error) { return "", []byte(s), nil })
	if err != nil || rr.Body.String() != "data: x\n\ndata: y\n\n" || !rr.Flushed {
		t.Fatalf("%q %v", rr.Body.String(), err)
	}
}

func TestJSONLDecoding(t *testing.T) {
	in := "1\n\n2\nx\n3\n"
	var got []int32
	var gotErr error
	for v, err := range ReadJSONL(strings.NewReader(in), IntCodec[int32](), nil) {
		if err != nil {
			gotErr = err
			break
		}
		got = append(got, v)
	}
	if len(got) != 2 || gotErr == nil || !strings.Contains(gotErr.Error(), "line 4") {
		t.Fatal(got, gotErr)
	}
	rr := httptest.NewRecorder()
	err := WriteJSONL(rr, nil, 200, "application/jsonl", func(yield func(int32) bool) { _ = yield(1) && yield(2) }, IntCodec[int32]())
	if err != nil || !bytes.Equal(rr.Body.Bytes(), []byte("1\n2\n")) {
		t.Fatal(rr.Body.String(), err)
	}
}

func TestAcceptMatching(t *testing.T) {
	for accept, want := range map[string]bool{"": true, "image/png": true, "image/*": true, "*/*;q=0.1": true, "image/png;q=0": false, "text/html": false, "text/html, image/png": true} {
		if AcceptMatches(accept, "image/png") != want {
			t.Errorf("%q", accept)
		}
	}
}

func FuzzXMLParse(f *testing.F) {
	f.Add([]byte(`<a x="1"><b>t</b></a>`))
	f.Fuzz(func(t *testing.T, data []byte) {
		n, err := ParseXML(data)
		if err != nil {
			return
		}
		b, err := EncodeXML(n)
		if err != nil {
			return
		}
		n2, err := ParseXML(b)
		if err != nil {
			t.Fatalf("re-parse of %q: %v", b, err)
		}
		if ok, _ := XMLEquivalent(b, mustEncode(n2)); !ok {
			t.Fatalf("not stable: %q", b)
		}
	})
}

func mustEncode(n *XMLNode) []byte {
	b, _ := EncodeXML(n)
	return b
}

func TestSSEDispatchAndControlFields(t *testing.T) {
	stream := []byte("\xef\xbb\xbfid: a\rretry: 25\r\rdata: one\r\n\r\nid: ignored\x00id\nretry: +9\nretry: 9223372036854775807\ndata: \xe2\x82\n\ndata: truncated\n")
	got := ParseSSE(stream)
	if len(got) != 2 || string(got[0].Data) != "one" || string(got[1].Data) != "\uFFFD" {
		t.Fatalf("dispatched events %#v", got)
	}
	for _, ev := range got {
		if ev.ID == nil || *ev.ID != "a" || ev.Retry == nil || *ev.Retry != 25*time.Millisecond {
			t.Fatalf("connection state %#v", ev)
		}
	}
	fraction := time.Microsecond
	for _, rec := range []SSERecord{{Retry: &fraction}, {Event: "\xff"}, {Data: []byte("\xff")}, {Data: []byte("a\rb")}} {
		if _, err := EncodeSSERecord(rec); err == nil {
			t.Fatalf("accepted unrepresentable event %#v", rec)
		}
	}
}

func FuzzSSEParse(f *testing.F) {
	f.Add([]byte("event: a\ndata: b\n\n"))
	f.Add([]byte("\xef\xbb\xbfid: 2\r\rdata:\r\rdata: unfinished\r"))
	f.Fuzz(func(t *testing.T, data []byte) {
		for _, r := range ParseSSE(data) {
			b, err := EncodeSSERecord(r)
			if err != nil {
				t.Fatalf("parsed a record that cannot be encoded: %v", err)
			}
			again := ParseSSE(b)
			if len(again) != 1 || string(again[0].Data) != string(r.Data) || again[0].Event != r.Event {
				t.Fatalf("round trip of %q", b)
			}
		}
	})
}

func TestBase64PaddingAndAlphabet(t *testing.T) {
	for _, s := range []string{"QQ", "QQ==", "-_8", "-_8="} {
		if _, err := Base64URLText.Parse(s); err != nil {
			t.Errorf("%q: %v", s, err)
		}
	}
	for _, s := range []string{"=", "===", "QQ=", "QQ===", "Q\nQ", "QR", "+/8="} {
		if _, err := Base64URLText.Parse(s); err == nil {
			t.Errorf("accepted %q", s)
		}
	}
	if _, err := Base64Text.Parse("Q\r\nQ=="); err == nil {
		t.Fatal("accepted line break")
	}
}

func TestXMLWireNamesAndText(t *testing.T) {
	for _, q := range []XMLName{{Local: "two words"}, {Local: "a:b"}, {Local: "x", Space: "urn:x", Prefix: "1abc"}} {
		if b, err := EncodeXML(NewXMLNode(q)); err == nil {
			t.Errorf("encoded invalid name: %s", b)
		}
	}
	n := NewXMLNode(XMLName{Local: "日"})
	n.AddText(XMLName{Local: "値"}, "🌏")
	b, err := EncodeXML(n)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseXML(b); err != nil {
		t.Fatal(err)
	}
	n.Text = "\x01"
	if _, err := EncodeXML(n); err == nil {
		t.Fatal("invalid XML text lost")
	}
}

func TestJSONLFramesAndConcurrentDrain(t *testing.T) {
	w := httptest.NewRecorder()
	err := WriteJSONL(w, nil, 200, "application/jsonl", func(yield func(json.RawMessage) bool) {
		yield(json.RawMessage("{\n  \"items\": [1,\r\n2]\n}"))
		yield(json.RawMessage(`"line\nbreak"`))
	}, RawCodec)
	if err != nil || w.Body.String() != "{\"items\":[1,2]}\n\"line\\nbreak\"\n" {
		t.Fatalf("%s %v", w.Body, err)
	}

	var input bytes.Buffer
	for i := 0; i < 100; i++ {
		fmt.Fprintln(&input, i)
	}
	input.WriteString("oops\n")
	seq, finish := RequestJSONL(&input, IntCodec[int32](), nil)
	var wg sync.WaitGroup
	for range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for _, err := range seq {
				if err != nil {
					return
				}
			}
		}()
	}
	err = finish()
	wg.Wait()
	if err == nil || !strings.Contains(err.Error(), "line 101") {
		t.Fatal(err)
	}
	if err := finish(); err == nil {
		t.Fatal("lost previous stream error on retry")
	}
}

func FuzzJSONLFraming(f *testing.F) {
	f.Add([]byte("{\n\"n\":1,\n\"items\":[]}"))
	f.Add([]byte("true\nfalse"))
	f.Add([]byte(" \t\r\nnull\n"))
	f.Fuzz(func(t *testing.T, raw []byte) {
		w := httptest.NewRecorder()
		// Exercise the writer even when a custom codec returns malformed bytes.
		codec := Codec[[]byte]{Encode: func(v []byte) ([]byte, error) { return v, nil }}
		err := WriteJSONL(w, nil, 201, "application/jsonl", func(yield func([]byte) bool) { yield(raw) }, codec)
		if !json.Valid(raw) {
			if err == nil || w.Body.Len() != 0 || w.Header().Get("Content-Type") != "" {
				t.Fatalf("committed invalid item %q", w.Body.Bytes())
			}
			return
		}
		b := w.Body.Bytes()
		if err != nil || w.Code != 201 || !bytes.HasSuffix(b, []byte{'\n'}) || bytes.Count(b, []byte{'\n'}) != 1 || !json.Valid(b) {
			t.Fatalf("framing %q: %q (%v)", raw, b, err)
		}
	})
}
