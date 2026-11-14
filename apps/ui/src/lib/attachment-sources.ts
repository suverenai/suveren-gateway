/**
 * Attachment sources on a mandate: the scope field whose profile `format` is
 * "connector:kind" (for example email@0.9's `allowed_attachment_sources`) holds a
 * comma-separated list of `connector:kind` pairs. This module turns the
 * connectors' own `documents` declarations into checkbox choices and readable
 * labels. Nothing here names a connector, a kind or a field: the field is
 * recognised by its format, the choices come from every manifest's
 * `documents`, the wording from the manifest.
 *
 * No React/DOM import (same split as document-preview.ts).
 */

import { DOCUMENT_SOURCES_FORMAT, isDocumentSourcesField } from '@hap/core/scope-rules';

/** The profile field `format` that marks an attachment-source list — the gateway's own rule (@hap/core/scope-rules). */
export const ATTACHMENT_SOURCE_FORMAT = DOCUMENT_SOURCES_FORMAT;

/** The mandate form's heading for such a list; every surface that names the field uses it. */
export const ATTACHMENT_SOURCE_HEADING = 'What the AI may attach';

export function isAttachmentSourceField(field: { format?: string } | null | undefined): boolean {
  return isDocumentSourcesField(field);
}

/** The part of a manifest this module reads. */
export interface SourceManifestLike {
  id: string;
  name?: string;
  documents?: Record<string, {
    label?: string;
    /** Optional: the plural name for the selector ("Issued invoices"). */
    title?: string;
    /** Optional: the one-line note under it. */
    description?: string;
    /** The file name comes from the AI, not from a system archive. */
    aiSupplied?: boolean;
  }>;
}

export interface SourceOption {
  /** `connector:kind`, exactly as stored. */
  key: string;
  title: string;
  description?: string;
}

export interface SourceGroup {
  connectorId: string;
  connectorName: string;
  /** The connector is installed and not failing; false = shown disabled, "Not set up". */
  setUp: boolean;
  options: SourceOption[];
}

/** Splits the stored comma-separated string. */
export function parseSources(value: string | undefined | null): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** The stored form: unchanged comma-separated string, no spaces. */
export function joinSources(keys: string[]): string {
  return keys.join(',');
}

function capitalise(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * The selector title for one kind: the manifest's `title` if it has one,
 * else its `label` template with the `{id}` placeholder taken out
 * ("issued invoice {id}" -> "Issued invoice"), else the kind itself.
 */
export function sourceTitle(kind: string, entry: { label?: string; title?: string } | undefined): string {
  if (entry?.title?.trim()) return entry.title.trim();
  const fromLabel = (entry?.label ?? '').replace(/\{id\}/g, '').replace(/\s+/g, ' ').trim();
  return capitalise(fromLabel || kind);
}

/**
 * One group per manifest that declares `documents`, in manifest order.
 * `running` = ids of the connectors that are set up here; `null` means the
 * status is not known yet, and every group then counts as set up (the
 * checkboxes are never disabled on a guess).
 */
export function attachmentSourceGroups(
  manifests: SourceManifestLike[] | undefined,
  running: ReadonlySet<string> | null,
): SourceGroup[] {
  const groups: SourceGroup[] = [];
  const seen = new Set<string>();
  for (const m of manifests ?? []) {
    if (seen.has(m.id)) continue;
    const kinds = Object.entries(m.documents ?? {});
    if (kinds.length === 0) continue;
    seen.add(m.id);
    groups.push({
      connectorId: m.id,
      connectorName: m.name?.trim() || m.id,
      setUp: running === null ? true : running.has(m.id),
      options: kinds.map(([kind, entry]) => ({
        key: `${m.id}:${kind}`,
        title: sourceTitle(kind, entry),
        description: entry.description?.trim() || undefined,
      })),
    });
  }
  return groups;
}

/** Readable name for one `connector:kind`; the raw key when no manifest declares it. */
export function attachmentSourceLabel(manifests: SourceManifestLike[] | undefined, key: string): string {
  const i = key.indexOf(':');
  if (i < 0) return key;
  const connector = key.slice(0, i);
  const kind = key.slice(i + 1);
  const entry = manifests?.find((m) => m.id === connector)?.documents?.[kind];
  return entry ? sourceTitle(kind, entry) : key;
}

/** "Issued invoice, Saved file" for a stored value; '' when nothing is allowed. */
export function formatAttachmentSources(value: string | number | undefined | null, manifests: SourceManifestLike[] | undefined): string {
  return parseSources(value == null ? '' : String(value)).map((k) => attachmentSourceLabel(manifests, k)).join(', ');
}

/** Does the manifest flag this kind's file name as given by the AI? */
export function isAiSuppliedFileName(manifests: SourceManifestLike[] | undefined, connector: string, kind: string): boolean {
  return manifests?.find((m) => m.id === connector)?.documents?.[kind]?.aiSupplied === true;
}
