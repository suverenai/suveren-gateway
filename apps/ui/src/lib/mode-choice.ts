/**
 * The "Where does <connector> get its data?" choice on a connector card.
 *
 * Everything is derived from the connector's manifest — `simulation` (the mode
 * field + its default), `modeLabels` (which modes/adapters exist), `modeOptions`
 * (option label / explanation / the fields only that option needs) and
 * `adapterField` — never from a connector id or a field name. A new real option
 * (e.g. an external CRM) is a manifest entry plus an adapter; this file does not
 * change.
 *
 * The person picks an option; the values Save writes come from the manifest's
 * keys, not from anything typed.
 */
import type { IntegrationManifest } from './sp-client';

type Fields = Record<string, string | undefined>;
type CredField = IntegrationManifest['credentials']['fields'][number];

export interface ModeOption {
  /** Stable id for the radio: "<mode>" or "<mode>:<adapter>". */
  key: string;
  /** Value written to the `simulation.field`. */
  mode: string;
  /** Value written to the `adapterField` (real options with an adapter only). */
  adapter?: string;
  label: string;
  explanation: string;
  /** The practice-data option — runs only while gateway-wide simulation mode is on. */
  simulated: boolean;
  /** Credential keys needed only by this option (shown + required only while chosen). */
  fieldKeys: string[];
}

const norm = (v: string | undefined) => (v ?? '').trim().toLowerCase();

/** The options the manifest offers, in manifest order. Empty when it declares no mode choice. */
export function modeOptions(
  manifest: Pick<IntegrationManifest, 'name' | 'simulation' | 'modeLabels' | 'modeOptions' | 'adapterField'>,
): ModeOption[] {
  if (!manifest.simulation || !manifest.modeLabels) return [];
  const out: ModeOption[] = [];
  for (const [mode, entry] of Object.entries(manifest.modeLabels)) {
    const simulated = mode === 'simulation';
    const declFor = (adapter?: string) => {
      const d = manifest.modeOptions?.[mode];
      if (!d) return undefined;
      return (adapter === undefined ? d : (d as Record<string, unknown>)[adapter]) as
        { label?: string; explanation?: string; fields?: string[] } | undefined;
    };
    const make = (adapter: string | undefined, defaultLabel: string): ModeOption => {
      const d = declFor(adapter);
      return {
        key: adapter === undefined ? mode : `${mode}:${adapter}`,
        mode,
        ...(adapter !== undefined ? { adapter } : {}),
        label: d?.label ?? defaultLabel,
        explanation: d?.explanation ?? (simulated
          ? 'Practice data. Runs only while simulation mode is on.'
          : `Your own ${manifest.name} data. Runs in production.`),
        simulated,
        fieldKeys: d?.fields ?? [],
      };
    };
    if (typeof entry === 'string') out.push(make(undefined, entry));
    else for (const [adapter, label] of Object.entries(entry)) out.push(make(adapter, label));
  }
  return out;
}

/**
 * Which option the saved values stand for. Mode unset → the manifest's default.
 * Old hand-typed values ("live" + "local", any case / spaces) are recognised the
 * same way. A mode that needs an adapter but has none/an unknown one matches
 * nothing (undefined) — the person must choose.
 */
export function currentOption(
  manifest: Pick<IntegrationManifest, 'name' | 'simulation' | 'modeLabels' | 'modeOptions' | 'adapterField'>,
  fields?: Fields,
): ModeOption | undefined {
  const decl = manifest.simulation;
  if (!decl) return undefined;
  const mode = norm(fields?.[decl.field]) || norm(decl.default);
  const adapter = manifest.adapterField ? norm(fields?.[manifest.adapterField]) : '';
  return modeOptions(manifest).find(o => o.mode.toLowerCase() === mode
    && (o.adapter === undefined || o.adapter.toLowerCase() === adapter));
}

/** What choosing an option writes: the mode, and the adapter for a real option. */
export function optionValues(
  manifest: Pick<IntegrationManifest, 'simulation' | 'adapterField'>,
  option: ModeOption,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (manifest.simulation) out[manifest.simulation.field] = option.mode;
  if (option.adapter !== undefined && manifest.adapterField) out[manifest.adapterField] = option.adapter;
  return out;
}

/** The credential keys the choice itself sets — never shown as text inputs. */
export function choiceFieldKeys(manifest: Pick<IntegrationManifest, 'simulation' | 'adapterField'>): string[] {
  return [manifest.simulation?.field, manifest.adapterField].filter((k): k is string => !!k);
}

/**
 * Split the manifest's fields for the panel. With a mode choice: the choice's own
 * fields vanish, the chosen option's fields show (`required`), every other
 * optional field folds into `advanced`, and fields belonging to an option that is
 * NOT chosen are `hidden` (and must not be written). A required field no option
 * owns stays in `main`. Without a choice (no options) everything stays in `main`.
 */
export function splitFields(
  manifest: Pick<IntegrationManifest, 'name' | 'simulation' | 'modeLabels' | 'modeOptions' | 'adapterField'> & {
    credentials: { fields: CredField[] };
  },
  chosen: ModeOption | undefined,
): { main: CredField[]; optionFields: CredField[]; advanced: CredField[]; hidden: CredField[] } {
  const options = modeOptions(manifest);
  const all = manifest.credentials.fields;
  if (options.length === 0) return { main: all, optionFields: [], advanced: [], hidden: [] };
  const choiceKeys = new Set(choiceFieldKeys(manifest));
  const owned = new Set(options.flatMap(o => o.fieldKeys));
  const main: CredField[] = [], optionFields: CredField[] = [], advanced: CredField[] = [], hidden: CredField[] = [];
  for (const f of all) {
    if (choiceKeys.has(f.key)) continue;
    if (owned.has(f.key)) (chosen?.fieldKeys.includes(f.key) ? optionFields : hidden).push(f);
    else if (f.optional) advanced.push(f);
    else main.push(f);
  }
  return { main, optionFields, advanced, hidden };
}

/** The option the card must say it cannot run right now, and why — the mirror pair. */
export function pausedTag(option: ModeOption, gatewaySimulation: boolean): string | null {
  if (option.simulated && !gatewaySimulation) return 'Paused in production';
  if (!option.simulated && gatewaySimulation) return 'Paused in simulation';
  return null;
}

/** Only one option, and it is the practice one: there is no real mode to choose. */
export function hasNoRealMode(options: ModeOption[]): boolean {
  return options.length === 1 && options[0].simulated;
}
export const NO_REAL_MODE_LINE = 'This connector has no real mode. Disable it to use a real one.';
