/**
 * The result of an approved action the Authority Server then refused (UI spec
 * §3: refused shares the strong outline + cross, no red — red is a failed
 * check only). The sentence is built from the recorded values and the
 * profile (lib/limit-words.ts); the server's message is only ever shown whole.
 * The list row says "Not run"; this card does not.
 */
import { useProfile } from '../lib/profile-cache';
import { refusalSentence, limitWordsForTool } from '../lib/limit-words';
import type { IntegrationManifest, Proposal } from '../lib/sp-client';

function clock(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** The sentence for a refused proposal, with the profile resolved. */
export function useRefusalSentence(proposal: Pick<Proposal, 'profileId' | 'refusal' | 'tool'>, manifests?: IntegrationManifest[]): string | null {
  const profile = useProfile(proposal.profileId);
  return proposal.refusal ? refusalSentence(proposal.refusal, profile, limitWordsForTool(manifests, proposal.tool)).text : null;
}

export function RefusalResult({ proposal, manifests }: { proposal: Pick<Proposal, 'profileId' | 'refusal' | 'tool'>; manifests?: IntegrationManifest[] }) {
  const sentence = useRefusalSentence(proposal, manifests);
  if (!sentence || !proposal.refusal) return null;
  return (
    <div className="refusal-result" role="status" data-testid="refusal">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      <div>
        <div className="refusal-result-w" data-testid="refusal-sentence">{sentence}</div>
        <div className="refusal-result-m">
          Refused by the Authority Server at {clock(proposal.refusal.at)}. No ticket was issued; nothing left your gateway.
        </div>
      </div>
    </div>
  );
}
