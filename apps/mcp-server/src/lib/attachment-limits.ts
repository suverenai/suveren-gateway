/**
 * Size limits for a file that leaves with an email (document connector
 * contract, 2026-11-09): 25 MiB per attachment and 25 MiB in total per email.
 * Both are checked on the bytes the gateway has actually read and hashed,
 * before any ticket is requested.
 */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 25 * 1024 * 1024;

/** The longest base64 string that can still decode to MAX_ATTACHMENT_BYTES. */
export const MAX_ATTACHMENT_BASE64_CHARS = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;

/**
 * How long the gateway waits for a connector to hand over one document. A
 * 25 MiB file is about 33 MB of base64, and the SDK's stdio reader needs about
 * 5 s for it (measured, 2026-11-09), so the 5 s of a normal preview read is too
 * short. The SDK's own request timeout is 60 s.
 */
export const DOCUMENT_READ_TIMEOUT_MS = 60_000;

/**
 * The largest single message the gateway accepts from a connector over stdio.
 * The SDK default is 10 MiB, which closes the connection on a reply carrying a
 * document of about 5 MiB or more (the reply holds the base64 twice: as text and
 * as structured content). 128 MiB covers 25 MiB twice, with room.
 */
export const CONNECTOR_STDIO_MAX_BUFFER_BYTES = 128 * 1024 * 1024;

export function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
