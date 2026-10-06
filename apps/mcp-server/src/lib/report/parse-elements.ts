/**
 * Finds the verifiable `sv-*` elements the AI placed in its report HTML, in
 * document order — the raw material `verify-report.ts` resolves and checks.
 * The six known kinds are `REPORT_ELEMENTS` (report-brief.ts); any other
 * `sv-*` element is returned too (a report that invents a seventh gets "not
 * verifiable", never silently rendered as content).
 *
 * The report FORMAT's structural tags (`sv-ai`, `sv-row`, `sv-glossary`,
 * `sv-term` — sanitize.ts#STRUCTURE_TAGS) are not elements and get no id;
 * nothing inside an `sv-ai` or `sv-glossary` is an element either. Callers
 * pass SANITIZED html (sanitize.ts), where both hold by construction — the
 * skipping here keeps the id scheme identical even on raw input.
 *
 * Uses `htmlparser2` (already a `sanitize-html` dependency, pure JS) rather
 * than a regex over the HTML.
 */
import { Parser } from 'htmlparser2';
import { STRUCTURE_TAGS } from './sanitize';

export interface ParsedElement {
  /** Stable within one parse: `${kind}-${n}`, n = 0-based order of that kind. */
  id: string;
  /** The tag name, lowercased by the parser. */
  kind: string;
  attrs: Record<string, string>;
}

export function parseElements(html: string): ParsedElement[] {
  const found: ParsedElement[] = [];
  const seenCount = new Map<string, number>();
  let opaqueDepth = 0; // inside sv-ai / sv-glossary

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === 'sv-ai' || name === 'sv-glossary') { opaqueDepth++; return; }
        if (opaqueDepth > 0) return;
        if (!name.startsWith('sv-') || STRUCTURE_TAGS.has(name)) return;
        const n = seenCount.get(name) ?? 0;
        seenCount.set(name, n + 1);
        found.push({ id: `${name}-${n}`, kind: name, attrs: { ...attribs } });
      },
      onclosetag(name) {
        if ((name === 'sv-ai' || name === 'sv-glossary') && opaqueDepth > 0) opaqueDepth--;
      },
    },
    { decodeEntities: true, recognizeSelfClosing: true },
  );
  parser.write(html);
  parser.end();

  return found;
}
