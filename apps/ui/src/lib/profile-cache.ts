/**
 * Per-page-load profile fetch, shared by every surface that renders a
 * profile-driven label (approval card, receipt card, proposal args). One
 * cache keyed by whatever the caller holds — a full profile id or a short
 * name ("sales" → its newest version) — so the same profile is fetched once
 * however many cards reference it.
 */
import { useEffect, useState } from 'react';
import type { AgentProfile } from '@hap/core';
import { spClient } from './sp-client';

const profileCache = new Map<string, Promise<AgentProfile | null>>();

export function loadProfile(ref: string): Promise<AgentProfile | null> {
  let p = profileCache.get(ref);
  if (!p) {
    p = (async () => {
      try {
        let id = ref;
        if (!ref.includes('@')) {
          const all = await spClient.listProfiles();
          const short = (x: string) => x.replace(/@.*$/, '').split('/').pop();
          const matches = all.filter(x => short(x.id) === ref)
            .sort((a, b) => (b.id.split('@')[1] ?? '').localeCompare(a.id.split('@')[1] ?? '', undefined, { numeric: true }));
          if (!matches[0]) return null;
          id = matches[0].id;
        }
        return (await spClient.getProfile(id)) as AgentProfile;
      } catch {
        return null;
      }
    })();
    profileCache.set(ref, p);
  }
  return p;
}

/** The profile, or null while loading / when it cannot be fetched (old grant,
 *  unknown id). Callers fall back to the plain field name in that case —
 *  never guess a field's meaning from its name. */
export function useProfile(ref: string | undefined): AgentProfile | null {
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  useEffect(() => {
    let live = true;
    if (ref) void loadProfile(ref).then(p => { if (live) setProfile(p); });
    return () => { live = false; };
  }, [ref]);
  return profile;
}
