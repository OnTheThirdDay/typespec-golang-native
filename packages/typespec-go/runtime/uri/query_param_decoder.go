// Code in this package is copied from github.com/ogen-go/ogen/uri at commit
// 3d90c0ca96cc3a28db44d4088da22f7890875ac3 (Apache-2.0, see LICENSE.ogen) and adapted:
// github.com/go-faster/errors was replaced by the standard library and ogen-internal
// packages (validate, httpcookie) by local equivalents.

package uri

import (
	"fmt"
	"net/url"
	"strings"

	"errors"
)

type queryParamDecoder struct {
	values       url.Values
	objectFields []QueryParameterObjectField

	paramName string
	style     QueryStyle // immutable
	explode   bool       // immutable
}

func (d *queryParamDecoder) DecodeValue() (string, error) {
	switch d.style {
	case QueryStyleForm:
		values, ok := d.values[d.paramName]
		if !ok {
			return "", fmt.Errorf("query parameter %q not set", d.paramName)
		}

		if len(values) != 1 {
			return "", fmt.Errorf("query parameter %q multiple values", d.paramName)
		}

		return values[0], nil
	case QueryStyleSpaceDelimited,
		QueryStylePipeDelimited,
		QueryStyleDeepObject:
		return "", fmt.Errorf("style %q cannot be used for primitive values", d.style)
	default:
		panic("unreachable")
	}
}

func (d *queryParamDecoder) DecodeArray(f func(d Decoder) error) error {
	values, ok := d.values[d.paramName]
	if !ok {
		return fmt.Errorf("query parameter %q not set", d.paramName)
	}

	switch d.style {
	case QueryStyleForm:
		if d.explode {
			for _, item := range values {
				if err := f(&constval{item}); err != nil {
					return err
				}
			}
			return nil
		}

		if len(values) != 1 {
			return errors.New("invalid value")
		}

		// do not decode `?param=` as `[""]` and leave the parameter as whatever zero value it has
		if values[0] == "" {
			return nil
		}

		for item := range strings.SplitSeq(values[0], ",") {
			if err := f(&constval{item}); err != nil {
				return err
			}
		}

		return nil

	case QueryStyleSpaceDelimited:
		if d.explode {
			for _, item := range values {
				if err := f(&constval{item}); err != nil {
					return err
				}
			}
			return nil
		}

		if len(values) != 1 {
			return errors.New("invalid value")
		}

		// do not decode `?param=` as `[""]` and leave the parameter as whatever zero value it has
		if values[0] == "" {
			return nil
		}

		for item := range strings.SplitSeq(values[0], " ") {
			if err := f(&constval{item}); err != nil {
				return err
			}
		}

		return nil

	case QueryStylePipeDelimited:
		if d.explode {
			for _, item := range values {
				if err := f(&constval{item}); err != nil {
					return err
				}
			}
			return nil
		}

		if len(values) != 1 {
			return errors.New("invalid value")
		}

		for item := range strings.SplitSeq(values[0], "|") {
			if err := f(&constval{item}); err != nil {
				return err
			}
		}

		return nil

	case QueryStyleDeepObject:
		return fmt.Errorf("style %q cannot be used for arrays", d.style)

	default:
		panic("unreachable")
	}
}

func (d *queryParamDecoder) DecodeFields(f func(name string, d Decoder) error) error {
	adapter := func(name, value string) error { return f(name, &constval{value}) }
	switch d.style {
	case QueryStyleForm:
		if d.explode {
			for _, field := range d.objectFields {
				values, ok := d.values[field.Name]
				if !ok || len(values) == 0 {
					if !field.Required {
						continue
					}
					return fmt.Errorf("query parameter %q field %q not set", d.paramName, field.Name)
				}

				if len(values) > 1 {
					return fmt.Errorf("query parameter %q field %q multiple values", d.paramName, field.Name)
				}

				if err := adapter(field.Name, values[0]); err != nil {
					return err
				}
			}

			return nil
		}

		values, ok := d.values[d.paramName]
		if !ok {
			return fmt.Errorf("query parameter %q not set", d.paramName)
		}

		if len(values) > 1 {
			return fmt.Errorf("query parameter %q multiple values", d.paramName)
		}

		cur := &cursor{src: values[0]}
		return decodeObject(cur, ',', ',', adapter)

	case QueryStyleSpaceDelimited:
		panic("object cannot have spaceDelimited style")

	case QueryStylePipeDelimited:
		panic("object cannot have pipeDelimited style")

	case QueryStyleDeepObject:
		if !d.explode {
			panic("invalid deepObject style configuration")
		}

		// Maintain a map of seen keys to avoid additional processing.
		seenQueryParams := map[string]bool{}

		for _, field := range d.objectFields {
			qparam := d.paramName + "[" + field.Name + "]"
			seenQueryParams[qparam] = true
			values, ok := d.values[qparam]
			if !ok || len(values) == 0 {
				if !field.Required {
					continue
				}
				return fmt.Errorf("query parameter %q field %q not set", d.paramName, qparam)
			}

			if len(values) > 1 {
				return fmt.Errorf("query parameter %q field %q multiple values", d.paramName, qparam)
			}

			if err := adapter(field.Name, values[0]); err != nil {
				return err
			}
		}

		// With PatternProperties/AdditionalProperties, we do not know the names of these properties.
		// Therefore, we just iterate over all query parameters that start with the prefix.
		for k, values := range d.values {
			qparam := k

			if !strings.HasPrefix(qparam, d.paramName) {
				// This query parameter does not start with the prefix, so we skip it.
				continue
			}

			// To construct the field name, we need to remove the prefix while also removing the brackets.
			// For example:
			//   ?paramName[fieldName]=value => fieldName=value
			//   ?paramName[fieldName][subField1]=value => fieldName[subField1]=value
			//   ?paramName[fieldName][subField1][subSubField1]=value => fieldName[subField1][subSubField1]=value
			fieldName := strings.TrimPrefix(qparam, d.paramName)
			firstOpenBracket := strings.Index(fieldName, "[")
			firstCloseBracket := strings.Index(fieldName, "]")
			if firstOpenBracket != -1 && firstCloseBracket != -1 {
				// Remove the first open and close brackets to get the field name.
				fieldName = fieldName[firstOpenBracket+1:firstCloseBracket] + fieldName[firstCloseBracket+1:]
			}

			if _, ok := seenQueryParams[qparam]; ok {
				// This value was well-formed as part of the predefined d.objectFields, so we do not need to
				// process it again.
				continue
			}

			if len(values) == 0 {
				return fmt.Errorf("query parameter %q field %q not set", d.paramName, qparam)
			}

			if len(values) > 1 {
				return fmt.Errorf("query parameter %q field %q multiple values", d.paramName, qparam)
			}

			if err := adapter(fieldName, values[0]); err != nil {
				return err
			}
		}

		return nil

	default:
		panic("unreachable")
	}
}
