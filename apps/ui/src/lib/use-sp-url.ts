import { useEffect, useState } from 'react';

/** The Authority Server's address as the gateway reports it (`/health` → `spUrl`); '' until known or when unreadable. */
export function useSpUrl(): string {
  const [spUrl, setSpUrl] = useState('');
  useEffect(() => {
    let live = true;
    fetch('/health').then(r => r.json()).then((d: { spUrl?: unknown }) => { if (live && typeof d.spUrl === 'string') setSpUrl(d.spUrl); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return spUrl;
}

/** Where a team admin enables an area and names who may give its mandates: the team's area settings on the Authority Server. */
export function teamSettingsHref(spUrl: string, groupId: string | null | undefined): string | undefined {
  if (!spUrl || !groupId) return undefined;
  return `${spUrl.replace(/\/$/, '')}/dashboard/groups/${encodeURIComponent(groupId)}?tab=profiles`;
}

/** DRAFT: the link text next to an admin's "not enabled" line. */
export const ENABLE_IN_TEAM_SETTINGS = 'Open the team settings';
