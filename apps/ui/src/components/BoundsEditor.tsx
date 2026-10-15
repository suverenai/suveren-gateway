import { useState, useRef, useEffect, type KeyboardEvent, type ClipboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { AgentProfile, AgentBoundsParams, AgentScopeParams, ProfileBoundsField, ProfileScopeField } from '@hap/core';
import { DiscoveredScopeField } from './DiscoveredScopeField';
import { spClient, type IntegrationManifest, type ProfileConfig, type CapKind } from '../lib/sp-client';
import { minForBound, maxForBound, seedForBound, numericBoundValue } from '../lib/bound-defaults';
import { formatUnit } from '../lib/bound-format';
import { effectiveCapKind, enumExceedsCap, isCapped, type CapFieldShape } from '../lib/team-caps';

interface Props {
  profile: AgentProfile;
  onConfirm: (
    bounds: AgentBoundsParams,
    context: AgentScopeParams,
    /** Discovered display names per context field: fieldKey → (value → label). */
    contextLabels?: Record<string, Record<string, string>>,
  ) => void;
  /** Called when user clicks Cancel in the hard-ceiling zone. */
  onCancel?: () => void;
  readOnly?: boolean;
  initialBounds?: AgentBoundsParams;
  initialContext?: AgentScopeParams;
  /** v0.3 compat fallback — AgentFrameParams was retired from hap-core (no
   *  alias); no caller passes this prop any more, but the shape (a flat
   *  bounds-like record) is unchanged, so it stays usable as a fallback. */
  initialFrame?: Record<string, string | number>;
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

type FieldDef = ProfileBoundsField | ProfileScopeField;

/**
 * A SCOPE field with an `enum` constraint carries its allowed values in a
 * top-level `enum: string[]` at runtime (see e.g. hap-profiles'
 * sales/0.4.profile.json scopeSchema.currency) — but hap-core's
 * `ProfileScopeField` TS type does not declare it (only `BOUNDS` fields'
 * capability-flag shape, `boundType: { kind: 'enum', values }`, is typed).
 * This widens the type to read the real data the schema carries; it changes
 * nothing about what ships in a profile.
 */
type FieldDefWithEnum = FieldDef & { enum?: string[] };

// ─── Helpers ────────────────────────────────────────────────────────────────

export function humanizeFieldName(key: string, field: FieldDef): string {
  if (field.displayName) return field.displayName;
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function isTagField(field: FieldDef): boolean {
  return field.type === 'string' && (field.format === 'email' || field.format === 'domain');
}

function isSubsetEnumField(field: FieldDef): boolean {
  // `constraint` (and the runtime-only `enum`) are a SCOPE-field concept —
  // bounds fields use `boundType` instead and never reach this check true.
  const f = field as ProfileScopeField & { enum?: string[] };
  return !!(f.enum && f.constraint?.enforceable.includes('subset'));
}

function validateTag(value: string, format: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (format === 'email') return trimmed.includes('@') && trimmed.indexOf('.', trimmed.indexOf('@')) > -1;
  if (format === 'domain') return trimmed.includes('.') && !trimmed.includes('@');
  return true;
}

// ─── BoundedNumberInput ─────────────────────────────────────────────────────

/** Render a profile field's `unit` as a human-readable suffix.
 *  `count` returns empty string (the count is its own meaning). */

/** Smart step size for +/- buttons based on the unit. */
function stepFor(unit?: string): number {
  if (!unit) return 1;
  if (unit === 'minutes') return 15;
  if (unit === 'percent') return 5;
  if (unit.startsWith('currency:')) return 10;
  return 1; // count, hours, days
}

/** Quick-preset chips beneath the input. Empty array → no presets row. */
function presetsFor(unit?: string): Array<{ value: number; label: string }> {
  if (!unit) return [];
  if (unit === 'minutes') return [
    { value: 15, label: '15m' },
    { value: 30, label: '30m' },
    { value: 60, label: '1h' },
    { value: 120, label: '2h' },
    { value: 240, label: '4h' },
  ];
  if (unit === 'hours') return [
    { value: 1, label: '1h' },
    { value: 4, label: '4h' },
    { value: 8, label: '8h' },
    { value: 24, label: '1d' },
  ];
  if (unit === 'days') return [
    { value: 1, label: '1d' },
    { value: 7, label: '1w' },
    { value: 30, label: '1mo' },
    { value: 90, label: '3mo' },
  ];
  if (unit === 'percent') return [
    { value: 10, label: '10%' },
    { value: 25, label: '25%' },
    { value: 50, label: '50%' },
    { value: 100, label: '100%' },
  ];
  if (unit.startsWith('currency:')) return [
    { value: 10, label: '10' },
    { value: 50, label: '50' },
    { value: 100, label: '100' },
    { value: 500, label: '500' },
    { value: 1000, label: '1k' },
  ];
  return []; // count → no presets, +/- step 1 is enough
}

/** Friendly echo when a value crosses a unit boundary, e.g.
 *  120 minutes → "≈ 2 hours". Returns '' when no useful echo. */
function naturalEcho(value: string, unit?: string): string {
  if (!value || !unit) return '';
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (unit === 'minutes' && n >= 60) {
    const h = Math.floor(n / 60);
    const m = n % 60;
    if (m === 0) return `${h} hour${h !== 1 ? 's' : ''}`;
    return `${h}h ${m}m`;
  }
  if (unit === 'hours' && n >= 24 && n % 24 === 0) {
    const d = n / 24;
    return `${d} day${d !== 1 ? 's' : ''}`;
  }
  if (unit === 'days') {
    if (n >= 30 && n % 30 === 0) return `${n / 30} month${n / 30 !== 1 ? 's' : ''}`;
    if (n >= 7 && n % 7 === 0) return `${n / 7} week${n / 7 !== 1 ? 's' : ''}`;
  }
  return '';
}

function BoundedNumberInput({
  id,
  value,
  onChange,
  disabled,
  placeholder,
  unit,
  min = 0,
  max,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  unit?: string;
  /** Floor for the value — see bound-defaults.ts. */
  min?: 0 | 1;
  /** Ceiling the profile declares (`maximum`) — see bound-defaults.ts. */
  max?: number;
}) {
  const step = stepFor(unit);
  const presets = presetsFor(unit).filter(p => max === undefined || p.value <= max);
  const unitLabel = formatUnit(unit);
  const echo = naturalEcho(value, unit);
  const currentNum = value === '' ? null : Number(value);

  /** Snap to the next/previous step boundary. */
  const handleIncrement = () => {
    const n = value === '' ? 0 : Number(value);
    const remainder = n % step;
    const next = remainder === 0 ? n + step : n + (step - remainder);
    onChange(String(max !== undefined ? Math.min(max, next) : next));
  };

  const handleDecrement = () => {
    const n = value === '' ? 0 : Number(value);
    if (n <= min) return;
    const remainder = n % step;
    const prev = remainder === 0 ? n - step : n - remainder;
    onChange(String(Math.max(min, prev)));
  };

  return (
    <div className="bounded-input">
      <div className="bounded-input-field">
        <button
          type="button"
          className="stepper-btn stepper-decrement"
          onClick={handleDecrement}
          disabled={disabled || value === '' || Number(value) <= min}
          aria-label="Decrease"
        >
          −
        </button>
        <input
          id={id}
          className="stepper-input"
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          placeholder={placeholder ?? String(min)}
          onChange={e => {
            const v = e.target.value;
            // Never hold a value above the profile's maximum — the owner
            // cannot type past it (submit clamps too: numericBoundValue).
            onChange(max !== undefined && v !== '' && Number(v) > max ? String(max) : v);
          }}
          onFocus={e => e.target.select()}
          disabled={disabled}
        />
        <button
          type="button"
          className="stepper-btn stepper-increment"
          onClick={handleIncrement}
          disabled={disabled || (max !== undefined && value !== '' && Number(value) >= max)}
          aria-label="Increase"
        >
          +
        </button>
        {unitLabel && (
          <span className="bounded-input-unit" aria-hidden="true">{unitLabel}</span>
        )}
      </div>
      {presets.length > 0 && !disabled && (
        <div className="bounded-input-presets" role="group" aria-label="Quick presets">
          {presets.map(p => (
            <button
              key={p.value}
              type="button"
              className={`preset-chip${currentNum === p.value ? ' preset-chip-selected' : ''}`}
              onClick={() => onChange(String(p.value))}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      {echo && <div className="bounded-input-echo">≈ {echo}</div>}
    </div>
  );
}

// ─── FieldLabel (label + tip popover) ──────────────────────────────────────

function FieldLabel({
  htmlFor,
  label,
  description,
}: {
  htmlFor: string;
  label: string;
  description?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="field-label-with-tip">
      <label className="form-label" htmlFor={htmlFor}>{label}</label>
      {description && (
        <>
          <button
            type="button"
            className="field-tip-trigger"
            aria-label={`What does "${label}" mean?`}
            aria-expanded={open}
            onClick={() => setOpen(v => !v)}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onBlur={() => setOpen(false)}
          >
            i
          </button>
          {open && <div className="field-tip-bubble" role="tooltip">{description}</div>}
        </>
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
  onLabels,
  capMax,
  enumAllowedFrom,
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
  /** Discovered value→label map for this field (display names). */
  onLabels?: (fieldKey: string, labels: Record<string, string>) => void;
  /**
   * TR5 — a HARD team cap on a numeric field: further narrows the profile's
   * own `maximum` (bound-defaults.ts's `maxForBound`), so the stepper stops
   * at whichever of the two is stricter and cannot be raised past it here.
   */
  capMax?: number;
  /**
   * TR5 — a HARD team cap on an enum (capability-switch) field: the index
   * (into the field's own permissive-first `boundType.values`) of the most
   * permissive value still allowed. Options before that index are disabled
   * — see team-caps.ts's `enumExceedsCap` doc comment for the ordering
   * convention this assumes.
   */
  enumAllowedFrom?: number;
}) {
  const label = humanizeFieldName(fieldKey, fieldDef);
  const fieldId = `${prefix}-field-${fieldKey}`;

  const input = (
    <>
      {isSubsetEnumField(fieldDef) ? (
        <CheckboxGroup
          id={fieldId}
          options={(fieldDef as FieldDefWithEnum).enum!}
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
          disabled={
            readOnly ||
            // Only one value remains choosable (the cap left no freedom at
            // all, e.g. capped at the most restrictive value) — disable the
            // whole control rather than a <select> with exactly one enabled
            // option, which reads as broken, not "no choice".
            (enumAllowedFrom !== undefined &&
              (fieldDef as unknown as { boundType: { values: string[] } }).boundType.values.length - enumAllowedFrom <= 1)
          }
        >
          <option value="">Select...</option>
          {((fieldDef as unknown as { boundType: { values: string[] } }).boundType.values).map((v: string, i: number) => (
            <option key={v} value={v} disabled={enumAllowedFrom !== undefined && i < enumAllowedFrom}>{v}</option>
          ))}
        </select>
      ) : (fieldDef as FieldDefWithEnum).enum ? (
        <select
          id={fieldId}
          className="form-select"
          value={value}
          onChange={e => onChange(fieldKey, e.target.value)}
          disabled={readOnly}
        >
          <option value="">Select...</option>
          {(fieldDef as FieldDefWithEnum).enum!.map((v: string) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      ) : fieldDef.type === 'number' ? (
        <BoundedNumberInput
          id={fieldId}
          value={value}
          onChange={v => onChange(fieldKey, v)}
          disabled={readOnly}
          unit={(fieldDef as { unit?: string }).unit}
          min={minForBound(fieldDef)}
          max={capMax !== undefined ? Math.min(capMax, maxForBound(fieldDef) ?? capMax) : maxForBound(fieldDef)}
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
          onLabels={labels => onLabels?.(fieldKey, labels)}
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
          <FieldLabel htmlFor={fieldId} label={label} description={fieldDef.description} />
        </div>
        <div className="bounds-field-input">{input}</div>
      </div>
    );
  }

  return (
    <div className="form-group" key={`${prefix}-${fieldKey}`}>
      <FieldLabel htmlFor={fieldId} label={label} description={fieldDef.description} />
      {input}
    </div>
  );
}

// ─── Cap helpers (TR5 — per-field, kind-aware; team-caps.ts) ───────────────

/** This field's team-cap state, or null when it carries no cap at all. */
export interface FieldCapState {
  kind: CapKind;
  cap: number | string;
  /** Current input value exceeds the cap. */
  violating: boolean;
}

export function fieldCapState(
  key: string,
  fieldDef: FieldDef,
  value: string,
  profileConfig: ProfileConfig | null | undefined,
): FieldCapState | null {
  if (!profileConfig || !isCapped(profileConfig, key)) return null;
  const cap = profileConfig.caps![key];
  const kind = effectiveCapKind(profileConfig, fieldDef as CapFieldShape, key);
  let violating = false;
  if (typeof cap === 'number') {
    const n = value === '' ? NaN : Number(value);
    violating = !Number.isNaN(n) && n > cap;
  } else if (typeof cap === 'string' && value !== '') {
    const bt = (fieldDef as { boundType?: { kind?: string; values?: readonly string[] } }).boundType;
    violating = bt?.kind === 'enum' ? enumExceedsCap(bt.values ?? [], cap, value) : false;
  }
  return { kind, cap, violating };
}

/**
 * The seed value for ONE bound field, with a hard team cap applied —
 * shared by the initial `useState` seed and the late-arriving-config
 * re-seed effect below (GateWizardPage fetches `profile` and the team
 * `profileConfig` independently; `profile` — and so this editor's mount —
 * routinely resolves first, with `profileConfig` still null). Pulled out
 * as its own pure function specifically so the "config arrives after
 * mount" ordering is unit-testable without rendering the component.
 *
 * `rawValue` is the value BEFORE any cap is considered (the profile's own
 * seed/default, or whatever is already in the input). A HARD numeric cap
 * clamps it down (or seeds AT the cap when there is nothing else to
 * default to — the mockup's "Max email age" starts at exactly the team
 * limit, never empty); a HARD enum cap clamps it down to the cap only
 * when it would otherwise exceed it (never changes an already-compliant
 * choice, e.g. "none" is left as "none" under a cap of "none"). No cap, or
 * an 'approval' kind cap (above-cap is allowed, not clamped away): the raw
 * value passes through unchanged.
 */
export function seedBoundValue(
  key: string,
  fieldDef: FieldDef,
  rawValue: string,
  profileConfig: ProfileConfig | null | undefined,
): string {
  if (!profileConfig || !isCapped(profileConfig, key)) return rawValue;
  const kind = effectiveCapKind(profileConfig, fieldDef as CapFieldShape, key);
  const cap = profileConfig.caps![key];
  if (kind !== 'hard') return rawValue;
  if (typeof cap === 'number') {
    const n = rawValue === '' ? NaN : Number(rawValue);
    return String(Number.isNaN(n) ? cap : Math.min(n, cap));
  }
  if (typeof cap === 'string') {
    const bt = (fieldDef as { boundType?: { kind?: string; values?: readonly string[] } }).boundType;
    const values = bt?.kind === 'enum' ? bt.values ?? [] : [];
    return rawValue !== '' && enumExceedsCap(values, cap, rawValue) ? cap : rawValue;
  }
  return rawValue;
}

/** The index of `cap` in an enum field's (permissive-first) `values`, for
 *  FieldRow's `enumAllowedFrom` — undefined when not an enum cap. */
export function enumAllowedFromIndex(fieldDef: FieldDef, cap: number | string): number | undefined {
  if (typeof cap !== 'string') return undefined;
  const bt = (fieldDef as { boundType?: { kind?: string; values?: readonly string[] } }).boundType;
  if (bt?.kind !== 'enum') return undefined;
  const idx = (bt.values ?? []).indexOf(cap);
  return idx === -1 ? undefined : idx;
}

/** "Every <unit> above <cap>..." — `<unit>` is the field's declared unit
 *  when it has a real one (days, %, a currency symbol), else the field's
 *  own human label, lower-cased (a count field, e.g. "emails per day", has
 *  no unit word of its own — "every count above 50" would read as nonsense). */
export function capUnitLabel(key: string, fieldDef: FieldDef): string {
  const u = formatUnit((fieldDef as { unit?: string }).unit);
  return u || humanizeFieldName(key, fieldDef).toLowerCase();
}

export function approverListLabel(profileConfig: ProfileConfig | null | undefined, approverNames: string[] | undefined): string {
  if (approverNames && approverNames.length > 0) return approverNames.join(' or ');
  const ids = profileConfig?.approvers ?? [];
  return ids.length > 0 ? ids.join(' or ') : 'your team\'s approvers';
}

/** One field's cap note — rendered directly under its input. Matches the
 *  signed-off mockup (temp/team-caps-mockup/index.html, screen 2) wording. */
function renderFieldCapNote(
  key: string,
  fieldDef: FieldDef,
  state: FieldCapState,
  profileConfig: ProfileConfig | null | undefined,
  approverNames: string[] | undefined,
): ReactNode {
  const isReadLimit = (fieldDef as { enforcedBy?: string }).enforcedBy === 'gatekeeper';
  const isEnum = (fieldDef as { boundType?: { kind?: string } }).boundType?.kind === 'enum';

  if (state.kind === 'hard') {
    if (isEnum) {
      return (
        <span className="cap-note hard" data-testid={`cap-note-${key}`}>
          Disabled by your team&apos;s policy — {humanizeFieldName(key, fieldDef).toLowerCase()} is capped at{' '}
          {String(state.cap)} for this profile.
        </span>
      );
    }
    return (
      <span className="cap-note hard" data-testid={`cap-note-${key}`}>
        Team limit {String(state.cap)}
        {isReadLimit ? ' — read limits are always hard, no approval path exists for this cap.' : ''}
      </span>
    );
  }

  // 'approval' — never reachable for an enum or read-limit field (both are
  // forced to 'hard' by effectiveCapKind), so this is always a plain number.
  const unit = capUnitLabel(key, fieldDef);
  const approvers = approverListLabel(profileConfig, approverNames);
  return (
    <span className="cap-note soft" data-testid={`cap-note-${key}`}>
      Every {unit} above {String(state.cap)} goes to {approvers} for approval.
    </span>
  );
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
  const boundsSchema = profile.boundsSchema;
  const contextSchema = profile.scopeSchema;

  // TR7/TR6 (work-plan "Added 2026-10-14"): a gatekeeper-enforced (read
  // limit) field normally stays hidden here (enforcement is local, not the
  // Authority Server's) — EXCEPT when the team has put a cap on it. A team
  // read cap is always hard and gets SIGNED into the mandate as a ceiling
  // (suveren-as TR6), so the AS now refuses a team mandate that omits it —
  // it must become an editable (if capped/clamped) control here, or mandate
  // creation would break for every team that caps a read field. See mockup
  // screen 2's "Max email age" row.
  const isTeamCappedLocalField = (key: string): boolean =>
    !!profileConfig && isCapped(profileConfig, key);

  const boundsFields = boundsSchema
    ? Object.entries(boundsSchema.fields).filter(([key, def]) => {
        if (key === 'profile' || key === 'path') return false;
        // Hide bounds the profile declares as not enforced. Offering a control
        // that nothing acts on is worse than omitting it: it reads as a working
        // protection. Driven by the profile, not a hardcoded field list, so a
        // bound becomes visible the moment enforcement lands.
        if ((def as { enforced?: boolean }).enforced === false) return false;
        // Hide bounds the Authority Server does not enforce. This section is
        // titled "Enforced by the Service Provider", and for a locally-enforced
        // limit that claim is simply false — reads carry no receipt, so no
        // signed check ever reads the value. Those limits live on the
        // integration, where they are live-editable; the grant keeps its copy
        // only as a fallback for authorizations issued before that existed.
        // Profile-driven, so any bound can declare where it is enforced.
        // TR6/TR7: unless the team capped it — see isTeamCappedLocalField above.
        if ((def as { enforcedBy?: string }).enforcedBy === 'gatekeeper' && !isTeamCappedLocalField(key)) return false;
        return true;
      })
    : [];

  /** Locally-enforced bounds, hidden above — surfaced as a pointer, not a
   *  control. Excludes any the team capped (TR6/TR7) — those are shown
   *  above instead, not pointed at. */
  const localBoundNames = boundsSchema
    ? Object.entries(boundsSchema.fields)
        .filter(([key, def]) => (def as { enforcedBy?: string }).enforcedBy === 'gatekeeper' && !isTeamCappedLocalField(key))
        .filter(([, def]) => (def as { enforced?: boolean }).enforced !== false)
        .map(([key, def]) => (def as { displayName?: string }).displayName ?? key)
    : [];

  const contextFields = contextSchema && contextSchema.keyOrder.length > 0
    ? Object.entries(contextSchema.fields)
    : [];

  const seedBounds = initialBounds ?? initialFrame ?? {};
  const seedContext = initialContext ?? {};

  const initialBoundsValues: Record<string, string> = {};
  for (const [key, fieldDef] of boundsFields) {
    // TR5 — a HARD team cap: never seed (or carry forward, e.g. Copy/Edit) a
    // value already above it. See seedBoundValue's doc comment.
    initialBoundsValues[key] = seedBoundValue(key, fieldDef, seedForBound(fieldDef, seedBounds[key]), profileConfig);
  }

  const initialContextValues: Record<string, string> = {};
  for (const [key] of contextFields) {
    initialContextValues[key] = seedContext[key] !== undefined ? String(seedContext[key]) : '';
  }

  const [boundsValues, setBoundsValues] = useState<Record<string, string>>(initialBoundsValues);
  const [contextValues, setContextValues] = useState<Record<string, string>>(initialContextValues);
  // Display names from scope discovery (e.g. calendar IDs → calendar names).
  // Values stay the enforced truth; labels are UI sugar stored locally.
  const [contextLabels, setContextLabels] = useState<Record<string, Record<string, string>>>({});

  // Bug (real-gateway e2e, 2026-10-15): GateWizardPage fetches `profile` and
  // the team `profileConfig` independently — `profile` routinely resolves
  // first, mounting this editor (and running the `initialBoundsValues` seed
  // above) while `profileConfig` is still null. The result: a hard-capped
  // numeric field seeded '' instead of its cap, and a hard-capped enum field
  // kept its UNCAPPED default selected inside a now-disabled control — both
  // sign as a value the team cap refuses (422 cap_exceeded). Root fix: when
  // `profileConfig` later arrives (or changes), re-apply `seedBoundValue` for
  // every field the person has not yet touched — `touchedBoundsKeys` is the
  // one place "touched" is recorded (handleBoundsChange below), so a value
  // the person already typed is never clobbered. Runs on every
  // `profileConfig` change (including the very first, redundantly re-seeding
  // with the same value `initialBoundsValues` already used) — idempotent,
  // so that redundancy costs nothing.
  const touchedBoundsKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    setBoundsValues(prev => {
      let changed = false;
      const next = { ...prev };
      for (const [key, fieldDef] of boundsFields) {
        if (touchedBoundsKeysRef.current.has(key)) continue;
        // A field that only became visible once profileConfig arrived (a
        // team-capped, otherwise-hidden gatekeeper field — see
        // isTeamCappedLocalField above) has no prior entry at all; seed it
        // from scratch exactly like the initial computation does.
        const raw = prev[key] !== undefined ? prev[key] : seedForBound(fieldDef, seedBounds[key]);
        const seeded = seedBoundValue(key, fieldDef, raw, profileConfig);
        if (next[key] !== seeded) { next[key] = seeded; changed = true; }
      }
      return changed ? next : prev;
    });
    // Deliberately only `profileConfig` — `boundsFields`/`seedBounds` are
    // re-derived from `profile`/`initialBounds`/`initialFrame` props that
    // never change after this editor mounts for one ceremony.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileConfig]);

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

  // TR5 — per-field cap state, reactive to the current bound values.
  const capStates: Record<string, FieldCapState | null> = {};
  for (const [key, fieldDef] of boundsFields) {
    capStates[key] = fieldCapState(key, fieldDef, boundsValues[key] ?? '', profileConfig);
  }
  /** Any field still violating a HARD cap — should be rare (the inputs
   *  themselves already clamp to a hard cap), but a seed/prefill path this
   *  component doesn't control for (e.g. a caller passing initialBounds
   *  directly into state some other way) could still land one here. */
  const hardViolatingKeys = Object.entries(capStates)
    .filter(([, s]) => s?.kind === 'hard' && s.violating)
    .map(([key]) => key);

  /** Approvers configured, but no caps at all on this profile — informational
   *  only (nothing gates), shown once above the fields. */
  const approversDormant =
    !!profileConfig &&
    (profileConfig.approvers?.length ?? 0) > 0 &&
    boundsFields.every(([key]) => !isCapped(profileConfig, key));

  const handleBoundsChange = (key: string, value: string) => {
    // Recorded BEFORE the state update so the late-config re-seed effect
    // above never clobbers a value the person is actively editing.
    touchedBoundsKeysRef.current.add(key);
    setBoundsValues(prev => ({ ...prev, [key]: value }));
  };

  const handleContextChange = (key: string, value: string) => {
    setContextValues(prev => ({ ...prev, [key]: value }));
  };

  const buildBoundsAndContext = (): [AgentBoundsParams, AgentScopeParams] => {
    const bounds: AgentBoundsParams = { profile: profile.id };
    for (const [key, fieldDef] of boundsFields) {
      if (fieldDef.type === 'number') {
        bounds[key] = numericBoundValue(fieldDef, boundsValues[key]);
      } else {
        bounds[key] = boundsValues[key];
      }
    }
    const context: AgentScopeParams = {};
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
    onConfirm(bounds, context, contextLabels);
  };

  /** Clamp every still-HARD-violating bound down to its cap value, then proceed. */
  const handleSaveBelowCap = () => {
    const clamped = { ...boundsValues };
    for (const key of hardViolatingKeys) {
      const cap = capStates[key]?.cap;
      if (cap !== undefined) clamped[key] = String(cap);
    }
    setBoundsValues(clamped);
    // Build bounds from clamped values inline (state update is async)
    const bounds: AgentBoundsParams = { profile: profile.id };
    for (const [key, fieldDef] of boundsFields) {
      if (fieldDef.type === 'number') {
        bounds[key] = numericBoundValue(fieldDef, clamped[key] ?? '');
      } else {
        bounds[key] = clamped[key] ?? '';
      }
    }
    const context: AgentScopeParams = {};
    for (const [key, fieldDef] of contextFields) {
      if (fieldDef.type === 'number') {
        context[key] = contextValues[key] === '' ? 0 : Number(contextValues[key]);
      } else {
        context[key] = contextValues[key];
      }
    }
    onConfirm(bounds, context, contextLabels);
  };

  // ─── "Approvers set, no caps" informational box (no per-field note applies) ──

  const renderApproversDormantNote = () => {
    if (!approversDormant) return null;
    const names = approverListLabel(profileConfig, approverNames);
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
          action under this mandate. Your intent will still be encrypted
          and shared with them as an accountability record &mdash; they can
          read what you authorised, even though they aren&apos;t reviewing
          individual actions.
        </div>
      </div>
    );
  };

  /** A still-HARD-violating field (see hardViolatingKeys's doc comment) —
   *  defensive fallback; the per-field inputs already clamp to a hard cap,
   *  so this should rarely render. */
  const renderHardViolationFallback = () => {
    if (hardViolatingKeys.length === 0) return null;
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
          Lower the bound(s) above, or ask {admin} to add an approver path above the cap.
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleSaveBelowCap}>
            Save below cap
          </button>
          {onCancel && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  };

  // Whether the primary Continue button should be disabled.
  const continueBlocked = hardViolatingKeys.length > 0;

  return (
    <div>
      {contextFields.length > 0 && (
        <div className="context-section">
          <div className="bounds-section-header">
            <span className="bounds-section-icon">&#x1F6E1;</span>
            <div>
              <div className="bounds-section-title">Allowed scope</div>
              <div className="bounds-section-subtitle">Encrypted on your device, never sent to the Authority Server</div>
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
                onLabels={(fieldKey, labels) => setContextLabels(prev => ({ ...prev, [fieldKey]: labels }))}
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
              <div className="bounds-section-subtitle">Enforced by the Authority Server</div>
            </div>
          </div>
          <div className="bounds-fields-grid">
            {boundsFields.map(([key, fieldDef]) => {
              const capState = capStates[key];
              return (
                <div key={`bounds-${key}`} style={{ display: 'contents' }}>
                  <FieldRow
                    fieldKey={key}
                    fieldDef={fieldDef}
                    value={boundsValues[key]}
                    onChange={handleBoundsChange}
                    prefix="bounds"
                    readOnly={readOnly}
                    twoColumn
                    capMax={capState?.kind === 'hard' && typeof capState.cap === 'number' ? capState.cap : undefined}
                    enumAllowedFrom={capState?.kind === 'hard' ? enumAllowedFromIndex(fieldDef, capState.cap) : undefined}
                  />
                  {/* TR5 — one note per capped field, directly under its input. */}
                  {capState && (
                    <div style={{ gridColumn: '2 / 3', display: 'flex', alignItems: 'center', paddingBottom: '0.5rem' }}>
                      {renderFieldCapNote(key, fieldDef, capState, profileConfig, approverNames)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {renderApproversDormantNote()}
          {renderHardViolationFallback()}

          {/* Locally-enforced limits are not shown as controls here (this
              section is Authority-Server-enforced), but the user must still
              know they exist and where to change them — otherwise the limit
              just disappears from the product. */}
          {localBoundNames.length > 0 && (
            <div className="bounds-local-note" style={{ marginTop: '0.75rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              {localBoundNames.join(', ')}{' '}
              {localBoundNames.length === 1 ? 'is' : 'are'} set on the integration, not here — reads are
              checked on this device, so the limit applies immediately and can be changed any time under{' '}
              <Link to="/integrations">Integrations</Link>.
            </div>
          )}
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
