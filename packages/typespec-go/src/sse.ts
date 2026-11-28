/**
 * Server-sent events: responses of type `SSEStream<Events>` (@typespec/sse) become
 * `iter.Seq[tsgo.SSE[E]]` bodies, where E is the Go type of the @events union. Each union
 * variant is one event kind: a named variant sets the SSE `event:` field, an unnamed one uses the
 * default `message` event; the payload uses the variant's @Events.contentType (JSON by default,
 * text/plain for strings) or, with an `@data` property, only that property's value.
 */
import { navigateType, type ModelProperty, type Program, type Type, type Union, type UnionVariant } from "@typespec/compiler";
import { Code, docComment, goString } from "./gowriter.js";
import { createDiagnostic } from "./lib.js";
import type { Field, GoModelGenerator, GoType } from "./model.js";
import { exportedName } from "./naming/index.js";

export interface EventLibs {
  streams?: typeof import("@typespec/streams");
  events?: typeof import("@typespec/events");
  sse?: typeof import("@typespec/sse");
}

interface EventKind {
  name: string; // "" = unnamed (default "message")
  contentType: string;
  terminal: boolean;
  /** Go union variant accessor/constructor suffix, or undefined when the stream has a single type. */
  variant?: string;
  type: GoType;
  /** @data envelope property. */
  data?: Field[];
}

export interface SseStream {
  id: number;
  /** Exported-name stem (the @events union name). */
  stem: string;
  elem: GoType;
  kinds: EventKind[];
}

class Fail extends Error {}

export class SseSupport {
  readonly streams: SseStream[] = [];
  private readonly byUnion = new Map<Type, SseStream>();

  constructor(
    private readonly program: Program,
    private readonly g: GoModelGenerator,
    private readonly libs: EventLibs,
  ) {}

  private fail(target: Type, reason: string): never {
    this.g.diagnostics.push(createDiagnostic({ code: "unsupported-http", target, format: { reason: `SSE: ${reason}` } }));
    throw new Fail();
  }

  isEvents(type: Union): boolean {
    return this.libs.events?.isEvents(this.program, type) ?? false;
  }

  /** The events type of a stream response model, if the response is a stream. */
  streamOf(responseType: Type): Type | undefined {
    if (responseType.kind !== "Model" || !this.libs.streams) return undefined;
    return this.libs.streams.getStreamOf(this.program, responseType) ?? undefined;
  }

  /** Builds (once per events union) the event model; undefined after a diagnostic. */
  stream(events: Type, site: Type, vis: number): SseStream | undefined {
    const found = this.byUnion.get(events);
    if (found) return found;
    try {
      if (!this.libs.events || !this.libs.sse) this.fail(site, "the @typespec/events and @typespec/sse libraries are required");
      if (events.kind !== "Union") this.fail(events, "the stream type must be an @events union");
      const elem = this.g.typeRef(events, { vis, hint: (events as Union).name ?? "Events", site });
      const variants = [...(events as Union).variants.values()];
      const decl = elem.decl?.kind === "union" ? elem.decl : undefined;
      if (!decl && variants.length !== 1) this.fail(events, "events unions with several variants must map to a Go union (no literal-only or nullable event unions)");
      if (decl && decl.variants!.length !== variants.length) this.fail(events, "nested unions or null variants in an @events union are not supported");
      const kinds = variants.map((v, i) => this.kind(v, decl ? decl.variants![i].type : elem, decl?.variants![i].name));
      const un = (events as Union).name;
      const stem = un && !this.streams.some((x) => x.stem === exportedName(un)) ? exportedName(un) : `Events${this.streams.length}`;
      const s: SseStream = { id: this.streams.length, stem, elem, kinds };
      this.streams.push(s);
      this.byUnion.set(events, s);
      return s;
    } catch (e) {
      if (e instanceof Fail) return undefined;
      throw e;
    }
  }

  private kind(v: UnionVariant, type: GoType, variant?: string): EventKind {
    const name = typeof v.name === "string" ? v.name : "";
    const terminal = this.libs.sse!.isTerminalEvent(this.program, v);
    let contentType = this.libs.events!.getContentType(this.program, v) ?? "application/json";
    let data: EventKind["data"];
    let dataProp: ModelProperty | undefined;
    navigateType(v.type, { modelProperty: p => {
      if (this.libs.events!.isEventData(this.program, p)) dataProp = p;
    } }, {});
    if (dataProp) {
      const findPath = (t: GoType, seen: Set<GoType["decl"]>): Field[] | undefined => {
        const d = t.decl;
        if (!d?.fields || seen.has(d)) return undefined;
        seen.add(d);
        for (const f of d.fields) {
          if (f.prop === dataProp || (f.prop.node && f.prop.node === dataProp!.node)) return [f];
          const child = findPath(f.type, seen);
          if (child) return [f, ...child];
        }
        return undefined;
      };
      data = findPath(type, new Set());
      if (!data) this.fail(dataProp, "the @data path must be visible and traverse object properties");
      let parent = type;
      for (const field of data) {
        if (parent.decl!.fields!.some(f => f !== field && !f.optional && !f.literal)) this.fail(v, "an event with @data cannot have other required properties (they are not transmitted)");
        parent = field.type;
      }
      contentType = this.libs.events!.getContentType(this.program, dataProp) ?? contentType;
    }
    const payload = data?.at(-1)?.type ?? type;
    if (!/^(?:application\/json|[\w.+-]+\/[\w.+-]+\+json)(?:\s*;|$)/i.test(contentType) && !/^text\//i.test(contentType)) this.fail(v, `event content type ${contentType} is not supported`);
    if (/^text\//i.test(contentType) && !payload.text) this.fail(v, "text events require a declared text codec");
    return { name, contentType, terminal, variant, type, data };
  }

  marshalName(s: SseStream): string {
    return `marshal${s.stem}SSE`;
  }

  unmarshalName(s: SseStream): string {
    return `Unmarshal${s.stem}SSE`;
  }

  emit(out: Code): void {
    for (const s of this.streams) {
      const E = s.elem.expr;
      const encodePayload = (k: EventKind, val: string, o: Code) => {
        let t = k.type;
        let value = val;
        for (const f of k.data ?? []) {
          for (const sibling of t.decl!.fields!) {
            if (sibling !== f && sibling.optional && !sibling.never) {
              o.open(`if ${value}.${sibling.goName} != nil {`).line(`return "", nil, errors.New(${goString("SSE cannot transmit envelope field " + sibling.json)})`).close();
            }
          }
          if (t.decl!.additional) o.open(this.g.orderedRecords ? `if ${value}.AdditionalProperties.Len() != 0 {` : `if len(${value}.AdditionalProperties) != 0 {`).line('return "", nil, errors.New("SSE cannot transmit additional envelope fields")').close();
          t = f.type;
          if (f.literal) {
            o.line(`_ = ${value}`);
            value = `${t.expr}(${f.literal.value})`;
          } else {
            value += "." + f.goName;
            if (f.optional) {
              o.open(`if ${value} == nil {`).line('return "", nil, errors.New("SSE event data is absent")').close();
              value = "(*" + value + ")";
            }
          }
        }
        if (/^text\//i.test(k.contentType)) {
          o.line(`s, err := ${t.text}.Format(${value})`);
          o.line(`return ${goString(k.name)}, []byte(s), err`);
        } else {
          o.line(`b, err := ${this.g.responseCodec(t)}.Encode(${value})`);
          o.line(`return ${goString(k.name)}, b, err`);
        }
      };
      out.raw(docComment(`${this.marshalName(s)} encodes one ${E} event (event name and data payload).`));
      out.open(`func ${this.marshalName(s)}(e ${E}) (string, []byte, error) {`);
      if (s.kinds.length === 1 && !s.kinds[0].variant) {
        encodePayload(s.kinds[0], "e", out);
      } else {
        out.open("switch e.Kind() {");
        for (const k of s.kinds) {
          out.line(`case ${E}Kind${k.variant}:`);
          out.line(`\tv, _ := e.As${k.variant}()`);
          const b = new Code();
          encodePayload(k, "v", b);
          for (const l of b.toString().replace(/\n$/, "").split("\n")) out.line("\t" + l);
        }
        out.close();
        out.line(`return "", nil, tsgo.ErrUnsetUnion`);
      }
      out.close();
      out.line();

      out.raw(docComment(`${this.unmarshalName(s)} decodes one ${E} event from its SSE event name and data (for clients and tests).\nUnnamed events are tried in declaration order.`));
      out.open(`func ${this.unmarshalName(s)}(event string, data []byte) (${E}, error) {`);
      out.line(`var zero ${E}`);
      const decodeKind = (k: EventKind, o: Code, failOnError: boolean) => {
        const t = k.data?.at(-1)?.type ?? k.type;
        const decode = !/^text\//i.test(k.contentType) ? `${t.codec}.Decode(data)` : `${t.text ?? "tsgo.StringText"}.Parse(string(data))`;
        o.open("{");
        o.line(`x, err := ${decode}`);
        o.open("if err == nil {");
        let v = "x";
        if (k.data) {
          o.line(`var env ${k.type.expr}`);
          let target = "env";
          for (const f of k.data.slice(0, -1)) {
            target += "." + f.goName;
            if (f.optional) o.line(`${target} = new(${f.type.expr})`);
          }
          const leaf = k.data.at(-1)!;
          if (leaf.literal) o.line("_ = x");
          else o.line(`${target}.${leaf.goName} = ${leaf.optional ? "&x" : "x"}`);
          v = "env";
        }
        o.line(`return ${k.variant ? `New${E}${k.variant}(${v})` : v}, nil`);
        o.close();
        if (failOnError) o.line("return zero, err");
        o.close();
      };
      for (const k of s.kinds.filter((x) => x.name)) {
        out.open(`if event == ${goString(k.name)} {`);
        decodeKind(k, out, true);
        out.close();
      }
      const unnamed = s.kinds.filter((x) => !x.name);
      if (unnamed.length) {
        out.open(`if event == "" || event == "message" {`);
        for (const k of unnamed) decodeKind(k, out, false);
        out.close();
      }
      out.line(`return zero, fmt.Errorf("SSE event %q with data %q matches no ${E} event", event, data)`);
      out.close();
      out.line();
    }
  }
}
