import { $ } from "@typespec/compiler/typekit";
import { SyntaxKind, visitChildren, type Node } from "@typespec/compiler/ast";
import {
  Numeric, getEncode, getProperty, isArrayModelType, resolveEncodedEnumMemberValue,
  resolveEncodedName, serializeValueAsJson, type EnumMember, type Program, type Type, type Value,
} from "@typespec/compiler";

/** EnumMember.value is the compiler's binary64 projection. The source token is exact. */
export function enumWireValue(program: Program, m: EnumMember): string | Numeric {
  const wire = resolveEncodedEnumMemberValue(program, m, "application/json");
  if (typeof wire === "string") return wire;
  const node = m.node?.value ?? m.sourceMember?.node?.value;
  return Numeric(node && "valueAsString" in node ? node.valueAsString : String(wire));
}

/** Serialize defaults recursively using exact numeric tokens, including inside aliased fields. */
export function defaultJSON(program: Program, value: Value, target: Type): string {
  const prop = target.kind === "ModelProperty" ? target : undefined;
  let type = target.kind === "ModelProperty" ? target.type : target;
  if (type.kind === "Union") {
    const exact = program.checker.getValueExactType(value) ?? value.type;
    const match = [...type.variants.values()].find(v => $(program).type.isAssignableTo(exact, v.type));
    if (match) type = match.type;
  }
  if (value.valueKind === "NumericValue" || value.valueKind === "BooleanValue") {
    let enc = prop && getEncode(program, prop);
    for (let s = type.kind === "Scalar" ? type : undefined; s && !enc; s = s.baseScalar) enc = getEncode(program, s);
    const token = value.value.toString();
    return enc?.type.name === "string" ? JSON.stringify(token) : token;
  }
  if (value.valueKind === "EnumValue") {
    const wire = enumWireValue(program, value.value);
    return typeof wire === "string" ? JSON.stringify(wire) : wire.toString();
  }
  if (value.valueKind === "ArrayValue") {
    const items = value.values.map((v, i) => defaultJSON(program, v,
      type.kind === "Tuple" ? type.values[i] : type.kind === "Model" && isArrayModelType(type) ? type.indexer!.value : v.type));
    return "[" + items.join(",") + "]";
  }
  if (value.valueKind === "ObjectValue") {
    const fields = [...value.properties.values()].map(({ name, value: v }) => {
      const field = type.kind === "Model" ? getProperty(type, name) : undefined;
      const wire = field ? resolveEncodedName(program, field, "application/json") : name;
      return JSON.stringify(wire) + ":" + defaultJSON(program, v, field ?? (type.kind === "Model" ? type.indexer?.value : undefined) ?? v.type);
    });
    return "{" + fields.join(",") + "}";
  }
  const json = serializeValueAsJson(program, value, target);
  if (json === undefined) throw new Error("value has no JSON representation");
  return JSON.stringify(json);
}

/**
 * Numeric literals whose exact value the semantic model does not preserve.
 *
 * TypeSpec 1.18 interns literal types by their JavaScript value (`createLiteralType` keys
 * `program.literalTypes` with the binary64 `number`), so two distinct literals that round to the
 * same double — e.g. `9007199254740995` and `9007199254740997`, or `0.1` and
 * `0.10000000000000000001` — share one type, and the later one silently takes the earlier one's
 * exact value (in literal types, defaults, constraints and examples alike). The source text of
 * every numeric literal is compared with the value of its checked type; mismatches cannot be
 * represented faithfully and are reported by the emitters.
 */
export function conflatedNumericLiterals(program: Program): { node: Node; written: string; modelled: string }[] {
  const out: { node: Node; written: string; modelled: string }[] = [];
  for (const file of program.sourceFiles.values()) {
    const visit = (n: Node): void => {
      if (n.kind === SyntaxKind.NumericLiteral) {
        let modelled: string | undefined;
        try {
          const t = program.checker.getTypeForNode(n);
          if (t.kind === "Number") modelled = t.numericValue.toString();
        } catch {
          modelled = undefined;
        }
        const written = Numeric(n.valueAsString).toString();
        if (modelled !== undefined && modelled !== written) out.push({ node: n, written, modelled });
      }
      visitChildren(n, visit);
    };
    visit(file);
  }
  return out;
}
