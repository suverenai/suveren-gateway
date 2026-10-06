import { ProfileIcon } from './ProfileIcon';
import { profileIdentity } from '../lib/profile-identity';

interface Props {
  profileId: string;
  /** Values the profile itself declares, when the caller has them on hand. */
  declared?: { name?: string; icon?: string };
}

/**
 * The left-hand identity column of an `.id-card` (mandate, ticket, or
 * action/approval card): icon + profile name, then the separator. Renders as
 * a sibling pair so the caller can place it directly inside a `.card
 * id-card` wrapper, followed by a `.id-body` holding everything else.
 *
 * Callers that also need the `testSetup` flag (to show the amber marker)
 * call `profileIdentity` themselves — this component only renders the rail.
 */
export function ProfileRail({ profileId, declared }: Props) {
  const { icon, name } = profileIdentity(profileId, declared);
  return (
    <>
      <div className="id-rail">
        <ProfileIcon icon={icon} className="id-rail-icon" />
        <span className="id-rail-name">{name}</span>
      </div>
      <div className="id-sep" />
    </>
  );
}
