/**
 * Finds the `sv-*` elements the AI placed in its report HTML, in document
 * order — the raw material `verify-report.ts` resolves and checks. Reading
 * back exactly what `report-brief.ts` (R3) told the AI to write: the six
 * known kinds there, `REPORT_ELEMENTS`, plus anything else starting `sv-`
 * (an unknown element — the brief's contract names only six; a report that
 * invents a seventh gets "unverifiable", never silently rendered as content).
 *
 * Uses `htmlparser2` (already a `sanitize-html` dependency, pure JS) rather
 * than a regex over the HTML: an `sv-ticket` could legally appear inside an
 * attribute value elsewhere in the AI's free text, and real HTML can nest
 * angle brackets in ways a regex gets wrong — a parser is a second,
 * independent model of "what tag is this", not the same one twice.
 */
import { Parser } from 'htmlparser2';

export interface ParsedElement {
  /** Stable within one parse: `${kind}-${n}`, n = 0-based order of that kind. */
  id: string;
  /** The tag name, lowercased by the parser (HTML custom elements are
   *  case-insensitive but conventionally lowercase anyway). */
  kind: string;
  attrs: Record<string, string>;
}

export function parseElements(html: string): ParsedElement[] {
  const found: ParsedElement[] = [];
  const seenCount = new Map<string, number>();

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (!name.startsWith('sv-')) return;
        const n = seenCount.get(name) ?? 0;
        seenCount.set(name, n + 1);
        found.push({ id: `${name}-${n}`, kind: name, attrs: { ...attribs } });
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();

  return found;
}
