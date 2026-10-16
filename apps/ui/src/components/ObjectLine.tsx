import type { ReactNode } from 'react';
import { ProfileIcon } from './ProfileIcon';
import { profileIdentity } from '../lib/profile-identity';

interface Props {
  profileId: string;
  /** The mandate's title or the profile's name (lib/core-objects.ts areaName). */
  area: string;
  /** The connector's display name; omitted when not known. */
  system?: string;
  /** "waiting 5 min", "09:12", "since 2 Oct" … */
  time?: string;
  /** Right-aligned extra, e.g. a seen/new dot. */
  trailing?: ReactNode;
  leading?: ReactNode;
}

/**
 * The one top line every core object carries (UI spec §12.2):
 * profile icon + **area** · system · time. It is the categorisation —
 * it replaces the profile rail on approvals, mandates and tickets.
 */
export function ObjectLine({ profileId, area, system, time, trailing, leading }: Props) {
  const { icon } = profileIdentity(profileId);
  return (
    <div className="obj-line">
      {leading}
      <ProfileIcon icon={icon} />
      <b>{area}</b>
      {system && <span>· {system}</span>}
      {time && <span>· {time}</span>}
      {trailing && <><span className="obj-line-sp" />{trailing}</>}
    </div>
  );
}
