#!/usr/bin/env node
/**
 * Writes bundle/windows/wix/License.rtf — the licence page of the Windows
 * installer — from the repository's LICENSE (MIT), word for word, plus one
 * sentence about the third-party components the installer bundles.
 *
 *   node bundle/windows/license-rtf.mjs
 *
 * apps/control-plane/src/__tests__/windows-license-rtf.test.ts fails when the
 * committed License.rtf no longer matches LICENSE, so the two cannot drift.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const THIRD_PARTY_NOTE =
  'Third-party components (Node.js and libraries) are included under their own ' +
  'open-source licences; see the licence files in the installation folder.';

function rtfEscape(text) {
  return text
    .replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}')
    .replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0)}?`);
}

export function buildLicenseRtf(licenseText) {
  const paragraphs = licenseText.trim().split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim());
  paragraphs.push(THIRD_PARTY_NOTE);
  const body = paragraphs.map((p, i) => (i === 0 ? `{\\b ${rtfEscape(p)}}` : rtfEscape(p))).join('\\par\\par\n');
  return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Segoe UI;}}\\viewkind4\\uc1\\f0\\fs18\n${body}\\par\n}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rtf = buildLicenseRtf(readFileSync(join(ROOT, 'LICENSE'), 'utf8'));
  writeFileSync(join(ROOT, 'bundle', 'windows', 'wix', 'License.rtf'), rtf);
  console.log('wrote bundle/windows/wix/License.rtf');
}
