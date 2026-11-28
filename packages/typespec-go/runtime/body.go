package tsgo

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"iter"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"unicode/utf8"
)

// File is the Go representation of TypeSpec.Http.File (file bodies and multipart file parts).
type File struct {
	ContentType string // media type of the contents ("" if unspecified)
	Filename    string // filename from Content-Disposition ("" if absent)
	Contents    []byte
}

// Part is one part of a multipart/form-data request.
type Part struct {
	Filename    string
	ContentType string
	Header      textproto.MIMEHeader
	Data        []byte
}

// ReadMultipart reads all parts of a multipart/form-data request (bounded by the body limit).
func ReadMultipart(r *http.Request) (map[string][]Part, error) {
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, BodyError(err)
	}
	parts := map[string][]Part{}
	for {
		p, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			return parts, nil
		}
		if err != nil {
			return nil, BodyError(err)
		}
		data, err := io.ReadAll(p)
		if err != nil {
			return nil, BodyError(err)
		}
		name := p.FormName()
		if name == "" {
			return nil, BodyError(errors.New("multipart part without a form name"))
		}
		parts[name] = append(parts[name], Part{Filename: p.FileName(), ContentType: p.Header.Get("Content-Type"), Header: p.Header, Data: data})
	}
}

// PartText decodes a text part (UTF-8).
func PartText(p Part) (string, error) {
	if !utf8.Valid(p.Data) {
		return "", &DecodeProblem{Kind: ProblemUnicode, Message: "part is not valid UTF-8"}
	}
	return string(p.Data), nil
}

// PartFile converts a part to a File.
func PartFile(p Part) File {
	return File{ContentType: p.ContentType, Filename: p.Filename, Contents: p.Data}
}

// TextBody decodes a text/* request body.
func TextBody(data []byte) (string, error) {
	if !utf8.Valid(data) {
		return "", BodyError(&DecodeProblem{Kind: ProblemUnicode, Message: "body is not valid UTF-8"})
	}
	return string(data), nil
}

// FileFromRequest builds a File from a file request body.
func FileFromRequest(r *http.Request, data []byte) File {
	f := File{ContentType: r.Header.Get("Content-Type"), Contents: data}
	if mt, _, err := mime.ParseMediaType(f.ContentType); err == nil {
		f.ContentType = mt
	}
	if _, params, err := mime.ParseMediaType(r.Header.Get("Content-Disposition")); err == nil {
		f.Filename = params["filename"]
	}
	return f
}

// WriteFile writes a file response body. allowed lists the declared media types; an empty
// File.ContentType uses the first one.
func WriteFile(w http.ResponseWriter, status int, f File, allowed []string) error {
	ct := f.ContentType
	if ct == "" && len(allowed) > 0 {
		ct = allowed[0]
	}
	if len(allowed) > 0 {
		if _, err := MatchContentType(ct, allowed); err != nil {
			return fmt.Errorf("file content type %q is not declared: %w", ct, err)
		}
	}
	if ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if f.Filename != "" {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": f.Filename}))
	}
	w.WriteHeader(status)
	_, err := w.Write(f.Contents)
	if err != nil {
		return committedError{err}
	}
	return nil
}

// WriteBody writes a response with an encoded body.
func WriteBody(w http.ResponseWriter, status int, contentType string, body []byte) error {
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.WriteHeader(status)
	_, err := w.Write(body)
	if err != nil {
		return committedError{err}
	}
	return nil
}

// CheckStatus validates a status code against a declared range (inclusive).
func CheckStatus(v *Validator, code, min, max int) {
	if code < min || code > max {
		v.At("StatusCode").Add("statusCode", "status code %d is outside %d-%d", code, min, max)
	}
}

// A failed write after a final status requires terminating the HTTP exchange.
type committedError struct{ error }

func (e committedError) Unwrap() error { return e.error }

func ResponseFailed(w http.ResponseWriter, r *http.Request, err error, handle func(http.ResponseWriter, *http.Request, error)) {
	var committed committedError
	if errors.As(err, &committed) {
		panic(http.ErrAbortHandler)
	}
	handle(w, r, err)
}

func writeStream[T any](w http.ResponseWriter, r *http.Request, status int, media string, items iter.Seq[T], encode func(T) ([]byte, error), eager bool) error {
	committed := false
	commit := func() {
		if !committed {
			w.Header().Set("Content-Type", media)
			w.WriteHeader(status)
			committed = true
		}
	}
	flush := func() error {
		err := http.NewResponseController(w).Flush()
		if errors.Is(err, http.ErrNotSupported) {
			return nil
		}
		return err
	}
	var err error
	if eager {
		commit()
		err = flush()
	}
	if items != nil && err == nil {
		for item := range items {
			if r != nil && r.Context().Err() != nil {
				err = r.Context().Err()
				break
			}
			var frame []byte
			frame, err = encode(item)
			if err != nil {
				break
			}
			commit()
			if _, err = w.Write(frame); err != nil {
				break
			}
			if err = flush(); err != nil {
				break
			}
		}
	}
	if err == nil {
		commit()
	} else if committed {
		return committedError{err}
	}
	return err
}

// FormPart is a named outgoing MIME part. An empty Filename denotes an ordinary field.
type FormPart struct {
	Name string
	File File
}

func EncodeMultipart(parts []FormPart) ([]byte, string, error) {
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	for _, p := range parts {
		params := map[string]string{"name": p.Name}
		if p.File.Filename != "" {
			params["filename"] = p.File.Filename
		}
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", mime.FormatMediaType("form-data", params))
		if strings.ContainsAny(p.File.ContentType, "\r\n") {
			return nil, "", errors.New("invalid MIME part content type")
		}
		header.Set("Content-Type", p.File.ContentType)
		w, err := writer.CreatePart(header)
		if err != nil {
			return nil, "", err
		}
		if _, err := w.Write(p.File.Contents); err != nil {
			return nil, "", err
		}
	}
	err := writer.Close()
	return buf.Bytes(), writer.FormDataContentType(), err
}
