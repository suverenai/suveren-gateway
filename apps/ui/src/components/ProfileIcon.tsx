import type { AreaIconName } from '../lib/area';
import { AreaIcon } from './AreaIcon';

/**
 * A profile's icon on cards, rails and pickers — the same area icon every
 * other surface shows (UI spec §13.1), so there is one set to learn.
 */
export function ProfileIcon({ icon, className }: { icon: AreaIconName; className?: string }) {
  return <AreaIcon icon={icon} className={className} />;
}
