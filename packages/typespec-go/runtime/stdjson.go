package tsgo

// encoding/json and encoding.Text(Un)Marshaler support for the runtime value types, using the
// TypeSpec default encodings. Generated code uses explicit codecs instead, so property-level
// encodings are honoured; these methods make the types convenient in application code.

// MarshalJSON encodes YYYY-MM-DD.
func (d Date) MarshalJSON() ([]byte, error) { return JSONString(DateText).Encode(d) }

// UnmarshalJSON decodes YYYY-MM-DD.
func (d *Date) UnmarshalJSON(b []byte) error { return decodeInto(d, JSONString(DateText), b) }

// MarshalText encodes YYYY-MM-DD.
func (d Date) MarshalText() ([]byte, error) { s, err := DateText.Format(d); return []byte(s), err }

// UnmarshalText decodes YYYY-MM-DD.
func (d *Date) UnmarshalText(b []byte) error { return parseInto(d, DateText, b) }

// MarshalJSON encodes HH:MM:SS[.fraction].
func (t TimeOfDay) MarshalJSON() ([]byte, error) { return JSONString(TimeOfDayText).Encode(t) }

// UnmarshalJSON decodes HH:MM:SS[.fraction].
func (t *TimeOfDay) UnmarshalJSON(b []byte) error { return decodeInto(t, JSONString(TimeOfDayText), b) }

// MarshalText encodes HH:MM:SS[.fraction].
func (t TimeOfDay) MarshalText() ([]byte, error) {
	s, err := TimeOfDayText.Format(t)
	return []byte(s), err
}

// UnmarshalText decodes HH:MM:SS[.fraction].
func (t *TimeOfDay) UnmarshalText(b []byte) error { return parseInto(t, TimeOfDayText, b) }

// MarshalJSON encodes the ISO 8601 form.
func (d Duration) MarshalJSON() ([]byte, error) { return JSONString(DurationISO8601Text).Encode(d) }

// UnmarshalJSON decodes the ISO 8601 form.
func (d *Duration) UnmarshalJSON(b []byte) error {
	return decodeInto(d, JSONString(DurationISO8601Text), b)
}

// MarshalText encodes the ISO 8601 form.
func (d Duration) MarshalText() ([]byte, error) { return []byte(d.String()), nil }

// UnmarshalText decodes the ISO 8601 form.
func (d *Duration) UnmarshalText(b []byte) error { return parseInto(d, DurationISO8601Text, b) }

// MarshalJSON encodes a JSON number.
func (d Decimal) MarshalJSON() ([]byte, error) { return DecimalCodec.Encode(d) }

// UnmarshalJSON decodes a JSON number.
func (d *Decimal) UnmarshalJSON(b []byte) error { return decodeInto(d, DecimalCodec, b) }

// MarshalJSON encodes a JSON number.
func (i Integer) MarshalJSON() ([]byte, error) { return IntegerCodec.Encode(i) }

// UnmarshalJSON decodes a JSON number.
func (i *Integer) UnmarshalJSON(b []byte) error { return decodeInto(i, IntegerCodec, b) }

func decodeInto[T any](dst *T, c Codec[T], b []byte) error {
	v, err := c.Decode(b)
	if err != nil {
		return err
	}
	*dst = v
	return nil
}

func parseInto[T any](dst *T, tc TextCodec[T], b []byte) error {
	v, err := tc.parse(string(b))
	if err != nil {
		return err
	}
	*dst = v
	return nil
}
