/**
 * The mandate proposal card, ONE component for every device (maintainer 2026-11-26, "one UI for all devices"): the gateway's approval
 * card (ApprovalBody) and the phone's give (apps/approve GiveBody) both draw their mandate from here, so the facts, their order and
 * their words are the same. A host passes the facts and the few pieces only it has (the folded rows, a note above the title); it
 * writes no markup of its own for the mandate. A test in apps/approve fails if the phone draws its own (give-card-drift.test.ts).
 *
 * Order, top to bottom: type line (MANDATE, the commitment badge, area, age) · title · summary line · [host: "prepared on"] ·
 * the "You sign this" tile (Intent, Commitment, Valid, Limits, Scope, Applies to, Title) · folded rows · [the commitment band sits
 * above the buttons, drawn by the host's footer with <CommitmentBand/>]. The body is a flex column; pieces carry `order` so a host can
 * put its own lines between them (the gateway's check lines, over-limit block).
 */
import type { ReactNode } from 'react';
import { modeView } from '../lib/mandate-proposal';
import type { MandateFact } from '../lib/mandate-facts';

// ─── Commitment: badge and band (D1 + D3) ─────────────────────────────────────

const SHIELD = (
  <svg className="mi" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4.5 3 8 7.5 9.5 4.5-1.5 7.5-5 7.5-9.5V6z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></svg>
);
const BOLT = (
  <svg className="mi" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4.5 13.5H12L11 22l8.5-11.5H12z" /></svg>
);

/** Automatic is the one mode that acts alone: it takes the amber of the AI's own words. Every other mode reads as a review. */
const toneOf = (mode: string | null | undefined): 'automatic' | 'review' => (mode?.trim() === 'automatic' ? 'automatic' : 'review');

/** The mode as a badge with its icon: in the card's top line, and at the start of a mandate's list card. Nothing for no mode. */
export function ModeBadge({ mode }: { mode: string | null | undefined }) {
  const v = modeView(mode);
  if (!v) return null;
  const tone = toneOf(mode);
  return <span className={`mode-pill mode-${tone}`} data-testid="mode-badge" data-mode={mode?.trim()}>{tone === 'automatic' ? BOLT : SHIELD}{v.title}</span>;
}

/** The commitment as one compact line directly above the give button: icon, then the mode. What the mode means stays in the Commitment row. */
export function CommitmentBand({ mode }: { mode: string | null | undefined }) {
  const v = modeView(mode);
  if (!v) return null;
  const tone = toneOf(mode);
  return (
    <div className={`mode-band mode-${tone}`} data-testid="commitment-band" data-mode={mode?.trim()}>
      {tone === 'automatic' ? BOLT : SHIELD}
      <div className="mode-t"><span className="mode-l">{v.label} · </span>{v.title}</div>
    </div>
  );
}

// ─── Folded rows ──────────────────────────────────────────────────────────────

export function Chev() {
  return <svg className="i chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>;
}

/** One folded row: a heading, one line that says what is inside, a chevron. */
export function MandateFold({ heading, one, order, testid, children }: { heading: string; one: ReactNode; order: number; testid?: string; children: ReactNode }) {
  return (
    <details className="av3-fold" style={{ order }} data-testid={testid}>
      <summary><span className="h">{heading}</span><span className="one">{one}</span><Chev /></summary>
      <div className="av3-fold-body">{children}</div>
    </details>
  );
}

/** What "Technical details" holds for a mandate: the proposal and the profile version, then what the marks mean. */
export function MandateTechnicalBody({ proposal, version, legendNote }: { proposal?: string; version?: string; legendNote?: ReactNode }) {
  return (
    <>
      {(proposal || version) && (
        <dl className="av3-usage">
          {proposal && <><dt>Proposal</dt><dd>{proposal}</dd></>}
          {version && <><dt>Version</dt><dd>{version}</dd></>}
        </dl>
      )}
      <p className="creation-legend" data-testid="au10-legend">
        <span><i className="creation-legend-dot creation-legend-dot-sealed" />sealed — approved and executed exactly so</span>
        <span><i className="creation-legend-dot creation-legend-dot-system" />from the system — read by the gateway, not by the AI</span>
        <span><i className="creation-legend-dot au10-dot-ai" />the AI's own claim or text — not checked</span>
        {legendNote}
      </p>
    </>
  );
}

/** The label over the intent of a proposal an AI wrote. */
export const INTENT_BY_AI = 'Intent — written by the AI, becomes your words when you sign';

// ─── The card ─────────────────────────────────────────────────────────────────

export interface MandateCardModel {
  /** The area's name ("Customers") and its icon. */
  area: string;
  areaIcon?: ReactNode;
  /** "2 min": how long ago it was proposed. */
  age: string;
  testSetup?: boolean;
  /** `review` / `automatic` / `review_above_cap`, as the mandate carries it. */
  mode: string | null | undefined;
  /** The proposed name of the mandate; "new mandate" is said when there is none. */
  name: string | null;
  /** The one-line summary under the title ('' = none). */
  summary: string;
  /** The AI's words, signed as the person's own on signing. */
  intent: string | null;
  /** Over the intent; default says the AI wrote it. A host whose mandate the person wrote says so instead (the phone's own gives). */
  intentLabel?: string;
  /** "30 days (until 26 Dec 2026, 14:20)" ('' = not known). */
  valid: string;
  limits: MandateFact[];
  scope: MandateFact[];
  /** "Applies to" (the workspace) — only when the host knows it. */
  workspace?: string;
  /** "Technical details": the one line, and the rows. */
  technical: { one: string; proposal?: string; version?: string };
}

export interface MandateCardSlots {
  /** Right under the summary line, before the tile (the phone's "Prepared on …"). */
  afterSummary?: ReactNode;
  /** Inside the tile after the intent (the gateway's "Edit before signing"). */
  afterIntent?: ReactNode;
  /** Right after the tile (the phone's approvers above the limit). */
  belowTile?: ReactNode;
  /** The host's own folded rows before Request and History ("Proposed through"). */
  foldsBefore?: ReactNode;
  /** Request and History (RequestContextFolds, or the host's own data). */
  requestAndHistory?: ReactNode;
  /** Added to the legend of "Technical details" (the gateway: "Decrypted on this device …"). */
  legendNote?: ReactNode;
  /** After the last folded row (the phone's "You can do this on any of your devices …"). */
  footnote?: ReactNode;
  /** Replaces the "Technical details" row when the host has none to show (not readable yet). */
  noTechnical?: boolean;
}

function Rows({ facts }: { facts: MandateFact[] }) {
  return (
    <dl className="av3-facts-sub">
      {facts.map((f) => <FactRow key={`${f.kind}:${f.key}`} fact={f} />)}
    </dl>
  );
}

function FactRow({ fact }: { fact: MandateFact }) {
  return (
    <>
      <dt data-testid="fact-label">{fact.label}</dt>
      <dd data-testid="fact-value" data-key={fact.key}>{fact.value}</dd>
    </>
  );
}

/** The lines the facts of a card are compared by (tests, and the drift guard): label and value, in order. */
export function factLines(facts: MandateFact[]): string[] {
  return facts.map((f) => `${f.label}: ${f.value}`);
}

/** The mandate proposal as pieces of the card's flex column; the host's footer carries the buttons and `<CommitmentBand/>`. */
export function MandateProposalBody({ model, slots = {}, titleTestId = 'approval-summary' }: { model: MandateCardModel; slots?: MandateCardSlots; titleTestId?: string }) {
  const hasFacts = model.limits.length > 0 || model.scope.length > 0 || !!model.valid;
  return (
    <>
      <div className="av3-type" style={{ order: 0 }} data-testid="approval-type">
        <span className="av3-mtag">Mandate</span>
        <ModeBadge mode={model.mode} />
        <span className="av3-area">{model.areaIcon}{model.area}</span>
        <span>{model.age}</span>
        {model.testSetup && <span className="sim-mark">Test setup</span>}
      </div>
      <h2 className="av3-title" style={{ order: 1 }} data-testid={titleTestId}>{model.area} · {model.name ?? 'new mandate'}</h2>
      {model.summary && <p className="sum-line" style={{ order: 1 }} data-testid="mandate-summary">{model.summary}</p>}
      {slots.afterSummary}

      <section className="av3-sealed" style={{ order: 6 }} data-testid="sealed-values">
        <h3 className="av3-sealed-h">
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
          You sign this
        </h3>
        {model.intent && (
          <div className="av3-intent" data-testid="mandate-intent-ai">
            <div className="av3-intent-l">{model.intentLabel ?? INTENT_BY_AI}</div>
            <p>{model.intent}</p>
          </div>
        )}
        {slots.afterIntent}
        {modeView(model.mode) && (
          <dl className="av3-mandate-rows" data-testid="mandate-mode"><dt>{modeView(model.mode)!.label}</dt><dd>{modeView(model.mode)!.title}</dd></dl>
        )}
        {hasFacts && (
          <dl className="av3-facts" data-testid="mandate-facts">
            {model.valid && <><dt>Valid</dt><dd data-testid="mandate-valid">{model.valid}</dd></>}
            {model.limits.length > 0 && <><dt>Limits</dt><dd data-testid="mandate-limits"><Rows facts={model.limits} /></dd></>}
            {model.scope.length > 0 && <><dt>Scope</dt><dd data-testid="mandate-scope"><Rows facts={model.scope} /></dd></>}
          </dl>
        )}
        {(model.workspace || model.name) && (
          <dl className="av3-mandate-rows" data-testid="mandate-applies-to">
            {model.workspace && <><dt>Applies to</dt><dd data-testid="mandate-workspace">{model.workspace}</dd></>}
            {model.name && <><dt>Title</dt><dd data-testid="mandate-title">{model.name}</dd></>}
          </dl>
        )}
      </section>

      {slots.belowTile}
      {slots.foldsBefore}
      {slots.requestAndHistory}
      {!slots.noTechnical && (
        <MandateFold heading="Technical details" one={model.technical.one} order={15} testid="technical-details">
          <MandateTechnicalBody proposal={model.technical.proposal} version={model.technical.version} legendNote={slots.legendNote} />
        </MandateFold>
      )}
      {slots.footnote}
    </>
  );
}

