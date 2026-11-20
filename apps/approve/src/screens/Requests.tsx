import { ApprovalCard, type DecideArgs } from '@suveren/approval-card/components/ApprovalCard';
import type { DecisionResult } from '@suveren/approval-card/lib/approval-flow';
import { ApprovalRow } from '@suveren/approval-card/components/ApprovalRow';
import type { Proposal } from '@suveren/approval-card/types';
import { P, blockedText } from '../texts';
import type { CardCheck } from '../lib/card-checks';
import { Notice } from './Frame';

const NO_MANIFESTS: never[] = [];
const NO_TITLES: Record<string, string> = {};

export interface RequestsScreenProps {
  /** Null while the first read is out. */
  proposals: Proposal[] | null;
  error?: string;
  nowMs: number;
  onOpen: (id: string) => void;
  onRefresh: () => void;
  /** The offer to turn notifications on (stage D4): shown once a phone is in the account, until on or "not now". */
  pushOffer?: { busy?: boolean; error?: string; onOn: () => void; onNotNow: () => void };
  /** Waiting requests that came without a notice (plan 8); 0 or absent shows nothing. */
  missed?: number;
}

export function RequestsScreen(p: RequestsScreenProps) {
  return (
    <div className="device-screen">
      <h1>{P.listTitle}</h1>
      <p>{P.welcomeReadOnly}</p>
      {p.error && <Notice kind="error">{p.error}</Notice>}
      {p.proposals === null && !p.error && <Notice kind="info">{P.listLoading}</Notice>}
      {p.pushOffer && (
        <div data-testid="push-offer">
          <Notice kind="info"><strong>{P.pushOfferTitle}</strong> {P.pushOfferBody}</Notice>
          {p.pushOffer.error && <Notice kind="error">{p.pushOffer.error}</Notice>}
          <button type="button" className="btn btn-primary btn-full" onClick={p.pushOffer.onOn} disabled={p.pushOffer.busy}>{P.pushTurnOn}</button>
          <button type="button" className="btn btn-ghost btn-full" onClick={p.pushOffer.onNotNow} disabled={p.pushOffer.busy}>{P.pushNotNow}</button>
        </div>
      )}
      {p.proposals !== null && p.proposals.length === 0 && !p.error && <p data-testid="list-empty">{P.listEmpty}</p>}
      {!!p.missed && <p className="form-hint" data-testid="push-missed">{P.pushMissed(p.missed)}</p>}
      <div className="dash-rows" data-testid="request-list">
        {(p.proposals ?? []).map((pr) => (
          <ApprovalRow key={pr.id} proposal={pr} manifests={NO_MANIFESTS} titles={NO_TITLES} onOpen={() => p.onOpen(pr.id)} />
        ))}
      </div>
      <button type="button" className="btn btn-secondary btn-full" onClick={p.onRefresh}>{P.listRefresh}</button>
    </div>
  );
}

export interface RequestDetailProps {
  proposal: Proposal;
  userId: string;
  /** Null while the checks run. */
  check: CardCheck | null;
  /** Sends the decision (the phone's decider). Rejects with a message the person can read; resolves only after the server answered. */
  decide: (args: DecideArgs) => Promise<DecisionResult>;
  onBack: () => void;
  /** The check ran again after a decision went through or failed: the list should be read again. */
  onDecided?: () => void;
}

/**
 * The shared approval card with its buttons (stage D2). The buttons exist only when every check before a decision passed
 * (card-checks.ts); otherwise the card is drawn without them and says why, in words, above the card: `alreadyDecided` is the card's own
 * way to hide them. "Ask for changes" is left out: the phone has no key of anyone else's to seal the note for.
 */
export function RequestDetail({ proposal, userId, check, decide, onBack, onDecided }: RequestDetailProps) {
  const blocked = check !== null && !check.ok;
  // What the card draws is what this phone checked: the arguments only from the sealed content (the shared card never shows the server's plain
  // `toolArgs` beside sealed content, and here it is dropped as well), and the execution context only as REBUILT from them.
  const shown: Proposal = check && check.ok
    ? { ...proposal, toolArgs: undefined, executionContext: check.ready.executionContext }
    : { ...proposal, toolArgs: undefined, executionContext: {} };
  const refuse = async (): Promise<never> => { throw new Error(P.cardBlockedNothing); };
  return (
    <div className="device-screen">
      <button type="button" className="av3-back" onClick={onBack}>{P.listBack}</button>
      <ApprovalCard
        proposal={shown}
        currentUserId={userId}
        // Until the checks are done, and when one failed, no buttons.
        alreadyDecided={check === null || blocked}
        canAskChanges={false}
        toolDisplay={check && check.ok ? check.ready.display : undefined}
        decide={check && check.ok ? decide : refuse}
        onDecided={() => onDecided?.()}
        topExtras={(
          <>
            {check === null && <Notice kind="info">{P.cardChecking}</Notice>}
            {check !== null && !check.ok && (
              <div data-testid="card-blocked">
                <Notice kind="error">
                  <strong>{P.cardBlockedTitle}</strong>
                  <br />
                  {blockedText(check.reason)}
                </Notice>
              </div>
            )}
            {check !== null && check.ok && <p className="av3-quiet" data-testid="changes-elsewhere">{P.decideChangesElsewhere}</p>}
          </>
        )}
      />
    </div>
  );
}
