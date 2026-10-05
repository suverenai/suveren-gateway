/**
 * Sanitize the AI's report HTML before it is ever rendered — work-plan
 * "evidence-backed reports", step R5, security section: "no JavaScript (HTML +
 * CSS + inline SVG only) so nothing can alter verified elements after
 * rendering".
 *
 * Uses `sanitize-html` (pure JS, no native deps, ~40M weekly downloads,
 * actively maintained) rather than a hand-rolled parser — written once by one
 * author, an HTML/SVG-aware escaping bug is exactly the kind of mistake a
 * second independent implementation (a vetted library with its own test
 * suite) catches that a first implementation's own tests cannot.
 *
 * Deliberately NOT allowlist-based (`allowedTags`): the AI writes free HTML
 * structure (its own headings, tables, divs, inline SVG charts) plus the six
 * `sv-*` elements from report-brief.ts, and an allowlist would need to name
 * every one of those up front and would silently strip anything unlisted
 * (reports would degrade) rather than fail loudly. Instead this denies by
 * name exactly what the brief forbids: <script>/<iframe>/<object>/<embed>/
 * <link>/<meta http-equiv>, every `on*` handler attribute, and any
 * href/src/xlink:href that isn't a same-document fragment (`#...`) or a
 * `data:image/...` URI (javascript:/vbscript: and every external URL fall
 * out of that same check — there is no separate scheme blocklist to keep in
 * sync).
 *
 * Known limitation, accepted: a `style="background:url(javascript:...)"` or
 * a CSS `@import` is NOT parsed and stripped here — sanitizing arbitrary CSS
 * content is a much larger problem than this report needs to solve today.
 * The report is rendered in a script-free, no-network sandbox (R5's other
 * security requirement), which is what actually neutralizes that class of
 * attack; this function's job is scripts and off-document resource loads.
 */
import sanitizeHtmlLib from 'sanitize-html';

const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'link']);

/** Attribute names (case-insensitive) that may carry a URL and so are
 *  subject to the fragment/data-image-only rule. Covers plain HTML (href,
 *  src) and inline SVG's namespaced `xlink:href` / `href`. */
function isUrlAttribute(name: string): boolean {
  const n = name.toLowerCase();
  return n === 'href' || n === 'src' || n === 'xlink:href' || n.endsWith(':href');
}

function isAllowedUrl(value: string): boolean {
  const v = value.trim();
  if (v.startsWith('#')) return true; // same-document fragment link
  if (/^data:image\//i.test(v)) return true; // inline image
  return false;
}

export function sanitizeReportHtml(html: string): string {
  return sanitizeHtmlLib(html, {
    // Allow every tag/attribute by default — see module doc comment for why
    // this is deny-by-name rather than allow-by-name. `transformTags['*']`
    // below is then the ONLY attribute filter (allowedAttributes: false
    // skips sanitize-html's own, so there is exactly one place attributes
    // are decided, not two that could disagree). Logs a harmless warning for
    // "script"/"style" on every call (sanitize-html's own vulnerable-tag
    // notice, fired from its internal tag list even though we pass `false`,
    // not an array containing them) — `allowVulnerableTags` is the
    // documented way to accept that, and <script> is still removed, by
    // `exclusiveFilter` below, regardless of this flag.
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    // sanitize-html's OWN scheme check (independent of transformTags, and
    // applied to it/src/cite only — NOT xlink:href, which is why the
    // transformTags filter above is the one actually relied on for SVG) uses
    // this list; it has no "data" scheme by default, which would undo our
    // own decision to keep `data:image/*` sources. Nothing wider is opened:
    // transformTags has already removed every href/src that isn't a
    // fragment link or a data:image/* URI by the time this check runs.
    allowedSchemes: [...sanitizeHtmlLib.defaults.allowedSchemes, 'data'],
    // Preserve attribute name casing — inline SVG uses camelCase attributes
    // (viewBox, preserveAspectRatio, …) that lowercasing would silently
    // break. Safe for the `on*`/url checks below: both compare case-folded.
    parser: { lowerCaseAttributeNames: false },
    // Removes the named tag AND all of its children/text — the only correct
    // behaviour for <script>: dropping just the tag would leave its JS as
    // visible text, but the content must not survive either.
    exclusiveFilter: (frame) => {
      const tag = frame.tag.toLowerCase();
      if (FORBIDDEN_TAGS.has(tag)) return true;
      if (tag === 'meta' && Object.keys(frame.attribs).some(a => a.toLowerCase() === 'http-equiv')) {
        return true;
      }
      return false;
    },
    transformTags: {
      '*': (tagName, attribs) => {
        const kept: Record<string, string> = {};
        for (const [name, value] of Object.entries(attribs)) {
          if (name.toLowerCase().startsWith('on')) continue; // onclick, onerror, onload, ...
          if (isUrlAttribute(name) && !isAllowedUrl(value)) continue; // javascript:, http(s)://, ...
          kept[name] = value;
        }
        return { tagName, attribs: kept };
      },
    },
  });
}
