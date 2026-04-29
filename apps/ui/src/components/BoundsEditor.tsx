import { useState, useRef, useEffect, type KeyboardEvent, type ClipboardEvent } from 'react';
import type { AgentProfile, AgentBoundsParams, AgentContextParams, AgentFrameParams, ProfileBoundsField, ProfileContextField } from '@hap/core';
import { DiscoveredScopeField } from './DiscoveredScopeField';
import { spClient, type IntegrationManifest, type ProfileConfig } from '../lib/sp-client';

interface Props {
  profile: AgentProfile;
  onConfirm: (bounds: AgentBoundsParams, context: AgentContextParams) => void;
  /** Called when user clicks Cancel in the hard-ceiling zone. */
  onCancel?: () => void;
  readOnly?: boolean;
  initialBounds?: AgentBoundsParams;
  initialContext?: AgentContextParams;
  initialFrame?: AgentFrameParams;
  /** Team profile config from SP. Null/undefined = no config, render as today. */
  profileConfig?: ProfileConfig | null;
  /** Display names for approver userIds. Parallel array to profileConfig.approvers. */
  approverNames?: string[];
  /** Display name of the team admin (for hard-ceiling message). */
  adminName?: string;
}

/**
 * Extract the short profile name from a fully-qualified profile id.
 *   github.com/humanagencyprotocol/hap-profiles/calendar@0.4  →  calendar
 * Integration manifests declare `profile` using the short name.
 */
function shortProfileName(profileId: string): string {
  const withoutVersion = profileId.replace(/@.*$/, '');
  return withoutVersion.split('/').pop() ?? profileId;
}

type FieldDef = ProfileBoundsField | ProfileContextField;

// ─── Helpers ────────────────────────────────────────────────────────────────

function humanizeFieldName(key: string, field: FieldDef): string {
  if (field.displayName) return field.displayName;
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function isTagField(field: FieldDef): boolean {
  return field.type === 'string' && (field.format === 'email' || field.format === 'domain');
}

function isSubsetEnumField(field: FieldDef): boolean {
  return !!(field.enum && field.constraint?.enforceable.includes('subset'));
}

function validateTag(value: string, format: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (format === 'email') return trimmed.includes('@') && trimmed.indexOf('.', trimmed.indexOf('@')) > -1;
  if (format === 'domain') return trimmed.includes('.') && !trimmed.includes('@');
  return true;
}

// ─── NumberStepper ──────────────────────────────────────────────────────────

/** Render a profile field's `unit` as a short human-readable suffix.
 *  `count` returns empty string (the count is its own meaning). */
function formatUnit(unit?: string): string {
  if (!unit || unit === 'count') return '';
  if (unit === 'minutes') return 'min';
  if (unit === 'hours') return 'hr';
  if (unit === 'days') return 'days';
  if (unit === 'percent') return '%';
  if (unit.startsWith('currency:')) return unit.slice('currency:'.length);
  return unit;
}

function NumberStepper({
  id,
  value,
  onChange,
  disabled,
  placeholder,
  unit,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  unit?: string;
}) {
  const handleDecrement = () => {
    const n = value === '' ? 0 : Number(value);
    if (n > 0) onChange(String(n - 1));
  };

  const handleIncrement = () => {
    const n = value === '' ? 0 : Number(value);
    onChange(String(n + 1));
  };

  return (
    <div className="number-stepper">
      <button
        type="button"
        className="stepper-btn stepper-decrement"
        onClick={handleDecrement}
        disabled={disabled || value === '' || Number(value) <= 0}
        aria-label="Decrease"
      >
        −
      </button>
      <input
        id={id}
        className="stepper-input"
        type="number"
        min={0}
        step={1}
        value={value}
        placeholder={placeholder ?? '0'}
        onChange={e => onChange(e.target.value)}
        onFocus={e => e.target.select()}
        disabled={disabled}
      />
      <button
        type="button"
        className="stepper-btn stepper-increment"
        onClick={handleIncrement}
        disabled={disabled}
        aria-label="Increase"
      >
        +
      </button>
      {formatUnit(unit) && (
        <span className="stepper-unit" aria-hidden="true">{formatUnit(unit)}</span>
      )}
    </div>
  );
}

// ─── TagInput ───────────────────────────────────────────────────────────────

function TagInput({
  id,
  value,
  onChange,
  disabled,
  format,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  format: 'email' | 'domain';
  placeholder?: string;
}) {
  const [inputValue, setInputValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const tags = value ? value.split(',').map(t => t.trim()).filter(Boolean) : [];

  const commitTag = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (!validateTag(trimmed, format)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const updated = tags.includes(trimmed) ? tags : [...tags, trimmed];
    onChange(updated.join(','));
    setInputValue('');
  };

  const removeTag = (index: number) => {
    const updated = tags.filter((_, i) => i !== index);
    onChange(updated.join(','));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      if (inputValue.trim()) {
        e.preventDefault();
        commitTag(inputValue);
      }
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      removeTag(tags.length - 1);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (pasted.includes(',')) {
      e.preventDefault();
      const parts = pasted.split(',').map(s => s.trim()).filter(Boolean);
      const valid = parts.filter(p => validateTag(p, format));
      const merged = [...new Set([...tags, ...valid])];
      onChange(merged.join(','));
      setInputValue('');
      setInvalid(false);
    }
  };

  const defaultPlaceholder = format === 'email'
    ? 'Type email and press Enter...'
    : 'Type domain and press Enter...';

  return (
    <div
      className={`tag-input${invalid ? ' tag-input-invalid' : ''}`}
      onClick={() => inputRef.current?.focus()}
    >
      {tags.map((tag, i) => (
        <span className="tag-pill" key={tag}>
          {tag}
          {!disabled && (
            <button
              type="button"
              className="tag-remove"
              onClick={e => { e.stopPropagation(); removeTag(i); }}
              aria-label={`Remove ${tag}`}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          ref={inputRef}
          id={id}
          className="tag-input-field"
          type="text"
          value={inputValue}
          onChange={e => { setInputValue(e.target.value); setInvalid(false); }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => { if (inputValue.trim()) commitTag(inputValue); }}
          placeholder={tags.length === 0 ? (placeholder ?? defaultPlaceholder) : ''}
        />
      )}
    </div>
  );
}

// ─── CheckboxGroup (multi-select for subset + enum) ──────────────────────

function CheckboxGroup({
  id,
  options,
  value,
  onChange,
  disabled,
}: {
  id: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const selected = value ? value.split(',').map(s => s.trim()).filter(Boolean) : [];

  const toggle = (opt: string) => {
    const updated = selected.includes(opt)
      ? selected.filter(s => s !== opt)
      : [...selected, opt];
    onChange(updated.join(','));
  };

  return (
    <div className="checkbox-group" id={id}>
      {options.map(opt => (
        <label key={opt} className={`checkbox-pill${selected.includes(opt) ? ' checkbox-pill-selected' : ''}`}>
          <input
            type="checkbox"
            checked={selected.includes(opt)}
            onChange={() => toggle(opt)}
            disabled={disabled}
          />
          <span>{opt}</span>
        </label>
      ))}
    </div>
  );
}

// ─── FieldRow ───────────────────────────────────────────────────────────────

function FieldRow({
  fieldKey,
  fieldDef,
  value,
  onChange,
  prefix,
  readOnly,
  twoColumn,
  discoveryIntegrationId,
}: {
  fieldKey: string;
  fieldDef: FieldDef;
  value: string;
  onChange: (key: string, value: string) => void;
  prefix: string;
  readOnly?: boolean;
  twoColumn?: boolean;
  /** When present AND prefix === 'context', this field uses live discovery
   * from the named integration. Overrides the plain-text-input fallback. */
  discoveryIntegrationId?: string;
}) {
  const label = humanizeFieldName(fieldKey, fieldDef);
  const fieldId = `${prefix}-field-${fieldKey}`;

  const input = (
    <>
      {isSubsetEnumField(fieldDef) ? (
        <CheckboxGroup
          id={fieldId}
          options={fieldDef.enum!}
          value={value}
          onChange={v => onChange(fieldKey, v)}
          disabled={readOnly}
        />
      ) : (() => {
          const bt = (fieldDef as { boundType?: { kind?: string; values?: unknown } }).boundType;
          return bt?.kind === 'enum' && Array.isArray(bt.values);
        })() ? (
        <select
          id={fieldId}
          className="form-select"
          value={value}
          onChange={e => onChange(fieldKey, e.target.value)}
          disabled={readOnly}
        >
          <option value="">Select...</option>
          {((fieldDef as unknown as { boundType: { values: string[] } }).boundType.values).map((v: string) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      ) : 'enum' in fieldDef && fieldDef.enum ? (
        <select
          id={fieldId}
          className="form-select"
          value={value}
          onChange={e => onChange(fieldKey, e.target.value)}
          disabled={readOnly}
        >
          <option value="">Select...</option>
          {fieldDef.enum.map((v: string) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      ) : fieldDef.type === 'number' ? (
        <NumberStepper
          id={fieldId}
          value={value}
          onChange={v => onChange(fieldKey, v)}
          disabled={readOnly}
          unit={(fieldDef as { unit?: string }).unit}
        />
      ) : isTagField(fieldDef) ? (
        <TagInput
          id={fieldId}
          value={value}
          onChange={v => onChange(fieldKey, v)}
          disabled={readOnly}
          format={fieldDef.format as 'email' | 'domain'}
        />
      ) : discoveryIntegrationId ? (
        <DiscoveredScopeField
          integrationId={discoveryIntegrationId}
          field={fieldKey}
          value={value}
          onChange={v => onChange(fieldKey, v)}
          disabled={readOnly}
        />
      ) : (
        <input
          id={fieldId}
          className="form-input"
          type="text"
          value={value}
          onChange={e => onChange(fieldKey, e.target.value)}
          disabled={readOnly}
        />
      )}
    </>
  );

  if (twoColumn) {
    return (
      <div className="bounds-field-row" key={`${prefix}-${fieldKey}`}>
        <div className="bounds-field-label">
          <label className="form-label" htmlFor={fieldId}>{label}</label>
          {fieldDef.description && (
            <div className="hint-text field-description">{fieldDef.description}</div>
          )}
        </div>
        <div className="bounds-field-input">{input}</div>
      </div>
    );
  }

  return (
    <div className="form-group" key={`${prefix}-${fieldKey}`}>
      <label className="form-label" htmlFor={fieldId}>{label}</label>
      {fieldDef.description && (
        <div className="hint-text field-description">{fieldDef.description}</div>
      )}
      {input}
    </div>
  );
}

// ─── Cap helpers ────────────────────────────────────────────────────────────

/**
 * Determine which zone we are in based on current bound values + profile config.
 * Returns one of:
 *   'no-config'         — profileConfig is null/undefined; render as today
 *   'approvers-dormant' — approvers configured, no caps. Intent is still
 *                          encrypted for them but they don't gate any action.
 *   'within-cap'        — caps configured, all bounds at or below every cap
 *   'above-approvers'   — at least one bound exceeds its cap, AND approvers set
 *   'hard-ceiling'      — at least one bound exceeds its cap, AND no approvers
 */
type CapZone = 'no-config' | 'approvers-dormant' | 'within-cap' | 'above-approvers' | 'hard-ceiling';

function computeCapZone(
  boundsValues: Record<string, string>,
  profileConfig: ProfileConfig | null | undefined,
): CapZone {
  if (!profileConfig) return 'no-config';
  const caps = profileConfig.caps;
  // Defensive: legacy / partial records may be missing `approvers`. Treat
  // missing or non-array as "no approvers".
  const hasApprovers = Array.isArray(profileConfig.approvers) && profileConfig.approvers.length > 0;
  const hasCaps = caps && Object.keys(caps).length > 0;

  if (!hasCaps) {
    // No caps configured: the only opt-in left is approvers + intent
    // encryption. If neither, render as today.
    return hasApprovers ? 'approvers-dormant' : 'no-config';
  }

  let anyViolating = false;
  for (const [key, cap] of Object.entries(caps)) {
    const raw = boundsValues[key];
    if (raw === '' || raw === undefined) continue;
    const val = Number(raw);
    if (!isNaN(val) && val > cap) {
      anyViolating = true;
      break;
    }
  }
  if (!anyViolating) return 'within-cap';
  return hasApprovers ? 'above-approvers' : 'hard-ceiling';
}

/** Returns the set of bound keys that currently violate their cap. */
function violatingKeys(
  boundsValues: Record<string, string>,
  caps: Record<string, number> | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!caps) return out;
  for (const [key, cap] of Object.entries(caps)) {
    const raw = boundsValues[key];
    if (raw === '' || raw === undefined) continue;
    const val = Number(raw);
    if (!isNaN(val) && val > cap) out.add(key);
  }
  return out;
}

// ─── BoundsEditor ───────────────────────────────────────────────────────────

export function BoundsEditor({
  profile,
  onConfirm,
  onCancel,
  readOnly,
  initialBounds,
  initialContext,
  initialFrame,
  profileConfig,
  approverNames,
  adminName,
}: Props) {
  const boundsSchema = profile.boundsSchema ?? profile.frameSchema;
  const contextSchema = profile.contextSchema;

  const boundsFields = boundsSchema
    ? Object.entries(boundsSchema.fields).filter(([key]) => {
        if (key === 'profile' || key === 'path') return false;
        return true;
      })
    : [];

  const contextFields = contextSchema && contextSchema.keyOrder.length > 0
    ? Object.entries(contextSchema.fields)
    : [];

  const seedBounds = initialBounds ?? initialFrame ?? {};
  const seedContext = initialContext ?? {};

  const initialBoundsValues: Record<string, string> = {};
  for (const [key] of boundsFields) {
    initialBoundsValues[key] = seedBounds[key] !== undefined ? String(seedBounds[key]) : '';
  }

  const initialContextValues: Record<string, string> = {};
  for (const [key] of contextFields) {
    initialContextValues[key] = seedContext[key] !== undefined ? String(seedContext[key]) : '';
  }

  const [boundsValues, setBoundsValues] = useState<Record<string, string>>(initialBoundsValues);
  const [contextValues, setContextValues] = useState<Record<string, string>>(initialContextValues);

  // Find the integration manifest (if any) whose `profile` matches the profile
  // being authorized AND which declares contextDiscovery for one or more of
  // this profile's context fields. The wizard uses this to render live-fetched
  // option lists for those fields (e.g. Google calendar IDs).
  const [discoveryIntegration, setDiscoveryIntegration] = useState<IntegrationManifest | null>(null);
  useEffect(() => {
    const shortName = shortProfileName(profile.id);
    spClient.getIntegrationManifests()
      .then(({ manifests }) => {
        const match = manifests.find(
          m => m.profile === shortName && m.contextDiscovery && Object.keys(m.contextDiscovery).length > 0,
        );
        setDiscoveryIntegration(match ?? null);
      })
      .catch(() => setDiscoveryIntegration(null));
  }, [profile.id]);

  // Compute cap zone reactively from current bound values
  const zone = computeCapZone(boundsValues, profileConfig);
  const violating = violatingKeys(boundsValues, profileConfig?.caps);

  const handleBoundsChange = (key: string, value: string) => {
    setBoundsValues(prev => ({ ...prev, [key]: value }));
  };

  const handleContextChange = (key: string, value: string) => {
    setContextValues(prev => ({ ...prev, [key]: value }));
  };

  const buildBoundsAndContext = (): [AgentBoundsParams, AgentContextParams] => {
    const bounds: AgentBoundsParams = { profile: profile.id };
    for (const [key, fieldDef] of boundsFields) {
      if (fieldDef.type === 'number') {
        bounds[key] = boundsValues[key] === '' ? 0 : Number(boundsValues[key]);
      } else {
        bounds[key] = boundsValues[key];
      }
    }
    const context: AgentContextParams = {};
    for (const [key, fieldDef] of contextFields) {
      if (fieldDef.type === 'number') {
        context[key] = contextValues[key] === '' ? 0 : Number(contextValues[key]);
      } else {
        context[key] = contextValues[key];
      }
    }
    return [bounds, context];
  };

  const handleConfirm = () => {
    const [bounds, context] = buildBoundsAndContext();
    onConfirm(bounds, context);
  };

  /** Clamp all violating bounds to their cap value, then proceed. */
  const handleSaveBelowCap = () => {
    const caps = profileConfig?.caps ?? {};
    const clamped = { ...boundsValues };
    for (const key of violating) {
      if (caps[key] !== undefined) {
        clamped[key] = String(caps[key]);
      }
    }
    setBoundsValues(clamped);
    // Build bounds from clamped values inline (state update is async)
    const bounds: AgentBoundsParams = { profile: profile.id };
    for (const [key, fieldDef] of boundsFields) {
      if (fieldDef.type === 'number') {
        const raw = clamped[key] ?? '';
        bounds[key] = raw === '' ? 0 : Number(raw);
      } else {
        bounds[key] = clamped[key] ?? '';
      }
    }
    const context: AgentContextParams = {};
    for (const [key, fieldDef] of contextFields) {
      if (fieldDef.type === 'number') {
        context[key] = contextValues[key] === '' ? 0 : Number(contextValues[key]);
      } else {
        context[key] = contextValues[key];
      }
    }
    onConfirm(bounds, context);
  };

  // ─── Render cap indicator for a single bound key ───────────────────────

  const renderCapIndicator = (key: string) => {
    const caps = profileConfig?.caps;
    if (!caps || caps[key] === undefined) return null;
    const cap = caps[key];
    const isViolating = violating.has(key);

    if (zone === 'hard-ceiling' && isViolating) {
      return (
        <span style={{ fontSize: '0.72rem', color: 'var(--danger)', marginLeft: '0.5rem', whiteSpace: 'nowrap' }}>
          Cap: {cap} — exceeds team ceiling
        </span>
      );
    }
    if (zone === 'above-approvers' && isViolating) {
      return (
        <span style={{ fontSize: '0.72rem', color: 'var(--warning)', marginLeft: '0.5rem', whiteSpace: 'nowrap' }}>
          Cap: {cap} — above cap
        </span>
      );
    }
    // within-cap (or no violation on this specific key)
    return (
      <span style={{ fontSize: '0.72rem', color: 'var(--success)', marginLeft: '0.5rem', whiteSpace: 'nowrap' }}>
        Cap: {cap} ok
      </span>
    );
  };

  // ─── Zone footer panel ──────────────────────────────────────────────────

  const renderZoneFooter = () => {
    if (zone === 'no-config') return null;

    if (zone === 'approvers-dormant') {
      const names = (approverNames && approverNames.length > 0) ? approverNames.join(', ') : 'the configured approvers';
      return (
        <div style={{
          marginTop: '0.75rem',
          padding: '0.75rem 1rem',
          border: '1px solid var(--accent)',
          borderRadius: '0.375rem',
          background: 'var(--bg-elevated)',
          fontSize: '0.82rem',
        }}>
          <div style={{ fontWeight: 600, color: 'var(--accent)', marginBottom: '0.25rem' }}>
            Profile approvers: {names}
          </div>
          <div>
            No caps are set on this profile, so {names} won&apos;t gate any
            action under this authority. Your intent will still be encrypted
            and shared with them as an accountability record &mdash; they can
            read what you authorised, even though they aren&apos;t reviewing
            individual actions.
          </div>
        </div>
      );
    }

    if (zone === 'within-cap') {
      return (
        <div style={{
          marginTop: '0.75rem',
          padding: '0.75rem 1rem',
          border: '1px solid var(--border)',
          borderRadius: '0.375rem',
          background: 'var(--bg-elevated)',
          fontSize: '0.82rem',
        }}>
          <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Within all team caps — your responsibility.</div>
        </div>
      );
    }

    if (zone === 'above-approvers') {
      const names = (approverNames && approverNames.length > 0) ? approverNames.join(', ') : 'the required approvers';
      return (
        <div style={{
          marginTop: '0.75rem',
          padding: '0.75rem 1rem',
          border: '1px solid var(--warning)',
          borderRadius: '0.375rem',
          background: 'var(--bg-elevated)',
          fontSize: '0.82rem',
        }}>
          <div style={{ fontWeight: 600, color: 'var(--warning)', marginBottom: '0.25rem' }}>Above team cap.</div>
          <div>
            <strong>Over-cap actions</strong> will require approval from you and {names}.
            Within-cap actions run per the mode you choose.
          </div>
        </div>
      );
    }

    if (zone === 'hard-ceiling') {
      // Find the first violating bound and its cap for the message
      const firstViolatingKey = Array.from(violating)[0];
      const cap = firstViolatingKey ? profileConfig?.caps?.[firstViolatingKey] : undefined;
      const admin = adminName ?? 'the team admin';
      return (
        <div style={{
          marginTop: '0.75rem',
          padding: '0.75rem 1rem',
          border: '1px solid var(--danger)',
          borderRadius: '0.375rem',
          background: 'var(--bg-elevated)',
          fontSize: '0.82rem',
        }}>
          <div style={{ fontWeight: 600, color: 'var(--danger)', marginBottom: '0.25rem' }}>Hard team ceiling.</div>
          <div style={{ marginBottom: '0.75rem' }}>
            Team policy caps this at {cap ?? 'the configured limit'}.
            Lower your bound or ask {admin} to add an approver path above the cap.
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleSaveBelowCap}
            >
              Save below cap
            </button>
            {onCancel && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={onCancel}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      );
    }

    return null;
  };

  // Whether the primary Continue button should be disabled
  const continueBlocked = zone === 'hard-ceiling';

  return (
    <div>
      {contextFields.length > 0 && (
        <div className="context-section">
          <div className="bounds-section-header">
            <span className="bounds-section-icon">&#x1F6E1;</span>
            <div>
              <div className="bounds-section-title">Allowed scope</div>
              <div className="bounds-section-subtitle">Encrypted on your device, never sent to the SP</div>
            </div>
          </div>
          {contextFields.map(([key, fieldDef]) => {
            const hasDiscovery = !!discoveryIntegration?.contextDiscovery?.[key];
            return (
              <FieldRow
                key={`context-${key}`}
                fieldKey={key}
                fieldDef={fieldDef}
                value={contextValues[key]}
                onChange={handleContextChange}
                prefix="context"
                readOnly={readOnly}
                discoveryIntegrationId={hasDiscovery ? discoveryIntegration!.id : undefined}
              />
            );
          })}
        </div>
      )}

      {boundsFields.length > 0 && (
        <div className="bounds-section">
          <div className="bounds-section-header">
            <span className="bounds-section-icon">&#x1F512;</span>
            <div>
              <div className="bounds-section-title">Limits</div>
              <div className="bounds-section-subtitle">Enforced by the Service Provider</div>
            </div>
          </div>
          <div className="bounds-fields-grid">
            {boundsFields.map(([key, fieldDef]) => (
              <div key={`bounds-${key}`} style={{ display: 'contents' }}>
                <FieldRow
                  fieldKey={key}
                  fieldDef={fieldDef}
                  value={boundsValues[key]}
                  onChange={handleBoundsChange}
                  prefix="bounds"
                  readOnly={readOnly}
                  twoColumn
                />
                {/* Cap indicator appended after the input column, inside the grid row */}
                {zone !== 'no-config' && profileConfig?.caps?.[key] !== undefined && (
                  <div style={{ gridColumn: '2 / 3', display: 'flex', alignItems: 'center', paddingBottom: '0.5rem' }}>
                    {renderCapIndicator(key)}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Zone footer */}
          {renderZoneFooter()}
        </div>
      )}

      <button
        className="btn btn-primary"
        onClick={handleConfirm}
        disabled={continueBlocked}
        style={{ marginTop: '0.5rem' }}
      >
        {readOnly ? 'Next: Gates' : 'Next: Problem Statement'}
      </button>
    </div>
  );
}
