package tsgo

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"unicode/utf8"
)

// XMLName is an element or attribute name with an optional namespace (TypeSpec.Xml.@ns).
type XMLName struct {
	Space  string // namespace URI ("" for none)
	Prefix string // preferred prefix when Space is set
	Local  string
}

// XMLNode is a minimal element tree used by generated XML (de)serialization.
type XMLNode struct {
	Name     XMLName
	Attrs    []XMLAttr
	Children []*XMLNode
	Text     string
}

// XMLAttr is one attribute.
type XMLAttr struct {
	Name  XMLName
	Value string
}

// NewXMLNode creates an element.
func NewXMLNode(name XMLName) *XMLNode { return &XMLNode{Name: name} }

// AddText appends a child element holding text.
func (n *XMLNode) AddText(name XMLName, text string) {
	n.Children = append(n.Children, &XMLNode{Name: name, Text: text})
}

// Add appends a child element.
func (n *XMLNode) Add(child *XMLNode) { n.Children = append(n.Children, child) }

// SetAttr adds an attribute.
func (n *XMLNode) SetAttr(name XMLName, value string) {
	n.Attrs = append(n.Attrs, XMLAttr{Name: name, Value: value})
}

func (q XMLName) matches(name xml.Name) bool {
	return q.Local == name.Local && q.Space == name.Space
}

// Children returns the child elements with the given name.
func (n *XMLNode) ChildrenNamed(name XMLName) []*XMLNode {
	var out []*XMLNode
	for _, c := range n.Children {
		if c.Name.Local == name.Local && c.Name.Space == name.Space {
			out = append(out, c)
		}
	}
	return out
}

// Child returns the single child element with the given name; it fails if repeated.
func (n *XMLNode) Child(name XMLName) (*XMLNode, error) {
	cs := n.ChildrenNamed(name)
	switch len(cs) {
	case 0:
		return nil, nil
	case 1:
		return cs[0], nil
	}
	return nil, &DecodeError{Path: "/" + name.Local, Err: errors.New("element must not be repeated")}
}

// Attr returns an attribute value.
func (n *XMLNode) Attr(name XMLName) (string, bool) {
	for _, a := range n.Attrs {
		if a.Name.Local == name.Local && a.Name.Space == name.Space {
			return a.Value, true
		}
	}
	return "", false
}

// CheckContent checks the expanded names (namespace URI and local name) of the immediate
// children and attributes. Whitespace between children is permitted for pretty printing.
func (n *XMLNode) CheckContent(elements, attrs []XMLName, text bool) error {
	return n.checkContent(elements, attrs, text, false)
}

// CheckRecordContent permits dynamic entry names. Record wrappers have no attributes or character data.
func (n *XMLNode) CheckRecordContent() error {
	return n.checkContent(nil, nil, false, true)
}

func (n *XMLNode) checkContent(elements, attrs []XMLName, text, record bool) error {
	known := func(name XMLName, names []XMLName) bool {
		for _, q := range names {
			if q.Local == name.Local && q.Space == name.Space {
				return true
			}
		}
		return false
	}
	for _, c := range n.Children {
		if !record && !known(c.Name, elements) {
			return XMLPath(c.Name.Local, errors.New("unknown XML element"))
		}
	}
	for _, a := range n.Attrs {
		if !known(a.Name, attrs) {
			return XMLPath(a.Name.Local, errors.New("unknown XML attribute"))
		}
	}
	if !text && strings.Trim(n.Text, " \t\r\n") != "" {
		return errors.New("unexpected XML text")
	}
	return nil
}

// ElementChildren returns all child elements (records).
func (n *XMLNode) ElementChildren() []*XMLNode { return n.Children }

// ParseXML parses a document into an element tree. DTDs are rejected.
func ParseXML(data []byte) (*XMLNode, error) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	var stack []*XMLNode
	var root *XMLNode
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, &DecodeError{Err: fmt.Errorf("invalid XML: %w", err)}
		}
		switch t := tok.(type) {
		case xml.StartElement:
			n := &XMLNode{Name: XMLName{Space: t.Name.Space, Local: t.Name.Local}}
			seen := make(map[xml.Name]bool, len(t.Attr))
			for _, a := range t.Attr {
				if seen[a.Name] {
					return nil, &DecodeError{Err: fmt.Errorf("duplicate XML attribute %q", a.Name.Local)}
				}
				seen[a.Name] = true
				if a.Name.Space == "xmlns" || (a.Name.Space == "" && a.Name.Local == "xmlns") {
					continue
				}
				n.Attrs = append(n.Attrs, XMLAttr{Name: XMLName{Space: a.Name.Space, Local: a.Name.Local}, Value: a.Value})
			}
			if len(stack) == 0 {
				if root != nil {
					return nil, &DecodeError{Err: errors.New("invalid XML: several root elements")}
				}
				root = n
			} else {
				stack[len(stack)-1].Children = append(stack[len(stack)-1].Children, n)
			}
			stack = append(stack, n)
		case xml.EndElement:
			stack = stack[:len(stack)-1]
		case xml.CharData:
			if len(stack) > 0 {
				stack[len(stack)-1].Text += string(t)
			} else if strings.TrimSpace(string(t)) != "" {
				return nil, &DecodeError{Err: errors.New("invalid XML: text outside the root element")}
			}
		case xml.Directive:
			return nil, &DecodeError{Err: errors.New("XML directives (DTDs) are not accepted")}
		}
	}
	if root == nil {
		return nil, &DecodeError{Err: errors.New("invalid XML: no root element")}
	}
	return root, nil
}

// TextContent returns the element text; whitespace-only text of elements with children is ignored.
func (n *XMLNode) TextContent() string { return n.Text }

// XML record keys and preferred prefixes become markup names. Verify the same NCName
// grammar the standard decoder accepts, including Unicode names.
func validXMLName(s string) bool {
	if s == "" || strings.Contains(s, ":") {
		return false
	}
	for i, c := range s {
		if c > 127 {
			d := xml.NewDecoder(strings.NewReader("<" + s + "/>"))
			tok, err := d.Token()
			elem, ok := tok.(xml.StartElement)
			return err == nil && ok && elem.Name.Space == "" && elem.Name.Local == s
		}
		if c == '_' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' ||
			i > 0 && (c == '-' || c == '.' || c >= '0' && c <= '9') {
			continue
		}
		return false
	}
	return true
}

func validXMLText(s string) bool {
	if !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 0x20 && r != '\t' && r != '\n' && r != '\r' || r == 0xfffe || r == 0xffff {
			return false
		}
	}
	return true
}

// EncodeXML serializes the tree with an XML declaration. Namespace declarations are placed on
// the root element and every namespaced name is written with a prefix: a default namespace
// (xmlns="...") would move unprefixed descendants into that namespace. Names without a
// preferred prefix reuse the prefix declared elsewhere in the document or get ns0, ns1, ...
func EncodeXML(root *XMLNode) ([]byte, error) {
	prefixes := map[string]string{} // namespace → prefix
	used := map[string]string{}     // prefix → namespace
	var all []XMLName
	var collect func(n *XMLNode) error
	collect = func(n *XMLNode) error {
		if n == nil || !validXMLText(n.Text) {
			return errors.New("invalid XML element or text")
		}
		all = append(all, n.Name)
		seen := make(map[xml.Name]bool, len(n.Attrs))
		for _, a := range n.Attrs {
			key := xml.Name{Space: a.Name.Space, Local: a.Name.Local}
			if seen[key] || a.Name.Space == "" && a.Name.Local == "xmlns" || !validXMLText(a.Value) {
				return fmt.Errorf("invalid or duplicate XML attribute %q", a.Name.Local)
			}
			seen[key] = true
			all = append(all, a.Name)
		}
		for _, c := range n.Children {
			if err := collect(c); err != nil {
				return err
			}
		}
		return nil
	}
	if err := collect(root); err != nil {
		return nil, err
	}
	for _, q := range all {
		if !validXMLName(q.Local) || q.Prefix != "" && (!validXMLName(q.Prefix) || q.Space == "") || !validXMLText(q.Space) {
			return nil, fmt.Errorf("invalid XML name %q with prefix %q", q.Local, q.Prefix)
		}
		if q.Prefix == "xmlns" || q.Space == "http://www.w3.org/2000/xmlns/" || q.Prefix == "xml" && q.Space != "http://www.w3.org/XML/1998/namespace" {
			return nil, fmt.Errorf("invalid reserved XML namespace %q", q.Space)
		}
		if q.Space == "http://www.w3.org/XML/1998/namespace" {
			if q.Prefix != "" && q.Prefix != "xml" {
				return nil, errors.New("reserved XML namespace needs prefix xml")
			}
			prefixes[q.Space], used["xml"] = "xml", q.Space
		}
		if q.Space == "" || q.Prefix == "" {
			continue
		}
		if p, ok := prefixes[q.Space]; ok && p != q.Prefix {
			return nil, fmt.Errorf("namespace %s used with prefixes %q and %q", q.Space, p, q.Prefix)
		}
		if ns, ok := used[q.Prefix]; ok && ns != q.Space {
			return nil, fmt.Errorf("prefix %q bound to %s and %s", q.Prefix, ns, q.Space)
		}
		prefixes[q.Space], used[q.Prefix] = q.Prefix, q.Space
	}
	for _, q := range all {
		if q.Space == "" || prefixes[q.Space] != "" {
			continue
		}
		for i := 0; ; i++ {
			p := fmt.Sprintf("ns%d", i)
			if _, taken := used[p]; !taken {
				prefixes[q.Space], used[p] = p, q.Space
				break
			}
		}
	}
	var buf bytes.Buffer
	buf.WriteString(xml.Header)
	qname := func(q XMLName) string {
		if q.Space != "" {
			return prefixes[q.Space] + ":" + q.Local
		}
		return q.Local
	}
	var write func(n *XMLNode, isRoot bool)
	write = func(n *XMLNode, isRoot bool) {
		buf.WriteString("<" + qname(n.Name))
		if isRoot {
			spaces := make([]string, 0, len(prefixes))
			for s := range prefixes {
				spaces = append(spaces, s)
			}
			sort.Slice(spaces, func(i, j int) bool { return prefixes[spaces[i]] < prefixes[spaces[j]] })
			for _, s := range spaces {
				buf.WriteString(" xmlns:" + prefixes[s] + `="`)
				xml.EscapeText(&buf, []byte(s))
				buf.WriteString(`"`)
			}
		}
		for _, a := range n.Attrs {
			buf.WriteString(" " + qname(a.Name) + `="`)
			xml.EscapeText(&buf, []byte(a.Value))
			buf.WriteString(`"`)
		}
		if len(n.Children) == 0 && n.Text == "" {
			buf.WriteString("/>")
			return
		}
		buf.WriteString(">")
		xml.EscapeText(&buf, []byte(n.Text))
		for _, c := range n.Children {
			write(c, false)
		}
		buf.WriteString("</" + qname(n.Name) + ">")
	}
	write(root, true)
	return buf.Bytes(), nil
}

// XMLPath prefixes decoding errors with an element name.
func XMLPath(name string, err error) error { return WithPath(name, err) }

// RequireXMLRoot checks the root element name.
func RequireXMLRoot(n *XMLNode, name XMLName) error {
	if n.Name.Local != name.Local || n.Name.Space != name.Space {
		return &DecodeError{Err: fmt.Errorf("expected root element %s, got %s", name.Local, n.Name.Local)}
	}
	return nil
}

// XMLEquivalent compares two XML documents structurally: names (namespace URI + local name),
// attributes (any order), child order and text; whitespace-only text between elements and
// namespace prefixes are ignored.
func XMLEquivalent(a, b []byte) (bool, error) {
	x, err := ParseXML(a)
	if err != nil {
		return false, err
	}
	y, err := ParseXML(b)
	if err != nil {
		return false, err
	}
	return nodeEqual(x, y), nil
}

func nodeEqual(a, b *XMLNode) bool {
	if a.Name.Local != b.Name.Local || a.Name.Space != b.Name.Space || len(a.Attrs) != len(b.Attrs) || len(a.Children) != len(b.Children) {
		return false
	}
	for _, at := range a.Attrs {
		if v, ok := b.Attr(at.Name); !ok || v != at.Value {
			return false
		}
	}
	ta, tb := a.Text, b.Text
	if len(a.Children) > 0 {
		ta, tb = strings.TrimSpace(ta), strings.TrimSpace(tb)
	}
	if ta != tb {
		return false
	}
	for i := range a.Children {
		if !nodeEqual(a.Children[i], b.Children[i]) {
			return false
		}
	}
	return true
}
