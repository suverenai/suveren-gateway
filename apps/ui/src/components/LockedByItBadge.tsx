/**
 * "Set by your IT" badge for a Settings value locked by IT policy (Windows
 * registry / policy file — see docs/managed-settings.md). Purely visual;
 * callers decide WHETHER to render it (see lib/policy-lock.ts's
 * `isPolicyLocked`) — this component never reads policy state itself.
 */
export function LockedByItBadge({ title }: { title?: string }) {
  return (
    <span className="it-locked-badge" title={title}>
      <span className="lock-icon" aria-hidden="true">&#128274;</span> Set by your IT
    </span>
  );
}
