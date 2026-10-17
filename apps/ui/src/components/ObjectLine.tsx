import type { ReactNode } from 'react';
import { AreaIcon } from './AreaIcon';
import { areaIcon, showMandateLine } from '../lib/area';

interface Props {
  profileId: string;
  /** The area's own name — lib/area.ts `resolveAreaName` (UI spec §13.1):
   *  the profile's `name`, from the newest version of that profile family
   *  the gateway knows. Never the mandate's title (§13.2 — that is the
   *  separate quiet line below, via `mandateTitle`). */
  area: string;
  /** The connector's display name; rendered "via <system>" (§13.2). Omitted
   *  when not known. */
  system?: string;
  /** "waiting 5 min", "09:12", "since 2 Oct" … */
  time?: string;
  /** Right-aligned extra, e.g. a seen/new dot. */
  trailing?: ReactNode;
  leading?: ReactNode;
}

/**
 * The one top line every core object carries (UI spec §12.2, §13.2):
 * area icon + **area** · via system · time. It is the categorisation —
 * it replaces the profile rail on approvals, mandates and tickets.
 */
export function ObjectLine({ profileId, area, system, time, trailing, leading }: Props) {
  return (
    <div className="obj-line">
      {leading}
      <AreaIcon icon={areaIcon(profileId)} />
      <b>{area}</b>
      {system && <span>· via {system}</span>}
      {time && <span>· {time}</span>}
      {trailing && <><span className="obj-line-sp" />{trailing}</>}
    </div>
  );
}

/**
 * The quiet "Mandate: <title>" line (UI spec §13.2), placed by the caller
 * UNDER the object's headline — on approvals, tickets, blocks and dashboard
 * items, so a person sees which mandate it ran under. Renders nothing when
 * there is no title or the title only repeats the area's name.
 */
export function MandateLine({ title, area }: { title?: string | null; area: string }) {
  if (!showMandateLine(title, area)) return null;
  return <div className="obj-mandate-line" data-testid="mandate-line">Mandate: {title}</div>;
}
