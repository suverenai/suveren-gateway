/**
 * Render scope values with their discovered display names.
 *
 * Context values are the ENFORCED truth (e.g. a raw Google calendar id like
 * `4d3f01…@group.calendar.google.com`) — unreadable for humans. During the
 * ceremony the discovery dropdown knows each value's label ("Emma"); the
 * ceremony stores that map with the local gate entry, and every display
 * surface renders `label (id…)` through this helper. Values without a label
 * (typed manually, or grants created before labels existed) fall back to the
 * raw value.
 */

import { isAttachmentSourceField, formatAttachmentSources, type SourceManifestLike } from './attachment-sources';

export type ContextLabels = Record<string, Record<string, string>>;

/** Shorten an opaque identifier for display: keep enough to recognize it. */
function shortId(value: string): string {
  return value.length > 24 ? `${value.slice(0, 10)}…` : value;
}

/**
 * Format one scope value (possibly comma-joined) for display.
 * With a label: "Emma (4d3f0153c6…)". Without: the raw value.
 */
export function formatScopeValue(
  fieldKey: string,
  value: string | number,
  labels?: ContextLabels,
): string {
  const fieldLabels = labels?.[fieldKey];
  const parts = String(value).split(',').map(s => s.trim()).filter(Boolean);
  return parts
    .map(p => {
      const label = fieldLabels?.[p];
      return label ? `${label} (${shortId(p)})` : p;
    })
    .join(', ');
}

/**
 * `formatScopeValue`, but aware of the field's profile definition: a list of
 * attachment sources (format "connector:kind") is shown by the connectors' own
 * names ("Issued invoice, Saved file"), and an empty list as "None: text
 * only". Any other field is formatted as before.
 */
export function formatScopeFieldValue(
  fieldKey: string,
  value: string | number,
  field: { format?: string } | undefined,
  manifests: SourceManifestLike[] | undefined,
  labels?: ContextLabels,
): string {
  if (isAttachmentSourceField(field)) {
    return formatAttachmentSources(value, manifests) || 'None: text only';
  }
  return formatScopeValue(fieldKey, value, labels);
}
