package gen

import (
	"context"
	"encoding/xml"
	"io"
	"mime"
	"mime/multipart"
	"net/http/httptest"
	"strings"
	"testing"
)

type service struct{}

func (service) Filter(_ context.Context, r FilterRequestObject) (FilterResponseObject, error) {
	return Filter200TextResponse{Body: r.Q.N}, nil
}
func (service) Number(_ context.Context, r NumberRequestObject) (NumberResponseObject, error) {
	return Number200TextResponse{Body: r.Body}, nil
}
func (service) Attrs(_ context.Context, r AttrsRequestObject) (AttrsResponseObject, error) {
	return Attrs200JSONResponse{Body: r.Q}, nil
}
func (service) Form(_ context.Context, r FormRequestObject) (FormResponseObject, error) {
	return Form200FormResponse{Body: r.Body}, nil
}
func (service) Tree(_ context.Context, r TreeRequestObject) (TreeResponseObject, error) {
	return Tree200JSONResponse{Body: r.Body}, nil
}
func (service) Parts(_ context.Context, r PartsRequestObject) (PartsResponseObject, error) {
	return Parts200MultipartResponse{Body: Parts200ResponseBody{A: r.Body.A + "!"}}, nil
}

func request(method, path, media, data string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r := httptest.NewRequest(method, path, strings.NewReader(data))
	r.Header.Set("Content-Type", media)
	NewHandler(service{}, ServerOptions{ValidateResponses: true}).ServeHTTP(w, r)
	return w
}

func TestObjectQueryAndForm(t *testing.T) {
	if w := request("POST", "/number", "text/plain", "2147483648"); w.Code != 400 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if w := request("POST", "/number", "text/plain", "-21"); w.Code != 200 || w.Body.String() != "-21" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	for _, q := range []string{"kind,wrong,n,0", "n,0", "kind,abc,n,0,extra,1", "kind,abc,n,0,forbidden,1", "kind,abc,n,0,n,2"} {
		if w := request("GET", "/filter?q="+q, "", ""); w.Code != 400 {
			t.Errorf("%s: %d %s", q, w.Code, w.Body)
		}
	}
	for _, c := range []struct{ method, path, ct, body, want string }{
		{"GET", "/filter?q=kind,abc,n,0", "", "", "0"},
		{"GET", "/attrs?base=x&extra=z", "", "", `{"base":"x","extra":"z"}`},
		{"POST", "/form", "application/x-www-form-urlencoded", "extra=A%2BB&base=x", "base=x&extra=A%2BB"},
	} {
		w := request(c.method, c.path, c.ct, c.body)
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != c.want {
			t.Errorf("%s: %d %s", c.path, w.Code, w.Body)
		}
	}
}

func TestClosedXMLWire(t *testing.T) {
	const good = `<Tree><entry id="v"><values><string>x</string></values></entry></Tree>`
	for _, doc := range []string{
		strings.Replace(good, "<Tree>", "<Tree extra='x'>", 1),
		strings.Replace(good, "<entry ", "<entry extra='x' ", 1),
		strings.Replace(good, "<entry ", "<entry id='y' ", 1),
		strings.Replace(good, "<values>", "<bad/><values>", 1),
		strings.Replace(good, "<values>", "<values xmlns='urn:other'>", 1),
		strings.Replace(good, "<string>x</string>", "<string>x<foreign/></string>", 1),
		strings.Replace(good, "<string>x</string>", "<string extra='v'>x</string>", 1),
		strings.Replace(good, "<string>x</string>", "<other>x</other>", 1),
		strings.Replace(good, "<entry ", "unexpected<entry ", 1),
	} {
		if w := request("POST", "/xml", "application/xml", doc); w.Code != 400 {
			t.Errorf("%s: %d %s", doc, w.Code, w.Body)
		}
	}
	if w := request("POST", "/xml", "application/xml", good); w.Code != 200 || w.Body.String() != `{"entry":{"id":"v","values":["x"]}}` {
		t.Errorf("%d %s", w.Code, w.Body)
	}

}

func TestClosedMultipartWire(t *testing.T) {
	const part = "--boundary\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nA\r\n"
	const end = "--boundary--\r\n"
	const ct = "multipart/form-data; boundary=boundary"
	for _, data := range []string{part + strings.Replace(part, `name="a"`, `name="other"`, 1) + end, part + part + end} {
		if w := request("POST", "/parts", ct, data); w.Code != 400 {
			t.Errorf("%d %s", w.Code, w.Body)
		}
	}
	w := request("POST", "/parts", ct, part+end)
	media, params, err := mime.ParseMediaType(w.Header().Get("Content-Type"))
	if w.Code != 200 || err != nil || media != "multipart/form-data" {
		t.Fatalf("%d %v %s", w.Code, err, w.Body)
	}
	r := multipart.NewReader(w.Body, params["boundary"])
	p, err := r.NextPart()
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(p)
	if err != nil || string(body) != "A!" || p.FormName() != "a" {
		t.Fatalf("%s %s %v", p.FormName(), body, err)
	}
	if _, err := r.NextPart(); err != io.EOF {
		t.Fatal(err)
	}
}

func (service) Reply(_ context.Context, r ReplyRequestObject) (ReplyResponseObject, error) {
	switch r.Mode {
	case "nil":
		return (*Reply200Response)(nil), nil
	case "header":
		return Reply200Response{Etag: "should-not-leak", Comment: "\n"}, nil
	case "reserved":
		return ReplyDefaultJSONResponse{StatusCode: 404}, nil
	case "range":
		return ReplyDefaultJSONResponse{StatusCode: 700}, nil
	}
	return ReplyDefaultJSONResponse{StatusCode: 422, Body: Fault{Message: "valid"}}, nil
}

func TestResponseFailureBeforeCommit(t *testing.T) {
	for _, mode := range []string{"nil", "header", "reserved", "range", "ok"} {
		w := request("GET", "/reply?mode="+mode, "", "")
		want := 500
		if mode == "ok" {
			want = 422
		}
		if w.Code != want || w.Header().Get("ETag") != "" {
			t.Errorf("%s: %d %s", mode, w.Code, w.Header())
		}
	}
}

func (service) List(_ context.Context, r ListRequestObject) (ListResponseObject, error) {
	var resp List200JSONResponse
	resp.Body.Fields = r.Fields
	resp.Body.Attrs = r.Attrs
	return resp, nil
}

func TestEscapedQueryDelimiters(t *testing.T) {
	w := request("GET", "/list?fields=a%2Cb,c%252Cd&attrs=k%2C1,v%2C1", "", "")
	if w.Code != 200 || w.Body.String() != `{"fields":["a,b","c%2Cd"],"attrs":{"k,1":"v,1"}}` {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}

func (service) Empty(context.Context, EmptyRequestObject) (EmptyResponseObject, error) {
	return Empty204Response{}, nil
}

func (service) OptionalText(_ context.Context, r OptionalTextRequestObject) (OptionalTextResponseObject, error) {
	s := "absent"
	if r.Body != nil {
		s = "present:" + *r.Body
	}
	return OptionalText200TextResponse{Body: s}, nil
}

func TestRequestBodyPresenceAndMedia(t *testing.T) {
	for _, c := range []struct {
		path, ct, data string
		status         int
		value          string
	}{
		{"/empty", "application/json", "{}", 204, ""},
		{"/empty", "application/json", "", 400, ""},
		{"/empty", "", "", 415, ""},
		{"/optional-text", "", "", 200, "absent"},
		{"/optional-text", "text/plain", "", 200, "present:"},
		{"/optional-text", "text/plain", "x", 200, "present:x"},
		{"/optional-text", "", "x", 415, ""},
	} {
		for _, chunked := range []bool{false, true} {
			r := httptest.NewRequest("POST", c.path, strings.NewReader(c.data))
			if chunked {
				r.ContentLength = -1
				r.TransferEncoding = []string{"chunked"}
			}
			if c.ct != "" {
				r.Header.Set("Content-Type", c.ct)
			}
			w := httptest.NewRecorder()
			NewHandler(service{}, ServerOptions{}).ServeHTTP(w, r)
			if w.Code != c.status || (w.Code == 200 && w.Body.String() != c.value) {
				t.Errorf("%s %q %q chunked=%v: %d %s", c.path, c.ct, c.data, chunked, w.Code, w.Body)
			}
		}
	}
}

func (service) SimpleObject(_ context.Context, r SimpleObjectRequestObject) (SimpleObjectResponseObject, error) {
	return SimpleObject200JSONResponse{Body: r.Fields}, nil
}
func (service) MatrixObject(_ context.Context, r MatrixObjectRequestObject) (MatrixObjectResponseObject, error) {
	return MatrixObject200JSONResponse{Body: r.Fields}, nil
}

func TestModelPathWire(t *testing.T) {
	for _, c := range []struct {
		path   string
		status int
		json   string
	}{
		{"/object/n-items,0", 200, `{"n-items":0}`},
		{"/object/n-items,0,label,a%2Cb", 200, `{"n-items":0,"label":"a,b"}`},
		{"/matrix;n-items=2;label", 200, `{"n-items":2,"label":""}`},
		{"/matrix;label=a%3Bb;n-items=1", 200, `{"n-items":1,"label":"a;b"}`},
		{"/object/n-items,1,n-items,2", 400, ""},
		{"/matrix;n-items=1;extra=x", 400, ""},
		{"/object/label,value", 400, ""},
		{"/object/n-items,-1", 400, ""},
		// Malformed or unrepresentable inputs are rejected, never partially bound.
		{"/object/n-items,1,label", 400, ""},     // odd number of items: no value for "label"
		{"/object/n-items,1.5", 400, ""},         // not an int32
		{"/matrix;n-items", 400, ""},             // empty value for an integer
		{"/matrix;n-items=1;n-items=1", 400, ""}, // duplicate matrix key
		{"/matrix;n-items=1;;label=x", 400, ""},  // empty member
		{"/object/n-items,1,label,a,b", 400, ""}, // unescaped comma inside a value
	} {
		w := request("GET", c.path, "", "")
		if w.Code != c.status || c.status == 200 && w.Body.String() != c.json {
			t.Errorf("%s: got %d %s", c.path, w.Code, w.Body)
		}
	}
}

func (service) Directory(_ context.Context, r DirectoryRequestObject) (DirectoryResponseObject, error) {
	return Directory200XMLResponse{Body: r.Body}, nil
}

func TestXMLModelRecordWireValues(t *testing.T) {
	const a = `<a id="one"><values><string>A</string></values></a>`
	const z = `<z id="two"><values><string>Z</string></values></z>`
	const start, end = "<Directory><entries>", "</entries></Directory>"
	w := request("POST", "/directory", "application/xml", start+z+a+end)
	if w.Code != 200 || w.Body.String() != xml.Header+start+a+z+end {
		t.Fatalf("status %d, body %s", w.Code, w.Body)
	}
	for _, b := range []string{a + a, `<a><values/></a>`, z + "text"} {
		if w := request("POST", "/directory", "application/xml", start+b+end); w.Code != 400 {
			t.Fatalf("accepted %s: %d", b, w.Code)
		}
	}
}
