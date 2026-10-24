/**
 * "Set by your IT" badge for a Settings value locked by IT policy (Windows
 * registry / policy file — see docs/managed-settings.md). Purely visual;
 * callers decide WHETHER to render it (see lib/policy-lock.ts's
 * `isPolicyLocked`) — this component never reads policy state itself.
 */
import { ObLock } from './ObjectCard';

export function LockedByItBadge({ title }: { title?: string }) {
  return (
    <span className="it-locked-badge" title={title}>
      <ObLock /> Set by your IT
    </span>
  );
}
