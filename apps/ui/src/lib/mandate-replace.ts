/**
 * What the person is told when the old mandate could not be revoked after its
 * replacement was signed. Empty = nothing to tell: the Authority Server's "already
 * revoked" means the old mandate is gone, which is what was wanted.
 *
 * Silence here was a real hazard (found 2026-11-10): after a reduction the old,
 * wider mandate stayed live and nobody knew.
 */
export function replacedRevokeProblem(err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  if (/already revoked/i.test(reason)) return '';
  return `Your new mandate is signed and active, but the old one could not be revoked, so it is still live with its old limits. Revoke it under Mandates. (${reason})`;
}
