/**
 * What the person is told when the old mandate could not be revoked after its
 * replacement was signed. Empty = nothing to tell (the control plane treats
 * "already revoked" as done).
 *
 * Silence here was a real hazard (found 2026-11-10): after a reduction the old,
 * wider mandate stayed live and nobody knew.
 */
export function replacedRevokeProblem(reason: string | undefined): string {
  if (!reason) return '';
  return `Your new mandate is given and active, but the old one could not be ended, so it is still live with its old limits. End it under Mandates. (${reason})`;
}
