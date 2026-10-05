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
  // Line endings normalised: git checks text files out with CRLF on Windows runners.
  const license = readFileSync(join(root, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n');
  const rtf = readFileSync(join(root, 'bundle/windows/wix/License.rtf'), 'utf8').replace(/\r\n/g, '\n');

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

  it('uses the Suveren images and icon, not the toolkit defaults', () => {
    const wxs = readFileSync(join(root, 'bundle/windows/wix/Product.wxs'), 'utf8');
    expect(wxs).toContain('<WixVariable Id="WixUIDialogBmp" Value="$(sys.SOURCEFILEDIR)dialog.bmp" />');
    expect(wxs).toContain('<WixVariable Id="WixUIBannerBmp" Value="$(sys.SOURCEFILEDIR)banner.bmp" />');
    expect(wxs).toContain('Icon="SuverenIcon"');
    const size = (f: string) => {
      const b = readFileSync(join(root, 'bundle/windows/wix', f));
      return [b.readInt32LE(18), b.readInt32LE(22)];
    };
    expect(size('dialog.bmp')).toEqual([493, 312]);
    expect(size('banner.bmp')).toEqual([493, 58]);
    expect(readFileSync(join(root, 'bundle/windows/wix/suveren.ico')).readUInt16LE(2)).toBe(1); // ICO type
  });
});
