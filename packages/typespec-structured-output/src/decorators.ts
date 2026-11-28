import type { DecoratorContext, Enum, Model, ModelProperty, Program } from "@typespec/compiler";
import { reportDiagnostic, StateKeys } from "./lib.js";

export function $structuredOutput(context: DecoratorContext, target: Model, name?: string): void {
  context.program.stateMap(StateKeys.structuredOutput).set(target, { name });
}

export interface StructuredOutputRoot {
  model: Model;
  name?: string;
}

export function getStructuredOutputRoots(program: Program): StructuredOutputRoot[] {
  const out: StructuredOutputRoot[] = [];
  for (const [model, value] of program.stateMap(StateKeys.structuredOutput)) {
    out.push({ model: model as Model, name: (value as { name?: string }).name });
  }
  return out;
}

export function $schemaName(context: DecoratorContext, target: Model | Enum, name: string): void {
  // TypeSpec re-applies decorators to `model X is Y` and spreads: the name belongs to the
  // declaration that writes the decorator (template instances share that declaration).
  const declaredOn = (context.decoratorTarget as { parent?: unknown }).parent;
  if (declaredOn !== undefined && target.node !== undefined && declaredOn !== target.node) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    reportDiagnostic(context.program, { code: "invalid-schema-name", target: context.decoratorTarget, format: { name, reason: "letters, digits and underscores, not starting with a digit" } });
    return;
  }
  context.program.stateMap(StateKeys.schemaName).set(target, name);
}

/** The explicit Pydantic class name of a model or enum (@schemaName). */
export function getSchemaName(program: Program, target: Model | Enum): string | undefined {
  return program.stateMap(StateKeys.schemaName).get(target) as string | undefined;
}

export function $defaultFactory(context: DecoratorContext, target: ModelProperty): void {
  if (!target.defaultValue) {
    reportDiagnostic(context.program, { code: "default-factory-without-default", target: context.decoratorTarget, format: { name: target.name } });
    return;
  }
  context.program.stateSet(StateKeys.defaultFactory).add(target);
}

export function isDefaultFactory(program: Program, target: ModelProperty): boolean {
  return program.stateSet(StateKeys.defaultFactory).has(target);
}
