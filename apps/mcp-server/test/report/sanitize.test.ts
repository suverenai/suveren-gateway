/**
 * sanitize.ts — the two-tag rule (work-plan "regular reporting", decision 5,
 * RR6): only sv-ai blocks, verified elements, sv-row (verified elements only)
 * and one sv-glossary survive at top level; inside sv-ai the dangerous
 * constructs are stripped, styles are inline only, and no sv-* element lives.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeReportHtml, sanitizeReport } from '../../src/lib/report/sanitize';

/** Wraps content in one AI block — what the AI is told to do. */
const ai = (inner: string) => `<sv-ai>${inner}</sv-ai>`;

describe('sanitize — top-level structure (two-tag rule)', () => {
  it('REFUSAL: top-level content outside every block is dropped and counted', () => {
    const { html, notes } = sanitizeReport(
      '<h1>Loose title</h1><p>P.S. a great account</p>loose text<sv-ticket ref="t1"></sv-ticket>' +
      '<div><sv-ticket ref="t2"></sv-ticket></div>' + ai('<p>kept</p>'),
    );
    expect(html).not.toContain('Loose title');
    expect(html).not.toContain('great account');
    expect(html).not.toContain('loose text');
    expect(html).not.toContain('t2'); // an element wrapped in a plain div is not at top level
    expect(html).toContain('<sv-ticket ref="t1"></sv-ticket>');
    expect(html).toContain('<sv-ai><p>kept</p></sv-ai>');
    expect(notes.droppedBlocks).toBe(4);
  });

  it('keeps the six verified elements, re-serialized from their attributes only', () => {
    const out = sanitizeReportHtml('<sv-ticket ref="t1" variant="full">junk text</sv-ticket><sv-case start="email:m1" goal="ticket:t1" steps="t2 t3"></sv-case>');
    expect(out).toContain('<sv-ticket ref="t1" variant="full"></sv-ticket>');
    expect(out).toContain('<sv-case start="email:m1" goal="ticket:t1" steps="t2 t3"></sv-case>');
    expect(out).not.toContain('junk text');
  });

  it('an unclosed element does not swallow the next one', () => {
    const out = sanitizeReportHtml('<sv-ticket ref="a"><sv-ticket ref="b"></sv-ticket>');
    expect(out).toContain('<sv-ticket ref="a"></sv-ticket>');
    expect(out).toContain('<sv-ticket ref="b"></sv-ticket>');
  });

  it('sv-row keeps only verified elements', () => {
    const { html, notes } = sanitizeReport('<sv-row><sv-metric kind="completed" cases="all"></sv-metric><p>x</p><sv-ai>no</sv-ai></sv-row>');
    expect(html).toBe('<sv-row><sv-metric kind="completed" cases="all"></sv-metric></sv-row>');
    expect(notes.droppedBlocks).toBe(2);
  });

  it('unwraps <html>/<body>; drops <head> and its styles', () => {
    const { html, notes } = sanitizeReport('<!doctype html><html><head><style>*{color:red}</style><title>t</title></head><body>' + ai('<p>a</p>') + '</body></html>');
    expect(html).toBe('<sv-ai><p>a</p></sv-ai>');
    expect(notes.droppedStyles).toBe(1);
  });

  it('is idempotent', () => {
    const raw = ai('<h1 style="color:#123">T</h1><svg viewBox="0 0 2 2"><rect width="1" height="1"/></svg>') +
      '<sv-row><sv-ticket ref="t1"></sv-ticket></sv-row><sv-glossary lang="de"><sv-term key="action">Aktion</sv-term></sv-glossary>';
    const once = sanitizeReport(raw);
    const twice = sanitizeReport(once.html);
    expect(twice.html).toBe(once.html);
    expect(twice.notes.droppedBlocks).toBe(0);
  });
});

describe('sanitize — inside sv-ai', () => {
  it('REFUSAL: an sv-* element inside sv-ai is stripped (with its content) and counted', () => {
    const { html, notes } = sanitizeReport(ai('<p>before</p><sv-ticket ref="t1"></sv-ticket><div><sv-metric kind="completed">x</sv-metric></div><p>after</p>'));
    expect(html).not.toMatch(/<sv-ticket|<sv-metric/);
    expect(html).toContain('before');
    expect(html).toContain('after');
    expect(notes.droppedSvInsideAi).toBe(2);
  });

  it('REFUSAL: a nested sv-ai cannot open a second frame', () => {
    const out = sanitizeReportHtml(ai('<sv-ai>inner</sv-ai>outer'));
    expect(out.match(/<sv-ai>/g)).toHaveLength(1);
  });

  it('REFUSAL: <style> blocks are removed (inline style attributes only) and counted', () => {
    const { html, notes } = sanitizeReport(ai('<style>.sv-el{display:none} *{color:red}</style><div style="color:blue">hi</div>'));
    expect(html).not.toContain('<style');
    expect(html).not.toContain('display:none');
    expect(html).toContain('style="color:blue"');
    expect(notes.droppedStyles).toBe(1);
  });

  it('removes inline declarations that load a URL, keeps data:image ones', () => {
    const out = sanitizeReportHtml(ai('<div style="color:red;background:url(https://evil.example/x.png)">a</div><div style="background:url(data:image/png;base64,AA)">b</div>'));
    expect(out).not.toContain('evil.example');
    expect(out).toContain('color:red');
    expect(out).toContain('data:image/png;base64,AA');
  });

  it('removes <script> tags AND their content', () => {
    const out = sanitizeReportHtml(ai('<div>safe</div><script>alert(1)</script>'));
    expect(out).not.toMatch(/script/i);
    expect(out).not.toMatch(/alert/);
    expect(out).toContain('safe');
  });

  it('removes <iframe>, <object>, <embed>, <link>, <base>, <meta>', () => {
    const out = sanitizeReportHtml(ai(
      '<iframe src="https://x"></iframe><object data="x"></object><embed src="x"><link rel="stylesheet" href="https://x/a.css">' +
      '<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://x"><p>ok</p>',
    ));
    expect(out).not.toMatch(/iframe|object|embed|link|<base|<meta|http-equiv/i);
    expect(out).toContain('<p>ok</p>');
  });

  it('REFUSAL: raw-text and top-layer elements are removed; popover attributes stripped', () => {
    const out = sanitizeReportHtml(ai('<plaintext>x</plaintext><xmp>y</xmp><dialog open>d</dialog><select><option>o</option></select><div popover id="p">p</div><button popovertarget="p">b</button>'));
    expect(out).not.toMatch(/plaintext|xmp|dialog|select|popover/i);
  });

  it('REFUSAL: html/head/body inside sv-ai become plain divs (no attribute merge onto the real body)', () => {
    const out = sanitizeReportHtml(ai('<body style="background:red" class="x"><p>a</p></body>'));
    expect(out).not.toMatch(/<body/i);
    expect(out).not.toContain('background:red');
    expect(out).toContain('<div><p>a</p></div>');
  });

  it('removes every on* handler attribute, on every tag', () => {
    const out = sanitizeReportHtml(ai('<div onclick="x()" onmouseover="y()" data-ok="1">hi</div>'));
    expect(out).not.toMatch(/on(click|mouseover)/i);
    expect(out).toContain('data-ok="1"');
  });

  it('strips javascript:, vbscript:, external URLs and form actions; keeps fragment links', () => {
    const out = sanitizeReportHtml(ai(
      '<a href="javascript:alert(1)">x</a><a href="vbscript:msgbox(1)">y</a><a href="https://evil.example/">ext</a>' +
      '<a href="#section-2">frag</a><form action="https://evil.example/f"><button formaction="https://evil.example/g">go</button></form>',
    ));
    expect(out).not.toMatch(/javascript:|vbscript:|evil\.example/i);
    expect(out).toContain('href="#section-2"');
  });

  it('keeps a data:image/* src but strips an external image src', () => {
    const out = sanitizeReportHtml(ai('<img src="data:image/png;base64,AAAA"><img src="https://evil.example/x.png">'));
    expect(out).toContain('data:image/png;base64,AAAA');
    expect(out).not.toMatch(/evil\.example/);
  });

  it('keeps inline SVG, including camelCase attributes; strips an external xlink:href', () => {
    const out = sanitizeReportHtml(ai('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"></circle><use xlink:href="https://evil.example/s.svg#i"></use></svg>'));
    expect(out).toContain('viewBox="0 0 10 10"');
    expect(out).toContain('<circle');
    expect(out).not.toMatch(/evil\.example/);
  });

  it('keeps ordinary structural HTML (tables, headings, divs)', () => {
    const out = sanitizeReportHtml(ai('<h1>Report</h1><table><tr><td>1</td></tr></table>'));
    expect(out).toContain('<h1>Report</h1>');
    expect(out).toContain('<table>');
  });

  it('REFUSAL: the AI cannot carry the gateway\'s own sv-* classes, ids or data-sv-* markers (review SR5)', () => {
    const fake =
      '<div class="sv-el sv-el-verified card" id="sv-gloss-toggle" data-sv-id="sv-ticket-0" data-sv-source="signed">' +
      '<span class="SV-BADGE sv-badge-ok">✓ verified · signed</span></div>' +
      '<svg class="sv-ai-legend chart"><rect class="sv-step" width="1" height="1"/></svg>';
    const out = sanitizeReportHtml(ai(fake));
    expect(out).not.toMatch(/class="[^"]*\bsv-/i);
    expect(out).not.toMatch(/data-sv/i);
    expect(out).not.toMatch(/id="sv-/i);
    expect(out).toContain('class="card"');
    expect(out).toContain('class="chart"');
    expect(out).toContain('<rect width="1" height="1"');
    expect(out).toContain('✓ verified · signed'); // the text stays — it sits in the grey frame
  });
});

describe('sanitize — glossary', () => {
  it('keeps one glossary of plain-text terms; extra glossaries are ignored and counted', () => {
    const { html, notes } = sanitizeReport(
      '<sv-glossary lang="de"><sv-term key="action"><b>Aktion</b></sv-term></sv-glossary><sv-glossary><sv-term key="x">y</sv-term></sv-glossary>',
    );
    expect(html).toBe('<sv-glossary lang="de"><sv-term key="action">Aktion</sv-term></sv-glossary>');
    expect(notes.extraGlossaries).toBe(1);
  });

  it('REFUSAL: terms over 60 characters, with check marks, empty or duplicated are rejected', () => {
    const { html, notes } = sanitizeReport(
      '<sv-glossary lang="de">' +
      `<sv-term key="a">${'x'.repeat(61)}</sv-term>` +
      '<sv-term key="b">✓ geprüft</sv-term><sv-term key="c">✔</sv-term><sv-term key="d"> </sv-term>' +
      '<sv-term key="e">gut</sv-term><sv-term key="e">doppelt</sv-term>' +
      '</sv-glossary>',
    );
    expect(html).toBe('<sv-glossary lang="de"><sv-term key="e">gut</sv-term></sv-glossary>');
    expect(notes.rejectedTerms.map(r => r.key).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
