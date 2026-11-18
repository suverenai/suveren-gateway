import { profileDisplayName } from '@suveren/approval-card/lib/profile-display';

interface Props {
  profileId: string;
}

export function ProfileBadge({ profileId }: Props) {
  return <span className="profile-badge">{profileDisplayName(profileId)}</span>;
}
