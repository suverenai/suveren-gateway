/**
 * What the person approved on the gateway page, remembered here so that the one thing that raises Touch ID on their behalf, creating a
 * mandate for an AI's proposal (`/internal/mandate`, called with only the internal secret), runs only for exactly that
 * (device-keys plan 4.4; step 13, review F2).
 *
 * When this control plane signs a COMMIT decision for a proposal of the Setup tools (`setup__create_mandate`, `setup__change_mandate`)
 * it keeps what it opened and fingerprinted for that decision: the tool, the content hash the person's device signed over, and the
 * plaintext arguments. `/internal/mandate` then takes no request content from its caller for a chain account: the caller names the
 * hash, this store gives back the arguments the person approved, and the ceremony is built from THOSE. A hash nobody approved, one
 * already used, or one past its time finds nothing: no ceremony, no touch. A handle is used once; it is held while a ceremony runs
 * (a second call finds it busy) and spent when the ceremony succeeds, so a touch that was cancelled can be tried again within the time.
 *
 * Memory only: after a restart the person approves again (an approval is a click). No secret is stored, only what the card showed.
 */

export type ApprovedTool = 'setup__create_mandate' | 'setup__change_mandate';
export const APPROVED_TOOLS: readonly ApprovedTool[] = ['setup__create_mandate', 'setup__change_mandate'];

interface Approval { tool: ApprovedTool; args: Record<string, unknown>; until: number; busy: boolean }

const TTL_SECONDS = 7 * 24 * 3600;
const MAX = 200;

export class MandateApprovals {
  private readonly byHash = new Map<string, Approval>();
  constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  /** The person's commit decision for this proposal was accepted: remember the approved arguments under their fingerprint. */
  record(tool: string, contentHash: string, args: Record<string, unknown>): void {
    if (!(APPROVED_TOOLS as readonly string[]).includes(tool) || !/^sha256:[0-9a-f]{64}$/.test(contentHash)) return;
    for (const [h, a] of this.byHash) if (a.until <= this.now()) this.byHash.delete(h);
    if (this.byHash.size >= MAX) { const first = this.byHash.keys().next().value; if (first) this.byHash.delete(first); }
    this.byHash.set(`${tool}:${contentHash}`, { tool: tool as ApprovedTool, args: structuredClone(args), until: this.now() + TTL_SECONDS, busy: false });
  }

  /** Take the approval for this tool and fingerprint, or null. While taken it is busy: a second take finds nothing until it is released or spent. */
  take(tool: string, contentHash: unknown): { args: Record<string, unknown>; done: () => void; release: () => void } | null {
    if (typeof contentHash !== 'string') return null;
    const key = `${tool}:${contentHash}`;
    const a = this.byHash.get(key);
    if (!a || a.busy || a.until <= this.now()) return null;
    a.busy = true;
    return { args: structuredClone(a.args), done: () => { this.byHash.delete(key); }, release: () => { a.busy = false; } };
  }
}
