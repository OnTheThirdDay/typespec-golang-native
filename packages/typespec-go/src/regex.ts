import { RegExpParser, type AST } from "@eslint-community/regexpp";

export type RegexResult = { ok: true; pattern: string } | { ok: false; feature: string };
const parser = new RegExpParser();
const classes = new Map<string, string>();

function rune(cp: number): string {
  if (cp >= 0xd800 && cp <= 0xdfff) throw new Error("lone surrogates");
  return `\\x{${cp.toString(16)}}`;
}

// Resolve Unicode properties using the generator's ECMAScript tables. RE2 and the host
// JS runtime may ship different Unicode versions and recognize different property names.
function characterSet(raw: string): string {
  const cached = classes.get(raw);
  if (cached !== undefined) return cached;
  const predicate = new RegExp(raw, "u");
  const intervals: string[] = [];
  let start = -1;
  for (let cp = 0; cp <= 0x110000; cp++) {
    const matches = cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) && predicate.test(String.fromCodePoint(cp));
    if (matches && start < 0) start = cp;
    if (!matches && start >= 0) {
      intervals.push(start === cp - 1 ? rune(start) : rune(start) + "-" + rune(cp - 1));
      start = -1;
    }
  }
  const pattern = intervals.length ? "[" + intervals.join("") + "]" : "[^\\x00-\\x{10ffff}]";
  if (classes.size >= 128) classes.clear();
  classes.set(raw, pattern);
  return pattern;
}

function alternatives(nodes: AST.Alternative[], repeats: number): string {
  return nodes.map(a => a.elements.map(e => translate(e, repeats)).join("")).join("|");
}

function translate(node: AST.Element, repeats: number): string {
  switch (node.type) {
    case "Character":
      return /^[a-zA-Z0-9 _]$/.test(node.raw) ? node.raw : rune(node.value);
    case "Assertion":
      if (node.kind === "lookahead" || node.kind === "lookbehind") throw new Error("lookaround assertions");
      return node.raw;
    case "Backreference":
      throw new Error("backreferences");
    case "Group":
    case "CapturingGroup":
      if (node.type === "Group" && node.modifiers) throw new Error("group modifiers");
      return "(?:" + alternatives(node.alternatives, repeats) + ")";
    case "Quantifier": {
      const suffix = node.raw.slice(node.element.end - node.start);
      // Go regexp/syntax limits the product of nested counted repetitions to 1000.
      const bound = suffix.startsWith("{") ? Math.max(1, Number.isFinite(node.max) ? node.max : node.min) : 1;
      if (repeats * bound > 1000) throw new Error("RE2 repetition limit (1000)");
      return translate(node.element, repeats * bound) + suffix;
    }
    case "CharacterSet":
      if (node.kind === "digit" || node.kind === "word") return node.raw;
      if (node.kind === "any") return "[^\\n\\r\\x{2028}\\x{2029}]";
      return characterSet(node.raw);
    case "CharacterClass":
      if (!node.unicodeSets && node.elements.length && node.elements.every(e => e.type === "Character" || e.type === "CharacterClassRange")) {
        return "[" + (node.negate ? "^" : "") + node.elements.map(e => {
          if (e.type === "CharacterClassRange") return rune(e.min.value) + "-" + rune(e.max.value);
          return rune((e as AST.Character).value);
        }).join("") + "]";
      }
      return characterSet(node.raw);
    default:
      throw new Error("Unicode set operations require a different regular-expression mode");
  }
}

/** Compile a Unicode-mode ECMAScript predicate into a Go RE2 predicate at generation time. */
export function translateEcmaRegex(src: string): RegexResult {
  try {
    const ast = parser.parsePattern(src, 0, src.length, { unicode: true });
    return { ok: true, pattern: alternatives(ast.alternatives, 1) };
  } catch (e) {
    const detail = (e as Error).message;
    return { ok: false, feature: detail.includes("Invalid escape") ? "invalid Unicode-mode identity escape" : detail };
  }
}
