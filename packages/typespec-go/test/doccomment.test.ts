/**
 * Documentation text is arbitrary; gofmt reformats top-level doc comments (go/doc/comment).
 * Differential tests: the port matches Go's parser and printer, and generated doc comments are
 * gofmt fixed points, for adversarial samples and for seeded random documents combining every
 * construct go/doc/comment recognizes.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalDocText, formatDocComments } from "../src/doccomment.js";
import { docComment, goFile } from "../src/gowriter.js";

const FRAGMENTS = [
  "plain text", "a ``quoted'' word", "triple ``` backticks ``` stay", "it's fine", "Title Case Heading", "Heading", "Version 2", "Mr. Smith",
  "A.B notation", "ends with colon:", "  indented code", "\tcode with tab", "    deeper code", "- item", "* star item", "+ plus item", "• bullet",
  "1. one", "2) two", "  - nested item", "   10. ten", "- ", "1.", "# Heading", "#not heading", "# ", "[go]: https://go.dev", "[x]: ftp://host/path",
  "use [go] here", "[go] ``q''", "see https://example.com/a''b(c) end", "http://x.y/``z`` and ''tail''", "func() {", "}", "trailing backslash \\",
  "", "", "Ünïcode Heading", "日本語のテキスト", "tab\tinside", "[fmt.Println] doc link", "[*Widget] star", "number 3.14 and 2.", "'' leading",
  "Deprecated: use Other.", "go:generate looks like a directive", "nbsp inside", " separator", "{", "  }", "x := map[string]int{",
];

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

function randomDoc(next: () => number): string {
  const n = 1 + Math.floor(next() * 12);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    let l = FRAGMENTS[Math.floor(next() * FRAGMENTS.length)];
    if (next() < 0.2) l = " ".repeat(1 + Math.floor(next() * 4)) + l;
    lines.push(l);
  }
  return lines.join("\n");
}

const tmp = join(import.meta.dirname, ".tmp", "doccomment");

function gofmtDiff(source: string, name: string): string {
  mkdirSync(tmp, { recursive: true });
  const file = join(tmp, `${name}.go`);
  writeFileSync(file, source);
  try {
    return execFileSync("gofmt", ["-d", file], { encoding: "utf8", maxBuffer: 1 << 26 });
  } catch (e: any) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

/** A Go file declaring one type per document, documented the way the emitter documents types. */
function fileOf(docs: string[]): string {
  const body = docs
    .map((d, i) => docComment(`T${i} is documented.\n${d}`) + `type T${i} struct {\n\t// F is a field.\n${docComment(d, "\t")}\tF int\n}\n\n` + docComment(d) + `func (T${i}) M() {}\n`)
    .join("\n");
  return goFile("docs", body, {});
}

const REFERENCE = [
  "package main",
  "",
  "import (",
  '\t"encoding/json"',
  '\t"go/doc/comment"',
  '\t"os"',
  ")",
  "",
  "func main() {",
  "\tvar docs []string",
  "\tif err := json.NewDecoder(os.Stdin).Decode(&docs); err != nil {",
  "\t\tpanic(err)",
  "\t}",
  "\tout := make([]string, len(docs))",
  "\tfor i, d := range docs {",
  "\t\tvar p comment.Parser",
  "\t\tvar pr comment.Printer",
  "\t\tout[i] = string(pr.Comment(p.Parse(d)))",
  "\t}",
  "\t_ = json.NewEncoder(os.Stdout).Encode(out)",
  "}",
  "",
].join("\n");

describe("doc comments", () => {
  it("match go/doc/comment on random documentation", () => {
    // Reference: Go's own parser and printer from the installed toolchain.
    const dir = join(import.meta.dirname, ".tmp", "docref");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "go.mod"), "module docref\n\ngo 1.24\n");
    writeFileSync(join(dir, "main.go"), REFERENCE);
    const next = rng(42);
    const docs = Array.from({ length: 3000 }, () => randomDoc(next).split("\n").map((l) => l.trimEnd()).join("\n") + "\n");
    const ref: string[] = JSON.parse(execFileSync("go", ["run", "."], { cwd: dir, input: JSON.stringify(docs), encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, GOWORK: "off" } }));
    const mismatches = docs.filter((d, i) => canonicalDocText(d) !== ref[i]).map((d) => ({ doc: d, go: ref[docs.indexOf(d)], port: canonicalDocText(d) }));
    expect(mismatches.slice(0, 3)).toEqual([]);
  });

  it("are gofmt fixed points for adversarial documentation", () => {
    const docs = [
      "Has ``double backticks'' and `single`.",
      "Overview\n\nText after an old-style heading.\n\nMore.",
      "Intro\n    indented block\n      deeper\nback to text",
      "- a\n- b\n  - indented list\n1. numbered\n  1. indented numbered",
      "[link]: https://example.com\nText with [link].\n[unused]: https://example.org",
      "Code:\n\n\tfunc f() {\n\t\treturn\n\t}\n\nAfter.",
      "func() {\nbody line\n}",
      "# Heading\n\nParagraph.\n\n# Another",
      "Line ending with a brace {\nnext line",
      // go/doc/comment is not idempotent on this one: it needs two passes.
      "2) two\n 2. two\n    indented code\n\n\t}\n\n1. one",
    ];
    const src = fileOf(docs);
    expect(gofmtDiff(src, "adversarial")).toBe("");
    expect(formatDocComments(src)).toBe(src);
  });

  it("are gofmt fixed points for random documentation (seeded)", () => {
    const next = rng(20261127);
    const docs = Array.from({ length: 2000 }, () => randomDoc(next));
    const src = fileOf(docs);
    expect(gofmtDiff(src, "random")).toBe("");
    expect(formatDocComments(src)).toBe(src);
  });

  it("leaves comments that are not doc comments of declarations unchanged", () => {
    const src = "package p\n\n// Free ``comment''\n\nvar (\n\t// Spec ``doc''\n\tX = 1\n)\n";
    expect(formatDocComments(src)).toBe(src);
    rmSync(tmp, { recursive: true, force: true });
  });
});
