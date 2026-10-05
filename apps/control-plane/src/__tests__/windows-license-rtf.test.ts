/**
 * The Windows installer's licence page (bundle/windows/wix/License.rtf) must be
 * the repository's LICENSE, word for word, plus the third-party note — never
 * WixUI's "Lorem ipsum" placeholder, never a stale copy.
 * Regenerate with: node bundle/windows/license-rtf.mjs
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLicenseRtf, THIRD_PARTY_NOTE } from '../../../../bundle/windows/license-rtf.mjs';

const root = join(__dirname, '../../../..');

describe('Windows installer licence page', () => {
  const license = readFileSync(join(root, 'LICENSE'), 'utf8');
  const rtf = readFileSync(join(root, 'bundle/windows/wix/License.rtf'), 'utf8');

  it('is generated from LICENSE (run node bundle/windows/license-rtf.mjs after changing LICENSE)', () => {
    expect(rtf).toBe(buildLicenseRtf(license));
  });

  it('names the copyright holder and carries the third-party note', () => {
    expect(license).toContain('Copyright (c) 2026 Andreas Schadauer');
    expect(rtf).toContain('Copyright (c) 2026 Andreas Schadauer');
    expect(rtf).toContain(THIRD_PARTY_NOTE);
    expect(rtf).not.toMatch(/lorem ipsum/i);
  });

  it('is wired into the installer UI', () => {
    const wxs = readFileSync(join(root, 'bundle/windows/wix/Product.wxs'), 'utf8');
    expect(wxs).toContain('<WixVariable Id="WixUILicenseRtf" Value="$(sys.SOURCEFILEDIR)License.rtf" />');
  });
});
