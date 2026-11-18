/**
 * How the approval card and the ticket show an attached file. Every file is
 * treated as hostile:
 *  - only a fixed list of types is shown inline; anything else (SVG, HTML,
 *    Word, zip ...) is not shown at all, whatever the connector claims;
 *  - the claimed type must match the file's first bytes, or it is not shown;
 *  - images go into <img>, video into <video> (neither runs scripts from the
 *    file); text is put on the page as TEXT, never as markup, and Markdown is
 *    not rendered;
 *  - what is shown must be the sealed bytes: `sha256Hex` of the bytes is
 *    compared with the sealed fingerprint before anything is displayed.
 *
 * No React/DOM import (same split as document-preview.ts).
 */

export type PreviewKind = 'pdf' | 'image' | 'video' | 'text';

/** The ONLY types shown inline. Value = the type the blob is created with. */
const INLINE_TYPES: Record<string, PreviewKind> = {
  'application/pdf': 'pdf',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
  'text/markdown': 'text',
  'text/plain': 'text',
};

/** The type without parameters, lower case ("Image/PNG; x=y" -> "image/png"). */
export function normalizeContentType(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase();
}

/** The inline kind for a claimed type, or null = not shown inline. */
export function previewKind(contentType: string): PreviewKind | null {
  return INLINE_TYPES[normalizeContentType(contentType)] ?? null;
}

/** The type a blob URL is created with: the allowed, normalised type; text is always text/plain. */
export function blobType(contentType: string): string | null {
  const t = normalizeContentType(contentType);
  const kind = INLINE_TYPES[t];
  if (!kind) return null;
  return kind === 'text' ? 'text/plain' : t;
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

/** Does the file start the way its claimed type says? Text is checked by `decodeText`. */
export function signatureMatches(contentType: string, bytes: Uint8Array): boolean {
  switch (normalizeContentType(contentType)) {
    case 'application/pdf': return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    case 'image/png': return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg': return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/gif': return startsWith(bytes, [0x47, 0x49, 0x46, 0x38]); // GIF8
    case 'image/webp': return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
    case 'video/mp4': return startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
    case 'video/webm': return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case 'text/markdown':
    case 'text/plain': return true;
    default: return false;
  }
}

/** Shown text is cut here, with a visible note; the full file stays one click away. */
export const TEXT_PREVIEW_LIMIT = 20000;

export interface DecodedText { text: string; truncated: boolean }

/** Valid UTF-8 without NUL bytes, or null. */
export function decodeText(bytes: Uint8Array): DecodedText | null {
  if (bytes.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return text.length > TEXT_PREVIEW_LIMIT
    ? { text: text.slice(0, TEXT_PREVIEW_LIMIT), truncated: true }
    : { text, truncated: false };
}

/** Lower-case hex SHA-256 of exactly these bytes (SubtleCrypto). */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export type ShownPreview =
  | { status: 'ok'; kind: PreviewKind; text?: DecodedText }
  | { status: 'not_shown'; reason: string }
  | { status: 'mismatch' };

/**
 * The one decision about showing bytes: fingerprint first (when a sealed one
 * is given), then type, then signature/text validity.
 */
export async function decideShown(
  contentType: string,
  bytes: Uint8Array<ArrayBuffer>,
  sealedSha256?: string,
): Promise<ShownPreview> {
  if (sealedSha256 !== undefined && (await sha256Hex(bytes)) !== sealedSha256.toLowerCase()) {
    return { status: 'mismatch' };
  }
  const kind = previewKind(contentType);
  if (!kind) return { status: 'not_shown', reason: 'This file type cannot be shown here.' };
  if (kind === 'text') {
    const text = decodeText(bytes);
    return text ? { status: 'ok', kind, text } : { status: 'not_shown', reason: 'This file is not valid text, so it is not shown.' };
  }
  if (!signatureMatches(contentType, bytes)) {
    return { status: 'not_shown', reason: 'This file does not match its stated type, so it is not shown.' };
  }
  return { status: 'ok', kind };
}

// eslint-disable-next-line no-control-regex
const CONTROL_AND_BIDI = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** Text that came from outside, for display: control characters and bidi marks removed. */
export function cleanDisplayText(s: string, max = 200): string {
  return s.replace(CONTROL_AND_BIDI, '').slice(0, max);
}
