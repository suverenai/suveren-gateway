/**
 * Limits on files that leave with a tool. Each tool that takes attachments
 * declares its own total in its manifest (`maxAttachmentBytes`,
 * tool-gating-types.ts). The gateway enforces it per file and in total on the
 * bytes it has actually read and hashed, before any ticket or proposal exists.
 */

/** The longest base64 string that can still decode to `maxBytes`. */
export function maxBase64Chars(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4;
}

/**
 * How long the gateway waits for a connector to hand over one document. An
 * 18 MB file is about 24 MB of base64, and the SDK's stdio reader needs seconds
 * for it (measured, 2026-11-09), so the 5 s of a normal preview read is too
 * short. The SDK's own request timeout is 60 s.
 */
export const DOCUMENT_READ_TIMEOUT_MS = 60_000;

/**
 * The largest single message the gateway accepts from a connector over stdio.
 * The SDK default is 10 MiB, which closes the connection on a reply carrying a
 * document of about 5 MiB or more (the reply holds the base64 twice: as text and
 * as structured content). 128 MiB covers an 18 MB file twice, with room for a larger declared limit.
 */
export const CONNECTOR_STDIO_MAX_BUFFER_BYTES = 128 * 1024 * 1024;

/** "18 MB" for 18000000. Decimal megabytes, as the limits are declared. */
export function formatMB(bytes: number): string {
  return `${Number((bytes / 1_000_000).toFixed(1))} MB`;
}
