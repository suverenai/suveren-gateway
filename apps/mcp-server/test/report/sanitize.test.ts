/**
 * sanitizeReportHtml — strips the dangerous constructs the report brief
 * forbids, keeps everything else (free HTML/CSS/inline SVG + the sv-*
 * elements) per work-plan "evidence-backed reports" R5 security section.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeReportHtml } from '../../src/lib/report/sanitize';

describe('sanitizeReportHtml', () => {
  it('removes <script> tags AND their content', () => {
    const out = sanitizeReportHtml('<div>safe</div><script>alert(1)</script>');
    expect(out).not.toMatch(/script/i);
    expect(out).not.toMatch(/alert/);
    expect(out).toContain('safe');
  });

  it('removes <iframe>, <object>, <embed>, <link>', () => {
    const out = sanitizeReportHtml(
      '<iframe src="https://x"></iframe><object data="x"></object><embed src="x"><link rel="stylesheet" href="https://x/a.css">',
    );
    expect(out).not.toMatch(/iframe|object|embed|link/i);
  });

  it('removes <meta http-equiv> (e.g. a meta-refresh redirect) but keeps other meta', () => {
    const out = sanitizeReportHtml('<meta http-equiv="refresh" content="0;url=https://x"><meta charset="utf-8">');
    expect(out).not.toMatch(/http-equiv/i);
    expect(out).toContain('charset');
  });

  it('removes every on* handler attribute, on every tag', () => {
    const out = sanitizeReportHtml('<div onclick="x()" onmouseover="y()" data-ok="1">hi</div>');
    expect(out).not.toMatch(/on(click|mouseover)/i);
    expect(out).toContain('data-ok="1"');
  });

  it('strips javascript: and vbscript: URLs', () => {
    const out = sanitizeReportHtml('<a href="javascript:alert(1)">x</a><a href="vbscript:msgbox(1)">y</a>');
    expect(out).not.toMatch(/javascript:|vbscript:/i);
  });

  it('strips external http(s) src/href but keeps fragment links', () => {
    const out = sanitizeReportHtml('<a href="https://evil.example/">ext</a><a href="#section-2">frag</a>');
    expect(out).not.toMatch(/evil\.example/);
    expect(out).toContain('href="#section-2"');
  });

  it('keeps a data:image/* src (an inline chart image) but strips an external image src', () => {
    const out = sanitizeReportHtml('<img src="data:image/png;base64,AAAA"><img src="https://evil.example/x.png">');
    expect(out).toContain('data:image/png;base64,AAAA');
    expect(out).not.toMatch(/evil\.example/);
  });

  it('keeps <style> blocks and inline style attributes', () => {
    const out = sanitizeReportHtml('<style>.x{color:red}</style><div style="color:blue">hi</div>');
    expect(out).toContain('.x{color:red}');
    expect(out).toContain('style="color:blue"');
  });

  it('keeps inline SVG, including camelCase attributes', () => {
    const out = sanitizeReportHtml('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"></circle></svg>');
    expect(out).toContain('viewBox="0 0 10 10"');
    expect(out).toContain('<circle');
  });

  it('strips an external xlink:href on an SVG <use> (no scheme/attribute-name blocklist to drift)', () => {
    const out = sanitizeReportHtml('<svg><use xlink:href="https://evil.example/sprite.svg#icon"></use></svg>');
    expect(out).not.toMatch(/evil\.example/);
  });

  it('keeps sv-* elements and their attributes untouched', () => {
    const out = sanitizeReportHtml('<sv-ticket ref="t1"></sv-ticket><sv-case start="email:m1" goal="ticket:t1" steps="t2 t3"></sv-case>');
    expect(out).toContain('<sv-ticket ref="t1">');
    expect(out).toContain('<sv-case start="email:m1" goal="ticket:t1" steps="t2 t3">');
  });

  it('keeps ordinary structural HTML (tables, headings, divs)', () => {
    const out = sanitizeReportHtml('<h1>Report</h1><table><tr><td>1</td></tr></table>');
    expect(out).toContain('<h1>Report</h1>');
    expect(out).toContain('<table>');
  });
});
