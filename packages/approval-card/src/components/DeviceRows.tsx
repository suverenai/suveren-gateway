/**
 * The list of a person's devices, ONE implementation for the gateway page and the phone app (UI review, DEC-88): the Team page's
 * member rows (TileList / TileRow), two lines per device — the name with its tag ("This phone", "This computer", "new"), then the
 * kind and when it was added. A device added in the last 14 days carries its warning on its own row, where it can be removed.
 * Labels are plain text from a chain the device verified itself. Words: lib/pairing-texts.ts (shared, DRAFT).
 */
import { TileList, TileRow } from './TileRows';
import { SP, whenText } from '../lib/pairing-texts';

export interface DeviceRowLike {
  keyId: string; label: string; kind: 'gateway' | 'approve-app'; thisDevice: boolean; addedAt: number; recent: boolean;
  /** Only in the list an admitter shows before it appends: the device being added. */
  adding?: boolean;
}

/** The second line of a device row: "Computer · added 11 Oct 2026". */
export function deviceDetail(r: DeviceRowLike, nowSeconds: number): string {
  return [r.kind === 'gateway' ? SP.devKindComputer : SP.devKindPhone, r.adding ? null : SP.devAdded(whenText(r.addedAt, nowSeconds))].filter(Boolean).join(' · ');
}

export function DeviceRows({ rows, nowSeconds, thisDeviceTag, onRemove, removeLabel = SP.devRemove }: {
  rows: DeviceRowLike[];
  nowSeconds: number;
  /** The tag on the device that draws the list: "This phone" / "This computer". */
  thisDeviceTag: string;
  /** Remove a device (the phone, stage D3). Without it the rows have no button and no "remove it" warning. */
  onRemove?: (keyId: string) => void;
  removeLabel?: string;
}) {
  return (
    <TileList testid="device-list">
      {rows.map((r) => {
        const isNew = !!r.adding || (r.recent && !r.thisDevice);
        return (
          <TileRow
            key={r.keyId}
            testid="device-row"
            className="su-dev"
            mark={(r.label.trim()[0] ?? '?').toUpperCase()}
            name={r.label}
            detail={deviceDetail(r, nowSeconds)}
            tag={r.thisDevice ? thisDeviceTag : isNew ? SP.admitNew : undefined}
            strongTag
            tagInName
            action={onRemove && !r.adding ? (
              <button type="button" className="btn btn-secondary btn-sm su-rm" onClick={() => onRemove(r.keyId)} aria-label={`${removeLabel} ${r.label}`} data-testid="device-remove">{removeLabel}</button>
            ) : undefined}
            warn={onRemove && !r.adding && r.recent && !r.thisDevice ? SP.devAddedWarn(whenText(r.addedAt, nowSeconds)) : undefined}
          />
        );
      })}
    </TileList>
  );
}
