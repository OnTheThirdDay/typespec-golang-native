/**
 * Canonical Go doc comments. gofmt reformats the doc comment of every top-level declaration with
 * go/doc/comment (Go 1.19+): indented spans become code blocks or lists, `` and '' become curly
 * quotes, single-line paragraphs may become headings, link definitions move to the end, and blank
 * lines are inserted around blocks. Documentation from TypeSpec is arbitrary text, so instead of
 * escaping individual constructs the emitter applies the same parse-and-print to each top-level
 * doc comment group of a generated file. This is a port of go/doc/comment's Parser.Parse and
 * Printer.Comment and of go/printer's formatDocComment (go1.26.7; BSD-3-Clause, see
 * THIRD_PARTY_NOTICES.md), restricted to what affects the printed text: the output is a fixed
 * point of gofmt, verified by differential tests against gofmt.
 */

type Text = { kind: "plain"; text: string } | { kind: "link"; text: Text[] };
type Block =
  | { kind: "para"; lines: string[]; text?: Text[] }
  | { kind: "heading"; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; forceBlankBefore: boolean; forceBlankBetween: boolean; items: { number: string; content: { lines: string[]; text?: Text[] }[] }[] };

interface LinkDef {
  text: string;
  url: string;
  used: boolean;
}

/** Rewrites every top-level doc comment group (`//` lines directly above a declaration). */
export function formatDocComments(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!lines[i].startsWith("//")) {
      out.push(lines[i++]);
      continue;
    }
    const start = i;
    while (i < lines.length && lines[i].startsWith("//")) i++;
    const group = lines.slice(start, i);
    out.push(...(i < lines.length && /^(?:type|func|var|const)\b/.test(lines[i]) ? formatDocComment(group) : group));
  }
  return out.join("\n");
}

/** go/printer formatDocComment for a group of `//` comments. */
export function formatDocComment(list: string[]): string[] {
  let text = "";
  const directives: string[] = [];
  for (const c of list) {
    const after = c.slice(2);
    if (isDirective(after)) {
      directives.push(c);
      continue;
    }
    text += (after.startsWith(" ") ? after.slice(1) : after) + "\n";
  }
  if (text === "") return list;
  const printed = fixedPoint(text);
  const out: string[] = [];
  let rest = printed;
  while (rest !== "") {
    const nl = rest.indexOf("\n");
    const line = nl < 0 ? rest : rest.slice(0, nl);
    rest = nl < 0 ? "" : rest.slice(nl + 1);
    out.push(line === "" ? "//" : line.startsWith("\t") ? "//" + line : "// " + line);
  }
  if (directives.length) out.push("//", ...directives);
  return out;
}

/**
 * go/doc/comment is not idempotent (a list followed by indented text, for instance, is printed in
 * a form that parses differently), while gofmt applies one pass to whatever it reads. The comment
 * is therefore iterated to its fixed point; random testing converges within four passes. Should a
 * text not converge, its trimmed non-blank lines form one paragraph, which is stable.
 */
function fixedPoint(text: string): string {
  let t = text;
  for (let i = 0; i < 32; i++) {
    const next = printComment(parse(t));
    if (next === t) return t;
    t = next;
  }
  const flat = text.split("\n").map(trimSpace).filter((l) => l !== "").join("\n") + "\n";
  return printComment(parse(printComment(parse(flat))));
}

function isDirective(c: string): boolean {
  if (c.startsWith("line ") || c.startsWith("extern ") || c.startsWith("export ")) return true;
  const colon = c.indexOf(":");
  if (colon <= 0 || colon + 1 >= c.length) return false;
  for (let i = 0; i <= colon + 1; i++) {
    if (i === colon) continue;
    const b = c.charCodeAt(i);
    if (!((b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39))) return false;
  }
  return true;
}

// ------------------------------------------------------------------------------- parsing

interface Doc {
  content: Block[];
  links: LinkDef[];
  defs: Map<string, LinkDef>;
}

function parse(text: string): Doc {
  const lines = unindent(text.split("\n"));
  const d: Doc = { content: [], links: [], defs: new Map() };
  let prevEnd = 0;
  for (const s of parseSpans(lines)) {
    const ls = lines.slice(s.start, s.end);
    let b: Block | undefined;
    switch (s.kind) {
      case "list":
        b = list(d, ls, prevEnd < s.start);
        break;
      case "code":
        b = { kind: "code", text: [...unindent(ls), ""].join("\n") };
        break;
      case "oldHeading":
        b = { kind: "heading", text: ls[0].trim() };
        break;
      case "heading":
        b = { kind: "heading", text: ls[0].slice(1).trim() };
        break;
      case "para":
        b = paragraph(d, ls);
        break;
    }
    if (b) d.content.push(b);
    prevEnd = s.end;
  }
  for (const b of d.content) {
    if (b.kind === "para") b.text = linkedText(d, b.lines.join("\n"));
    if (b.kind === "list") for (const item of b.items) for (const p of item.content) p.text = linkedText(d, p.lines.join("\n"));
  }
  return d;
}

type SpanKind = "code" | "heading" | "list" | "oldHeading" | "para";

function parseSpans(lines: string[]): { start: number; end: number; kind: SpanKind }[] {
  const spans: { start: number; end: number; kind: SpanKind }[] = [];
  let i = 0;
  let forceIndent = 0;
  for (;;) {
    while (i < lines.length && lines[i] === "") i++;
    if (i >= lines.length) break;
    let kind: SpanKind;
    const start = i;
    let end = i;
    if (i < forceIndent || indented(lines[i])) {
      let unindentedListOK = isList(lines[i]) && i < forceIndent;
      i++;
      while (i < lines.length && (lines[i] === "" || i < forceIndent || indented(lines[i]) || (unindentedListOK && isList(lines[i])))) {
        if (lines[i] === "") unindentedListOK = false;
        i++;
      }
      end = i;
      while (end > start && lines[end - 1] === "") end--;
      if (end < lines.length && lines[end].startsWith("}")) end++;
      kind = isList(lines[start]) ? "list" : "code";
    } else {
      i++;
      while (i < lines.length && lines[i] !== "" && !indented(lines[i])) i++;
      end = i;
      if (i < lines.length && lines[i] !== "" && !isList(lines[i])) {
        if (isList(lines[i - 1])) {
          forceIndent = end;
          end--;
          while (end > start && isList(lines[end - 1])) end--;
        } else if (lines[i - 1].endsWith("{") || lines[i - 1].endsWith("\\")) {
          forceIndent = end;
          end--;
        }
        if (start === end && forceIndent > start) {
          i = start;
          continue;
        }
      }
      if (end - start === 1 && isHeading(lines[start])) kind = "heading";
      else if (end - start === 1 && isOldHeading(lines[start], lines, start)) kind = "oldHeading";
      else kind = "para";
    }
    spans.push({ start, end, kind });
    i = end;
  }
  return spans;
}

const indented = (line: string) => line !== "" && (line[0] === " " || line[0] === "\t");
const isBlank = (s: string) => s.length === 0 || s === "\n";

function leadingSpace(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return s.slice(0, i);
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/** Go's strings.TrimSpace: unicode.IsSpace (no U+FEFF, unlike JavaScript's \s). */
const GO_SPACE_EDGES = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;
function trimSpace(s: string): string {
  return s.replace(GO_SPACE_EDGES, "");
}

function unindent(lines: string[]): string[] {
  let ls = lines;
  while (ls.length && isBlank(ls[0])) ls = ls.slice(1);
  while (ls.length && isBlank(ls[ls.length - 1])) ls = ls.slice(0, -1);
  if (!ls.length) return [];
  let prefix = leadingSpace(ls[0]);
  for (const line of ls.slice(1)) if (!isBlank(line)) prefix = commonPrefix(prefix, leadingSpace(line));
  let out = ls.map((line) => {
    const l = line.startsWith(prefix) ? line.slice(prefix.length) : line;
    return trimSpace(l) === "" ? "" : l;
  });
  while (out.length && out[0] === "") out = out.slice(1);
  while (out.length && out[out.length - 1] === "") out = out.slice(0, -1);
  return out;
}

function isOldHeading(line: string, all: string[], off: number): boolean {
  if (off <= 0 || all[off - 1] !== "" || off + 2 >= all.length || all[off + 1] !== "" || leadingSpace(all[off + 2]) !== "") return false;
  const l = trimSpace(line);
  const first = [...l][0] ?? "";
  if (!/^\p{L}$/u.test(first) || !/^\p{Lu}$/u.test(first)) return false;
  const chars = [...l];
  const last = chars[chars.length - 1] ?? "";
  if (!/^[\p{L}\p{Nd}]$/u.test(last)) return false;
  if ([...";:!?+*/=[]{}_^°&§~%#@<\">\\"].some((c) => l.includes(c))) return false;
  for (let b = l; ; ) {
    const k = b.indexOf("'");
    if (k < 0) break;
    b = b.slice(k + 1);
    if (b !== "s" && !b.startsWith("s ")) return false;
  }
  for (let b = l; ; ) {
    const k = b.indexOf(".");
    if (k < 0) break;
    b = b.slice(k + 1);
    if (b === "" || b.startsWith(" ")) return false;
  }
  return true;
}

function isHeading(line: string): boolean {
  return line.length >= 2 && line[0] === "#" && (line[1] === " " || line[1] === "\t") && trimSpace(line) !== "#";
}

function paragraph(d: Doc, lines: string[]): Block | undefined {
  const defs: LinkDef[] = [];
  for (const line of lines) {
    const def = parseLink(line);
    if (!def) return { kind: "para", lines };
    defs.push(def);
  }
  for (const def of defs) {
    d.links.push(def);
    if (!d.defs.has(def.text)) d.defs.set(def.text, def);
  }
  return undefined;
}

function parseLink(line: string): LinkDef | undefined {
  if (line === "" || line[0] !== "[") return undefined;
  const i = line.indexOf("]:");
  if (i < 0 || i + 3 >= line.length || (line[i + 2] !== " " && line[i + 2] !== "\t")) return undefined;
  const text = line.slice(1, i);
  const url = trimSpace(line.slice(i + 3));
  const j = url.indexOf("://");
  if (j < 0 || !isScheme(url.slice(0, j))) return undefined;
  return { text, url, used: false };
}

function list(d: Doc, lines: string[], forceBlankBefore: boolean): Block {
  const num = listMarker(lines[0])?.num ?? "";
  const l: Block & { kind: "list" } = { kind: "list", forceBlankBefore, forceBlankBetween: false, items: [] };
  let item: (typeof l.items)[number] | undefined;
  let text: string[] = [];
  const flush = () => {
    if (item) {
      const para = paragraph(d, text);
      if (para && para.kind === "para") item.content.push({ lines: para.lines });
    }
    text = [];
  };
  for (let line of lines) {
    const m = listMarker(line);
    if (m && (m.num !== "") === (num !== "")) {
      flush();
      item = { number: m.num, content: [] };
      l.items.push(item);
      line = m.rest;
    }
    line = trimSpace(line);
    if (line === "") {
      l.forceBlankBetween = true;
      flush();
      continue;
    }
    text.push(trimSpace(line));
  }
  flush();
  return l;
}

function listMarker(line: string): { num: string; rest: string } | undefined {
  const l = trimSpace(line);
  if (l === "") return undefined;
  let num: string;
  let rest: string;
  const first = [...l][0];
  if (first === "•" || first === "*" || first === "+" || first === "-") {
    num = "";
    rest = l.slice(first.length);
  } else if (l[0] >= "0" && l[0] <= "9") {
    let n = 1;
    while (n < l.length && l[n] >= "0" && l[n] <= "9") n++;
    if (n >= l.length || (l[n] !== "." && l[n] !== ")")) return undefined;
    num = l.slice(0, n);
    rest = l.slice(n + 1);
  } else return undefined;
  if (!indented(rest) || trimSpace(rest) === "") return undefined;
  return { num, rest };
}

const isList = (line: string) => listMarker(line) !== undefined;

// ------------------------------------------------------------------------------- inline text

function linkedText(d: Doc, text: string): Text[] {
  const out: Text[] = [];
  let wrote = 0;
  const flush = (i: number) => {
    if (wrote < i) {
      out.push(...plainText(text.slice(wrote, i), true));
      wrote = i;
    }
  };
  let start = -1;
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    let c = text[i];
    if (c === "\n" || c === "\t") c = " ";
    if (c === "[") start = i;
    else if (c === "]") {
      if (start >= 0) {
        const def = d.defs.get(buf);
        if (def) {
          def.used = true;
          flush(start);
          out.push({ kind: "link", text: plainText(text.slice(start + 1, i), false) });
          wrote = i + 1;
        }
        // Doc links ([Name], [pkg.Name]) print their text unchanged: identifiers hold no
        // quotes or URLs, so they need no special case here.
      }
      start = -1;
      buf = "";
    }
    if (start >= 0 && i !== start) buf += c;
  }
  flush(text.length);
  return out;
}

/** parseText: `` and '' become curly quotes outside automatic URLs (``` is kept). */
function plainText(s: string, autoLink: boolean): Text[] {
  let w = "";
  let wrote = 0;
  for (let i = 0; i < s.length; ) {
    const t = s.slice(i);
    if (autoLink) {
      const url = autoURL(t);
      if (url !== undefined) {
        i += url.length;
        continue;
      }
      // ident: [\pL_][\pL_0-9]* with ASCII digits only; an identifier is skipped as a whole.
      const id = /^(?:[A-Za-z_]|\p{L})(?:[A-Za-z0-9_]|\p{L})*/u.exec(t);
      if (id) {
        i += id[0].length;
        continue;
      }
    }
    if (t.startsWith("``")) {
      if (t.length >= 3 && t[2] === "`") {
        i += 3;
        while (i < s.length && s[i] === "`") i++;
        continue;
      }
      w += s.slice(wrote, i) + "“";
      i += 2;
      wrote = i;
    } else if (t.startsWith("''")) {
      w += s.slice(wrote, i) + "”";
      i += 2;
      wrote = i;
    } else i++;
  }
  w += s.slice(wrote);
  return w ? [{ kind: "plain", text: w }] : [];
}

function autoURL(s: string): string | undefined {
  // Byte-oriented in Go; URL characters are ASCII, so UTF-16 indexing is equivalent here.
  if (s.length < 7) return undefined;
  let i: number;
  if (s[3] === ":") i = 3;
  else if (s[4] === ":") i = 4;
  else if (s[5] === ":") i = 5;
  else if (s[6] === ":") i = 6;
  else return undefined;
  if (i + 3 > s.length || s.slice(i, i + 3) !== "://") return undefined;
  if (!isScheme(s.slice(0, i))) return undefined;
  i += 3;
  if (i >= s.length || !isHost(s[i]) || isPunct(s[i])) return undefined;
  i++;
  let end = i;
  while (i < s.length && isHost(s[i])) {
    if (!isPunct(s[i])) end = i + 1;
    i++;
  }
  i = end;
  const stk: string[] = [];
  end = i;
  for (; i < s.length; i++) {
    if (isPunct(s[i])) continue;
    if (!isPath(s[i])) break;
    const c = s[i];
    if (c === "(") stk.push(")");
    else if (c === "{") stk.push("}");
    else if (c === "[") stk.push("]");
    else if (c === ")" || c === "}" || c === "]") {
      if (!stk.length || stk[stk.length - 1] !== c) break;
      stk.pop();
    }
    if (!stk.length) end = i + 1;
  }
  return s.slice(0, end);
}

const isScheme = (s: string) => ["file", "ftp", "gopher", "http", "https", "mailto", "nntp"].includes(s);
const isHost = (c: string) => /^[A-Za-z0-9_@\-.[\]:]$/.test(c);
const isPunct = (c: string) => /^[.,:;?!]$/.test(c);
const isPath = (c: string) => /^[A-Za-z0-9$'()*+&#=@~_/\-[\]{}%]$/.test(c);

// ------------------------------------------------------------------------------- printing

function printComment(d: Doc): string {
  let out = "";
  d.content.forEach((x, i) => {
    if (i > 0 && blankBefore(x)) out += "\n";
    out += printBlock(x);
  });
  for (const used of [true, false]) {
    let first = true;
    for (const def of d.links) {
      if (def.used !== used) continue;
      if (first) {
        out += "\n";
        first = false;
      }
      out += `[${def.text}]: ${def.url}\n`;
    }
  }
  return out;
}

function blankBetween(l: Block & { kind: "list" }): boolean {
  return l.forceBlankBetween || l.items.some((item) => item.content.length !== 1);
}

function blankBefore(x: Block): boolean {
  return x.kind !== "list" || x.forceBlankBefore || blankBetween(x);
}

function printBlock(x: Block): string {
  switch (x.kind) {
    case "para":
      return printText("", x.text ?? []) + "\n";
    case "heading":
      return "# " + x.text + "\n";
    case "code": {
      let out = "";
      for (const line of x.text.split("\n").slice(0, -1)) out += (line !== "" ? "\t" + line : "") + "\n";
      return out;
    }
    case "list": {
      const loose = blankBetween(x);
      let out = "";
      x.items.forEach((item, i) => {
        if (i > 0 && loose) out += "\n";
        out += " " + (item.number === "" ? " - " : item.number + ". ");
        item.content.forEach((blk, j) => {
          if (j > 0) out += "\n    ";
          out += printText("    ", blk.text ?? []) + "\n";
        });
      });
      return out;
    }
  }
}

function printText(indent: string, xs: Text[]): string {
  let out = "";
  for (const t of xs) {
    const s = t.kind === "plain" ? t.text : "[" + printText(indent, t.text) + "]";
    out += t.kind === "plain" ? s.split("\n").join("\n" + indent) : s;
  }
  return out;
}

/** go/doc/comment Printer.Comment(Parser.Parse(text)) (exposed for differential tests). */
export function canonicalDocText(text: string): string {
  return printComment(parse(text));
}
