/**
 * "What the AI may attach" — the mandate form's control for a scope field
 * whose profile format is "connector:kind" (lib/attachment-sources.ts).
 * Checkboxes are built from every connector manifest's `documents`; a
 * connector that is not set up is shown disabled with "Not set up". The value
 * stays the comma-separated `connector:kind` string.
 */
import { useEffect, useState } from 'react';
import { spClient } from '../lib/sp-client';
import {
  ATTACHMENT_SOURCE_HEADING,
  attachmentSourceGroups,
  joinSources,
  parseSources,
  type SourceGroup,
  type SourceManifestLike,
} from '../lib/attachment-sources';

interface Loaded { manifests: SourceManifestLike[]; running: Set<string> }

export function AttachmentSourcePicker({ id, value, onChange, disabled }: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [loaded, setLoaded] = useState<Loaded | 'loading' | 'error'>('loading');
  useEffect(() => {
    let live = true;
    Promise.all([spClient.getIntegrationManifests(), spClient.getMcpIntegrations()])
      .then(([m, i]) => {
        if (!live) return;
        const running = new Set(
          i.integrations.filter((x) => !x.error && (x.running || x.paused)).map((x) => x.id),
        );
        setLoaded({ manifests: m.manifests ?? [], running });
      })
      .catch(() => { if (live) setLoaded('error'); });
    return () => { live = false; };
  }, []);

  const selected = parseSources(value);
  const toggle = (key: string) =>
    onChange(joinSources(selected.includes(key) ? selected.filter((s) => s !== key) : [...selected, key]));

  const groups: SourceGroup[] = loaded === 'loading' || loaded === 'error'
    ? []
    : attachmentSourceGroups(loaded.manifests, loaded.running);
  const known = new Set(groups.flatMap((g) => g.options.map((o) => o.key)));
  // A value already on the mandate that no connector declares any more stays
  // visible and removable, so nothing is signed out of sight.
  const orphans = selected.filter((k) => !known.has(k));

  return (
    <div className="attach-src" id={id}>
      <h3 className="attach-src-title">{ATTACHMENT_SOURCE_HEADING}</h3>
      <p className="attach-src-note">Tick what may leave with these emails. Nothing ticked means text only.</p>
      {loaded === 'loading' && <p className="attach-src-note">Loading the connectors…</p>}
      {loaded === 'error' && <p className="attach-src-note" role="alert">Could not load the connectors. Nothing was changed.</p>}
      {groups.map((g) => (
        <div className="attach-src-group" key={g.connectorId}>
          <h4>{g.connectorName}</h4>
          {g.options.map((o) => {
            const checked = selected.includes(o.key);
            const off = !g.setUp;
            return (
              <label className={`attach-src-opt${off ? ' attach-src-off' : ''}`} key={o.key}>
                <input
                  type="checkbox"
                  data-source={o.key}
                  checked={checked}
                  // Not set up: cannot be ticked, but a tick already there can be removed.
                  disabled={disabled || (off && !checked)}
                  onChange={() => toggle(o.key)}
                />
                <span>
                  {o.title}
                  {o.description && <small>{o.description}</small>}
                </span>
                {off && <span className="attach-src-status">Not set up</span>}
              </label>
            );
          })}
        </div>
      ))}
      {orphans.length > 0 && (
        <div className="attach-src-group">
          <h4>Not available</h4>
          {orphans.map((k) => (
            <label className="attach-src-opt attach-src-off" key={k}>
              <input type="checkbox" checked disabled={disabled} onChange={() => toggle(k)} />
              <span>{k}</span>
              <span className="attach-src-status">Not set up</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
