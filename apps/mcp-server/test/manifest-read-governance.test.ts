/**
 * F9 conformance lint — every `category:"read"` tool in every shipped manifest
 * MUST declare read governance: a static gate (`boundField`), a read adapter
 * (`read`), or an explicit exemption (`readGovernance:"none"` + a reason).
 *
 * This is the enforcement point for the §3.0 genericity contract: the engine is
 * generic, but a connector could silently bypass the read model by declaring a
 * read tool with no governance — the gateway would proxy it verbatim. This test
 * fails the build the moment that happens, so a FUTURE connector cannot
 * regress the model by omission. Uses the SAME `readToolIsGoverned` predicate
 * the runtime read path uses, so lint and runtime can never disagree.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readToolIsGoverned } from '../src/lib/read-gate';

const MANIFESTS_DIR = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');

/**
 * Explicitly-tracked ungoverned read tools. These DENY at runtime today (F9
 * fail-closed) and are pending real governance. The list is a debt ledger, not a
 * waiver: it must only SHRINK. A read tool that is neither governed nor on this
 * list fails the build (regression guard), and a listed tool that becomes
 * governed is flagged so it gets removed here.
 *
 * Cleared:
 *   • crm.*      2026-07-22 — customers@0.5 `read_access` gate.
 *   • calendar.* 2026-07-23 — F7 resource filter (allowed_calendars) on reads.
 */
const KNOWN_UNGOVERNED: Record<string, Set<string>> = {};

interface ReadEntry {
  category?: string;
  boundField?: string;
  read?: unknown;
  readGovernance?: string;
  readGovernanceReason?: string;
}

/** A manifest override is a read entry if category==="read" or it is null (= read). */
function isReadEntry(entry: unknown): entry is ReadEntry | null {
  return entry === null || (typeof entry === 'object' && (entry as ReadEntry).category === 'read');
}

const manifestFiles = readdirSync(MANIFESTS_DIR)
  .filter(f => f.endsWith('.json') && f !== 'index.json');

describe('F9 — manifest read-governance lint', () => {
  it('finds manifests to lint (guards against a broken path)', () => {
    expect(manifestFiles.length).toBeGreaterThan(0);
  });

  for (const file of manifestFiles) {
    const manifest = JSON.parse(readFileSync(join(MANIFESTS_DIR, file), 'utf8'));
    const overrides: Record<string, unknown> = manifest?.toolGating?.overrides ?? {};

    const readTools = Object.entries(overrides).filter(([, v]) => isReadEntry(v));
    if (readTools.length === 0) continue; // e.g. mollie — no read tools to lint

    const pending = KNOWN_UNGOVERNED[file] ?? new Set<string>();

    describe(file, () => {
      for (const [toolName, entry] of readTools) {
        const e = (entry ?? {}) as ReadEntry;
        const isPending = pending.has(toolName);

        if (!isPending) {
          // Regression guard: unlisted read tools MUST be governed.
          it(`${toolName}: declares read governance`, () => {
            expect(
              readToolIsGoverned(e),
              `${file} → ${toolName} is category:"read" but declares no governance ` +
              `(no boundField, no read adapter, no readGovernance:"none"). Add a gate/adapter, ` +
              `an explicit exemption with a reason, or (only if genuinely pending) list it in ` +
              `KNOWN_UNGOVERNED with a tracking note.`,
            ).toBe(true);
          });
        } else {
          // Ledger hygiene: a pending tool that got governed must leave the list.
          it(`${toolName}: still pending (remove from KNOWN_UNGOVERNED once governed)`, () => {
            expect(
              readToolIsGoverned(e),
              `${file} → ${toolName} is now governed — delete it from KNOWN_UNGOVERNED.`,
            ).toBe(false);
          });
        }

        it(`${toolName}: any exemption carries a written reason`, () => {
          if (e.readGovernance === 'none') {
            expect(
              typeof e.readGovernanceReason === 'string' && e.readGovernanceReason.trim().length > 0,
              `${file} → ${toolName} declares readGovernance:"none" without a readGovernanceReason. ` +
              `An exemption must state why the read carries no per-item limit.`,
            ).toBe(true);
          }
        });
      }
    });
  }
});
