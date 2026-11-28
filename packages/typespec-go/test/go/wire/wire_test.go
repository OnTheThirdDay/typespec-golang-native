package gen

import (
	"context"
	"example.com/gen/tsgo"
	"io"
	"mime"
	"mime/multipart"
	"net/http/httptest"
	"strings"
	"testing"
)

type wireServer struct{}

func (wireServer) Forms(context.Context, FormsRequestObject) (FormsResponseObject, error) {
	return Forms200FormResponse{Body: Form{Name: "a + b", IDs: []int32{2, 0}}}, nil
}
func (wireServer) Parts(context.Context, PartsRequestObject) (PartsResponseObject, error) {
	return Parts200MultipartResponse{Body: Parts200ResponseBody{Title: "title", Count: 3, Files: []tsgo.File{{ContentType: "application/octet-stream", Filename: "x.bin", Contents: []byte{0, 255}}}}}, nil
}
func (wireServer) Lookup(_ context.Context, r LookupRequestObject) (LookupResponseObject, error) {
	return Lookup200TextResponse{Body: r.A + "|" + r.B}, nil
}
func (wireServer) Prefix(_ context.Context, r PrefixRequestObject) (PrefixResponseObject, error) {
	return Prefix200TextResponse{Body: string(r.S)}, nil
}
func (wireServer) Matrix(_ context.Context, r MatrixRequestObject) (MatrixResponseObject, error) {
	var a, b string
	if r.A != nil {
		a = *r.A
	}
	if r.B != nil {
		b = strings.Join(*r.B, "|")
	}
	return Matrix200TextResponse{Body: a + "/" + b}, nil
}
func (wireServer) Reserved(_ context.Context, r ReservedRequestObject) (ReservedResponseObject, error) {
	return Reserved200TextResponse{Body: r.X}, nil
}
func TestIndependentWire(t *testing.T) {
	h := NewHandler(wireServer{}, ServerOptions{ValidateResponses: true})
	for path, want := range map[string]string{"/forms": "ids=2&ids=0&x-y=a+%2B+b", "/lookup/a%2Cb,c": "a,b|c", "/prefix/abc": "abc", "/matrix;b=x%2Cy,z": "/x,y|z", "/matrix;a=ok;b=a,b": "ok/a|b", "/reserved/a,b/c/suffix": "a,b/c"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 || w.Body.String() != want {
			t.Fatalf("%s %d %q want %q", path, w.Code, w.Body.String(), want)
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/parts", nil))
	mt, params, err := mime.ParseMediaType(w.Header().Get("Content-Type"))
	if err != nil || mt != "multipart/form-data" || w.Code != 200 {
		t.Fatalf("%v %d %s", err, w.Code, w.Body)
	}
	mr := multipart.NewReader(w.Body, params["boundary"])
	for i, want := range []string{"title", "3", string([]byte{0, 255})} {
		p, err := mr.NextPart()
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(p)
		if err != nil || string(b) != want || p.FormName() != []string{"title", "count", "files"}[i] {
			t.Fatalf("%s %q %v", p.FormName(), b, err)
		}
		if i == 2 && p.FileName() != "x.bin" {
			t.Fatal(p.FileName())
		}
	}
	if _, err := mr.NextPart(); err != io.EOF {
		t.Fatal(err)
	}
}
