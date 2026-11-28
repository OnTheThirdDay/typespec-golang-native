package tsgo

import (
	"bytes"
	"errors"
	"fmt"
	"iter"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// SSE is one server-sent event of a TypeSpec SSEStream<Events> response: the event value plus
// the optional protocol fields of the text/event-stream format (WHATWG HTML §9.2).
type SSE[T any] struct {
	Event T
	// ID sets the "id:" field (the client's Last-Event-ID). It must not contain NUL, CR or LF.
	ID *string
	// Retry sets the "retry:" field (reconnection time, whole milliseconds).
	Retry *time.Duration
}

// SSERecord is one raw event of a text/event-stream document.
type SSERecord struct {
	Event string // "" means the default "message" event
	Data  []byte
	ID    *string
	Retry *time.Duration
}

// WriteSSE streams events, flushing after each one. marshal returns the SSE event name ("" for
// unnamed events) and the data payload of an event. The iteration stops at the first error or
// when the client goes away.
func WriteSSE[T any](w http.ResponseWriter, r *http.Request, status int, events iter.Seq[SSE[T]], marshal func(T) (string, []byte, error)) error {
	return writeSSE(w, r, status, events, marshal, true)
}

// WriteValidatedSSE delays the initial headers until the first event is ready.
func WriteValidatedSSE[T any](w http.ResponseWriter, r *http.Request, status int, events iter.Seq[SSE[T]], marshal func(T) (string, []byte, error)) error {
	return writeSSE(w, r, status, events, marshal, false)
}

func writeSSE[T any](w http.ResponseWriter, r *http.Request, status int, events iter.Seq[SSE[T]], marshal func(T) (string, []byte, error), eager bool) error {
	w.Header().Set("Cache-Control", "no-cache")
	return writeStream(w, r, status, "text/event-stream", events, func(e SSE[T]) ([]byte, error) {
		name, data, err := marshal(e.Event)
		if err != nil {
			return nil, err
		}
		return EncodeSSERecord(SSERecord{Event: name, Data: data, ID: e.ID, Retry: e.Retry})
	}, eager)
}

// EncodeSSERecord renders one event; multi-line data becomes several "data:" lines.
func EncodeSSERecord(rec SSERecord) ([]byte, error) {
	if !utf8.Valid(rec.Data) || !utf8.ValidString(rec.Event) || (rec.ID != nil && !utf8.ValidString(*rec.ID)) {
		return nil, errors.New("SSE fields must be valid UTF-8")
	}
	if bytes.ContainsRune(rec.Data, '\r') {
		return nil, errors.New("SSE data cannot represent a carriage return")
	}
	var b bytes.Buffer
	if rec.ID != nil {
		if strings.ContainsAny(*rec.ID, "\x00\r\n") {
			return nil, fmt.Errorf("SSE id %q must not contain NUL, CR or LF", *rec.ID)
		}
		b.WriteString("id: " + *rec.ID + "\n")
	}
	if rec.Retry != nil {
		if *rec.Retry < 0 || *rec.Retry%time.Millisecond != 0 {
			return nil, errors.New("SSE retry must be nonnegative whole milliseconds")
		}
		b.WriteString("retry: " + strconv.FormatInt(rec.Retry.Milliseconds(), 10) + "\n")
	}
	if rec.Event != "" {
		if strings.ContainsAny(rec.Event, "\r\n") {
			return nil, fmt.Errorf("SSE event name %q must not contain line breaks", rec.Event)
		}
		b.WriteString("event: " + rec.Event + "\n")
	}
	data := string(rec.Data)
	for _, line := range strings.Split(data, "\n") {
		b.WriteString("data: " + line + "\n")
	}
	b.WriteString("\n")
	return b.Bytes(), nil
}

// ParseSSE returns events dispatched at blank lines, with the effective last event ID and retry
// interval. A control-only block updates connection state without dispatching an event.
func ParseSSE(stream []byte) []SSERecord {
	var out []SSERecord
	var id *string
	var retry *time.Duration
	var event string
	var data []string
	text := strings.TrimPrefix(decodeEventText(stream), "\uFEFF")
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
	for {
		line, rest, terminated := strings.Cut(text, "\n")
		if !terminated {
			return out // EOF discards the pending event, even if its last field was terminated.
		}
		text = rest
		if line == "" {
			if len(data) > 0 {
				out = append(out, SSERecord{Event: event, Data: []byte(strings.Join(data, "\n")), ID: id, Retry: retry})
			}
			event, data = "", nil
			continue
		}
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			event = value
		case "data":
			data = append(data, value)
		case "id":
			if !strings.ContainsRune(value, '\x00') {
				id = &value
			}
		case "retry":
			ms, err := strconv.ParseUint(value, 10, 64)
			if err == nil && ms <= math.MaxInt64/uint64(time.Millisecond) {
				d := time.Duration(ms) * time.Millisecond
				retry = &d
			}
		}
	}
}

// The Encoding Standard replaces each maximal ill-formed UTF-8 subsequence with one U+FFFD.
func decodeEventText(p []byte) string {
	if utf8.Valid(p) {
		return string(p)
	}
	var b strings.Builder
	for len(p) > 0 {
		r, n := utf8.DecodeRune(p)
		if r == utf8.RuneError && n == 1 {
			for n < len(p) && !utf8.FullRune(p[:n+1]) {
				n++
			}
		}
		b.WriteRune(r)
		p = p[n:]
	}
	return b.String()
}
