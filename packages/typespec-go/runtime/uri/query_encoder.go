// Code in this package is copied from github.com/ogen-go/ogen/uri at commit
// 3d90c0ca96cc3a28db44d4088da22f7890875ac3 (Apache-2.0, see LICENSE.ogen) and adapted:
// github.com/go-faster/errors was replaced by the standard library and ogen-internal
// packages (validate, httpcookie) by local equivalents.

package uri

import (
	"fmt"
	"io"
	"mime/multipart"
	"net/textproto"
	"net/url"
	"strings"
)

type QueryEncoder struct {
	values url.Values

	ct map[string]string
}

func NewQueryEncoder() *QueryEncoder {
	return &QueryEncoder{
		values: make(url.Values),
	}
}

func NewFormEncoder(ct map[string]string) *QueryEncoder {
	return &QueryEncoder{
		values: make(url.Values),
		ct:     ct,
	}
}

type QueryParameterEncodingConfig struct {
	Name    string
	Style   QueryStyle
	Explode bool
}

func (e *QueryEncoder) EncodeParam(cfg QueryParameterEncodingConfig, f func(Encoder) error) error {
	p := &queryParamEncoder{
		receiver: newReceiver(),
		values:   e.values,

		paramName: cfg.Name,
		style:     cfg.Style,
		explode:   cfg.Explode,
	}

	if err := f(p); err != nil {
		return err
	}

	// FIXME(tdakkota): probable we should return the error during encoding
	return p.serialize()
}

func (e *QueryEncoder) Values() url.Values {
	return e.values
}

func (e *QueryEncoder) WriteMultipart(w *multipart.Writer) error {
	for k, values := range e.values {
		for i, value := range values {
			if err := e.writeMultipartField(w, k, value); err != nil {
				return fmt.Errorf("write %q: [%d]: %w", k, i, err)
			}
		}
	}
	return nil
}

func (e *QueryEncoder) writeMultipartField(w *multipart.Writer, key, value string) error {
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition",
		fmt.Sprintf(`form-data; name="%s"`, escapeQuotes(key)))
	if contentType, ok := e.ct[key]; ok {
		h.Set("Content-Type", contentType)
	}

	field, err := w.CreatePart(h)
	if err != nil {
		return err
	}
	_, err = io.WriteString(field, value)
	return err
}

var quoteEscaper = strings.NewReplacer("\\", "\\\\", `"`, "\\\"")

func escapeQuotes(s string) string {
	return quoteEscaper.Replace(s)
}
