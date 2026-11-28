package tsgo

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	"net/http"
	"sync"
)

// WriteJSONL streams a JSON Lines body (TypeSpec JsonlStream<T>): one JSON value per line,
// flushed after each value. It stops at the first error or when the request is cancelled.
func WriteJSONL[T any](w http.ResponseWriter, r *http.Request, status int, contentType string, items iter.Seq[T], c Codec[T]) error {
	return writeStream(w, r, status, contentType, items, func(v T) ([]byte, error) {
		b, err := c.Encode(v)
		if err != nil {
			return nil, err
		}
		// Raw JSON (including an unknown field inside a generated model) can contain
		// formatting newlines. One stream item must occupy exactly one physical line.
		var line bytes.Buffer
		if err := json.Compact(&line, b); err != nil {
			return nil, err
		}
		line.WriteByte('\n')
		return line.Bytes(), nil
	}, false)
}

// ReadJSONL lazily decodes a JSON Lines request body. Each value is decoded, given its
// defaults and validated as it is iterated; the first failure is yielded as an error (with the
// 1-based line number) and ends the sequence. Empty lines are skipped. Lines are bounded by the
// request body limit.
func ReadJSONL[T any](body io.Reader, c Codec[T], prepare func(*T) error) iter.Seq2[T, error] {
	seq, _ := RequestJSONL(body, c, prepare)
	return seq
}

// RequestJSONL exposes a single cursor to the handler and the transport. Finish consumes
// any unread suffix and returns the first failure, including one observed by the handler.
func RequestJSONL[T any](body io.Reader, c Codec[T], prepare func(*T) error) (iter.Seq2[T, error], func() error) {
	br := bufio.NewReader(body)
	done := body == nil
	var failure error
	line := 0
	var mu sync.Mutex
	next := func() (T, error, bool) {
		mu.Lock()
		defer mu.Unlock()
		var v T
		for !done {
			raw, err := br.ReadBytes('\n')
			line++
			done = errors.Is(err, io.EOF)
			if err != nil && !done {
				failure = BodyError(err)
			} else {
				raw = bytes.Trim(raw, " \t\r\n")
				if len(raw) == 0 {
					continue
				}
				v, err = c.Decode(raw)
				if err == nil && prepare != nil {
					err = prepare(&v)
				}
				if err != nil {
					failure = BodyError(fmt.Errorf("line %d: %w", line, err))
				}
			}
			if failure != nil {
				done = true
			}
			return v, failure, true
		}
		return v, failure, false
	}
	seq := func(yield func(T, error) bool) {
		for {
			v, err, ok := next()
			if !ok || !yield(v, err) {
				return
			}
		}
	}
	return seq, func() error {
		for {
			_, err, ok := next()
			if !ok || err != nil {
				return err
			}
		}
	}
}
