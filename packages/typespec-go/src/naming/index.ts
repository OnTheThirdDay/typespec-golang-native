import { ensureNameCase, getEscapedReservedName } from "./naming.js";

/**
 * Exported Go identifier for a TypeSpec name, using the Azure Go emitter's word splitting and
 * acronym rules (`widget_id` → `WidgetID`, `url` → `URL`). Characters that cannot appear in Go
 * identifiers are dropped; a leading digit gets an `X` prefix.
 */
export function exportedName(name: string): string {
  let n = ensureNameCase(name).replace(/[^\p{L}\p{Nd}_]/gu, "");
  if (n === "" || /^\p{Nd}/u.test(n)) n = "X" + n;
  if (!/^\p{Lu}/u.test(n)) n = n.charAt(0).toUpperCase() + n.slice(1);
  if (!/^\p{Lu}/u.test(n)) n = "X" + n; // first letter without an upper-case form
  return n;
}

/** Unexported Go identifier (local variables, receivers), escaped if reserved. */
export function localName(name: string): string {
  let n = ensureNameCase(name, true).replace(/[^\p{L}\p{Nd}_]/gu, "");
  if (n === "" || /^\p{Nd}/u.test(n)) n = "v" + n;
  return getEscapedReservedName(n, "_");
}
