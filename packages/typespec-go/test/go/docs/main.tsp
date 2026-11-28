// Documentation is arbitrary text: every generated file stays gofmt-clean (go/doc/comment).
import "@typespec/http";
using Http;

/**
 * Has ``double backticks'' and `code`.
 *
 * Overview
 *
 * Indented block:
 *     let x = 1;
 *       nested
 * - item
 *   - indented item
 * 1. numbered
 *
 * [spec]: https://example.com/spec
 * See [spec] and https://example.com/a''b.
 */
@service
namespace Docs;

/**
 * A widget ``quoted''.
 *
 * Usage
 *
 *     curl https://example.com {
 *     }
 */
model Widget {
  /** The ``name''.
   *     indented field doc */
  name: string;

  /**
   * Kind.
   *
   * # Heading
   */
  kind: Kind;
}

/**
 * Kinds ``of'' widget.
 *
 *   - a
 *   - b
 */
enum Kind {
  /** First ``kind''. */
  A: "a",

  /**  Second.
   *      code */
  B: "b",
}

/** Shapes ``union''.
 *
 *     {
 */
union Shape { a: Widget, b: string }

/**
 * Reads ``widgets''.
 *
 * Title Case Heading
 *
 * After.
 */
@route("/widgets") op read(@query shape?: string): Widget;
