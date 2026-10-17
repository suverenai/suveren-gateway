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
  /** The mandate this object ran under, for the quiet "Mandate: <title>"
   *  line underneath (§13.2) — approvals, tickets and blocks pass this;
   *  omit on the mandate object itself. Hidden automatically when absent or
   *  when it only repeats `area`. */
  mandateTitle?: string | null;
}

/**
 * The one top line every core object carries (UI spec §12.2, §13.2):
 * area icon + **area** · via system · time. It is the categorisation —
 * it replaces the profile rail on approvals, mandates and tickets.
 */
export function ObjectLine({ profileId, area, system, time, trailing, leading, mandateTitle }: Props) {
  return (
    <>
      <div className="obj-line">
        {leading}
        <AreaIcon icon={areaIcon(profileId)} />
        <b>{area}</b>
        {system && <span>· via {system}</span>}
        {time && <span>· {time}</span>}
        {trailing && <><span className="obj-line-sp" />{trailing}</>}
      </div>
      {showMandateLine(mandateTitle, area) && (
        <div className="obj-mandate-line">Mandate: {mandateTitle}</div>
      )}
    </>
  );
}
