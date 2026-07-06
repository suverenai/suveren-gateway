import { useEffect, useState } from 'react';
import { spClient } from '../lib/sp-client';

interface Option {
  value: string;
  label: string;
  extras?: Record<string, unknown>;
}

interface Props {
  /** Called once options load: full value→label map, so the ceremony can
      store human-readable names alongside the enforced raw values. */
  onLabels?: (labels: Record<string, string>) => void;
  integrationId: string;
  field: string;
  /** Comma-joined list of selected values (matches BoundsEditor's existing string-based value format). */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}

/**
 * Multi-select for a context-scope field whose valid values come from the
 * connected service (e.g. Google calendar IDs). Fetches options via the CP's
 * /integrations/:id/discover/:field endpoint on mount. Falls back to a plain
 * text input when discovery fails, so the wizard never blocks.
 */
export function DiscoveredScopeField({ integrationId, field, value, onChange, disabled, onLabels }: Props) {
  const [options, setOptions] = useState<Option[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    spClient.discoverScopeField(integrationId, field)
      .then(d => {
        if (!cancelled) {
          setOptions(d.options);
          setLoading(false);
          if (d.options?.length) {
            onLabels?.(Object.fromEntries((d.options as Option[]).map(o => [o.value, o.label])));
          }
        }
      })
      .catch(e => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [integrationId, field]);

  const selected = new Set(value.split(',').map(s => s.trim()).filter(Boolean));

  const toggle = (val: string) => {
    const next = new Set(selected);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    onChange(Array.from(next).join(','));
  };

  if (loading) {
    return <p className="hint-text" style={{ color: 'var(--text-tertiary)' }}>Loading options from {integrationId}…</p>;
  }

  // Fallback: show the free-text input with a warning banner so the user
  // isn't blocked if discovery errored.
  if (error || !options) {
    return (
      <>
        <div style={{ fontSize: '0.8rem', color: 'var(--warning)', marginBottom: '0.5rem' }}>
          Couldn't fetch options ({error ?? 'no response'}). Enter values manually, separated by commas.
        </div>
        <input
          className="form-input"
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
        />
      </>
    );
  }

  if (options.length === 0) {
    return (
      <p className="hint-text" style={{ color: 'var(--text-tertiary)' }}>
        No options available from {integrationId} for this field.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
      {options.map(opt => {
        const extras = opt.extras ?? {};
        const access = typeof extras.access === 'string' ? extras.access : undefined;
        const readOnly = access === 'reader';
        const primary = extras.primary === true;
        return (
          <label
            key={opt.value}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.875rem',
              color: readOnly ? 'var(--text-tertiary)' : 'var(--text-primary)',
              cursor: disabled || readOnly ? 'not-allowed' : 'pointer',
            }}
            title={readOnly ? 'Read-only — you can authorize list/read but not writes' : undefined}
          >
            <input
              type="checkbox"
              checked={selected.has(String(opt.value))}
              onChange={() => toggle(String(opt.value))}
              disabled={disabled || readOnly}
            />
            <span>{opt.label || opt.value}</span>
            {primary && (
              <span style={{ fontSize: '0.7rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                primary
              </span>
            )}
            {access && (
              <span style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>· {access}</span>
            )}
          </label>
        );
      })}
    </div>
  );
}
