/**
 * Pure resolution of clickable references in the intent cross-check advisory.
 * Separated from rendering so it can be unit-tested.
 *
 * The LLM prose is never parsed for structure — only two deterministic link
 * kinds are recognized:
 *   - a [N] citation → the EXACT grant at that 1-based position (unambiguous)
 *   - a known scope string/token → ALL grants with that scope (scope is not a
 *     unique key, so every match is returned — never a single silent guess)
 * Unrecognized text stays plain.
 */

export interface AdvisoryGrant {
  scope: string;
  intent: string | null;
  bounds: Record<string, string | number>;
}

export interface AdvisorySegment {
  /** The original text run — the plain text, or the matched [N]/scope token. */
  text: string;
  /** Display label: readable label for links, identical to `text` for plain runs. */
  label: string;
  /** null = plain text; otherwise the grant(s) this link opens. */
  matched: AdvisoryGrant[] | null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function resolveAdvisoryLinks(
  text: string,
  grants: AdvisoryGrant[],
  profileLabel: string,
): AdvisorySegment[] {
  if (grants.length === 0) return [{ text, label: text, matched: null }];

  // Collect unique linkable scope strings (full scope + each comma token).
  const scopeTexts: string[] = [];
  const seen = new Set<string>();
  for (const g of grants) {
    if (!g.scope || g.scope === 'all (unscoped)') continue;
    for (const c of [g.scope, ...g.scope.split(',').map(s => s.trim())]) {
      const key = c.toLowerCase();
      if (c && !seen.has(key)) { seen.add(key); scopeTexts.push(c); }
    }
  }
  scopeTexts.sort((a, b) => b.length - a.length); // longest first

  const matchScope = (t: string): AdvisoryGrant[] => {
    const low = t.toLowerCase();
    return grants.filter(g =>
      g.scope?.toLowerCase() === low ||
      g.scope?.split(',').map(s => s.trim().toLowerCase()).includes(low),
    );
  };

  const alternatives = ['\\[\\d+\\]', ...scopeTexts.map(escapeRegExp)];
  const pattern = new RegExp(`(${alternatives.join('|')})`, 'gi');

  return text.split(pattern).filter(part => part !== '').map((part): AdvisorySegment => {
    const idx = /^\[(\d+)\]$/.exec(part);
    if (idx) {
      const g = grants[Number(idx[1]) - 1];
      if (g) {
        // A bare "[4]" means nothing to the reader — show the grant's scope,
        // prefixed with the profile so it reads like the dashboard title.
        const scope = g.scope && g.scope !== 'all (unscoped)' ? g.scope : 'all recipients';
        const label = profileLabel ? `${profileLabel}: ${scope}` : scope;
        return { text: part, label, matched: [g] };
      }
    } else if (scopeTexts.some(s => s.toLowerCase() === part.toLowerCase())) {
      const m = matchScope(part);
      if (m.length > 0) return { text: part, label: part, matched: m };
    }
    return { text: part, label: part, matched: null };
  });
}
