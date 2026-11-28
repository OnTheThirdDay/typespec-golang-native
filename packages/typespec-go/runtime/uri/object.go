// Code in this package is copied from github.com/ogen-go/ogen/uri at commit
// 3d90c0ca96cc3a28db44d4088da22f7890875ac3 (Apache-2.0, see LICENSE.ogen) and adapted:
// github.com/go-faster/errors was replaced by the standard library and ogen-internal
// packages (validate, httpcookie) by local equivalents.

package uri

import "strings"

type Field struct {
	Name  string
	Value string
}

func encodeObject(kvSep, fieldSep byte, fields []Field) string {
	var (
		sb   strings.Builder
		size int
	)
	// Preallocate the buffer.
	{
		for _, f := range fields {
			size += len(f.Name) + len(f.Value) + 2
		}
		if len(fields) == 1 {
			// If there are less than 2 fields, we don't need to add the field separator.
			size--
		}
	}
	sb.Grow(size)
	for i, f := range fields {
		if i > 0 {
			sb.WriteByte(fieldSep)
		}
		sb.WriteString(f.Name)
		sb.WriteByte(kvSep)
		sb.WriteString(f.Value)
	}
	return sb.String()
}

func decodeObject(cur *cursor, kvSep, fieldSep byte, f func(field, value string) error) error {
	var (
		fname string
		field = true
	)

	for {
		until := fieldSep
		if field {
			until = kvSep
		}

		v, hasNext, err := cur.readValue(until)
		if err != nil {
			return err
		}

		if field {
			fname = v
			field = false
			continue
		}

		field = true
		if err := f(fname, v); err != nil {
			return err
		}

		if !hasNext {
			return nil
		}
	}
}
