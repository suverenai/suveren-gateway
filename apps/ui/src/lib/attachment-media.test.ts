import { describe, it, expect } from 'vitest';
import { blobType, cleanDisplayText, decideShown, decodeText, previewKind, sha256Hex, signatureMatches, TEXT_PREVIEW_LIMIT } from './attachment-media';

const bytes = (...n: number[]) => new Uint8Array(new ArrayBuffer(n.length)).map((_, i) => n[i]);
const ascii = (s: string) => { const u = new TextEncoder().encode(s); const out = new Uint8Array(new ArrayBuffer(u.length)); out.set(u); return out; };
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const MP4 = bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d);

describe('which types are shown inline', () => {
  it('shows images, video, pdf, markdown and text', () => {
    expect(previewKind('image/png')).toBe('image');
    expect(previewKind('IMAGE/JPEG; charset=x')).toBe('image');
    expect(previewKind('video/mp4')).toBe('video');
    expect(previewKind('video/webm')).toBe('video');
    expect(previewKind('application/pdf')).toBe('pdf');
    expect(previewKind('text/markdown')).toBe('text');
    expect(previewKind('text/plain')).toBe('text');
  });
  it('never shows SVG, HTML, scripts, Office or archives', () => {
    for (const t of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/javascript', 'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream', '']) {
      expect(previewKind(t)).toBeNull();
      expect(blobType(t)).toBeNull();
    }
  });
  it('text always gets a plain-text blob type', () => {
    expect(blobType('text/markdown')).toBe('text/plain');
    expect(blobType('Image/PNG')).toBe('image/png');
  });
});

describe('signatures', () => {
  it('checks the first bytes against the claimed type', () => {
    expect(signatureMatches('image/png', PNG)).toBe(true);
    expect(signatureMatches('image/jpeg', PNG)).toBe(false);
    expect(signatureMatches('video/mp4', MP4)).toBe(true);
    expect(signatureMatches('video/webm', MP4)).toBe(false);
    expect(signatureMatches('application/pdf', ascii('%PDF-1.7'))).toBe(true);
    expect(signatureMatches('application/pdf', ascii('<svg'))).toBe(false);
  });
});

describe('text', () => {
  it('decodes valid UTF-8, refuses NUL and invalid bytes', () => {
    expect(decodeText(ascii('# Hello\nä'))).toEqual({ text: '# Hello\nä', truncated: false });
    expect(decodeText(bytes(0x61, 0x00, 0x62))).toBeNull();
    expect(decodeText(bytes(0xff, 0xfe, 0xfd))).toBeNull();
  });
  it('cuts long text and says so', () => {
    const r = decodeText(ascii('a'.repeat(TEXT_PREVIEW_LIMIT + 5)))!;
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(TEXT_PREVIEW_LIMIT);
  });
});

describe('decideShown: what is displayed is what was sealed', () => {
  it('shows a file whose bytes match the sealed fingerprint', async () => {
    const sha = await sha256Hex(PNG);
    expect(await decideShown('image/png', PNG, sha)).toEqual({ status: 'ok', kind: 'image' });
  });
  it('refuses when a single byte differs from the sealed fingerprint', async () => {
    const sha = await sha256Hex(PNG);
    const other = PNG.slice(); other[11] = 1;
    expect(await decideShown('image/png', other, sha)).toEqual({ status: 'mismatch' });
  });
  it('refuses an SVG even when the fingerprint matches', async () => {
    const svg = ascii('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    const r = await decideShown('image/svg+xml', svg, await sha256Hex(svg));
    expect(r.status).toBe('not_shown');
  });
  it('refuses HTML claimed as text/html, and HTML bytes claimed as a PNG', async () => {
    const html = ascii('<script>alert(1)</script>');
    expect((await decideShown('text/html', html)).status).toBe('not_shown');
    expect((await decideShown('image/png', html)).status).toBe('not_shown');
  });
  it('shows markdown as text (the markup stays literal text)', async () => {
    const md = ascii('# Title\n<script>alert(1)</script>');
    const r = await decideShown('text/markdown', md, await sha256Hex(md));
    expect(r).toMatchObject({ status: 'ok', kind: 'text', text: { text: '# Title\n<script>alert(1)</script>' } });
  });
  it('compares the fingerprint case-insensitively', async () => {
    expect((await decideShown('image/png', PNG, (await sha256Hex(PNG)).toUpperCase())).status).toBe('ok');
  });
});

describe('cleanDisplayText', () => {
  it('removes control characters and bidi marks, and caps the length', () => {
    expect(cleanDisplayText('a‮b\u0000c\nd‏e')).toBe('abcde');
    expect(cleanDisplayText('x'.repeat(300)).length).toBe(200);
  });
});
