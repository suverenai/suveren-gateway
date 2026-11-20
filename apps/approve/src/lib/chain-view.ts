/**
 * The device list, as plain data, from a chain the phone verified itself (plan 3.3, 4.3 "The admitter's device list is the
 * truth"). Pure: the screens only draw it. Labels are shown as plain text (F16); the phone never trusts a label to decide
 * anything, only to tell the person which device is which.
 */
import { activeDevices, type ChainEntry, type ChainState } from '@hap/core/device-keys';

/** "Added today" stays on a device in the list for 14 days (plan 4.3 rules). Seconds. */
export const RECENT_SECONDS = 14 * 24 * 60 * 60;

export interface DeviceRow {
  keyId: string;
  label: string;
  kind: 'gateway' | 'approve-app';
  /** This phone. */
  thisDevice: boolean;
  /** Holds a check key: it can grant (plan 1, "granting device"). */
  canGrant: boolean;
  /** Epoch seconds the entry that admitted it was made. */
  addedAt: number;
  /** Admitted within the last 14 days and not the genesis device. */
  recent: boolean;
}

/** Active devices at the head, oldest first. */
export function deviceRows(entries: readonly ChainEntry[], state: ChainState, ownKeyId: string, now: number): DeviceRow[] {
  return activeDevices(state)
    .slice()
    .sort((a, b) => a.added_seq - b.added_seq)
    .map((d) => {
      const addedAt = entries[d.added_seq]?.created_at ?? 0;
      return {
        keyId: d.key_id,
        label: d.label,
        kind: d.kind,
        thisDevice: d.key_id === ownKeyId,
        canGrant: d.check !== null,
        addedAt,
        recent: d.added_seq > 0 && now - addedAt < RECENT_SECONDS,
      };
    });
}

/** Where and when the identity was made (plan 20.17, point 2: "when and on which device"). */
export interface Origin {
  /** The first device's label. */
  label: string;
  kind: 'gateway' | 'approve-app';
  /** Epoch seconds. */
  at: number;
}

export function originOf(entries: readonly ChainEntry[]): Origin | null {
  const g = entries[0];
  if (!g || g.op !== 'genesis' || !g.device) return null;
  return { label: g.device.label, kind: g.device.kind, at: g.created_at };
}

/** Another active device already has this label: an admitter refuses a second one in a chain (DEC-47). */
export function labelTaken(state: ChainState, label: string): boolean {
  const norm = label.normalize('NFC').trim().toLowerCase();
  return activeDevices(state).some((d) => d.label.normalize('NFC').trim().toLowerCase() === norm);
}
