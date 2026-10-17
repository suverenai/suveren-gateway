import { AreaIcon } from './AreaIcon';
import type { AreaIconName } from '../lib/area';

export interface AreaFilterOption {
  /** The profile's short id — the `?area=` value (UI spec §13.3). */
  shortId: string;
  icon: AreaIconName;
  name: string;
  count: number;
}

interface Props {
  /** One per area present in the data — nothing rendered below two (All +
   *  a single area would be a no-op filter). */
  areas: AreaFilterOption[];
  /** The current `?area=` value, or `null` for "All". */
  selected: string | null;
  onSelect: (shortId: string | null) => void;
  totalCount: number;
}

/**
 * "All" + one pill per area present in the data (UI spec §13.3), icon + a
 * quiet count — same `.ftab` pill the Tickets page's Automatic/Approved/All
 * tabs already use: thin outline, 2px border + bold when selected.
 */
export function AreaFilterPills({ areas, selected, onSelect, totalCount }: Props) {
  if (areas.length < 2) return null;
  return (
    <div className="ftabs" role="tablist" aria-label="Which area">
      <button
        type="button"
        role="tab"
        className="ftab"
        aria-selected={selected === null}
        onClick={() => onSelect(null)}
      >
        All <span className="n">{totalCount}</span>
      </button>
      {areas.map(a => (
        <button
          key={a.shortId}
          type="button"
          role="tab"
          className="ftab"
          aria-selected={selected === a.shortId}
          onClick={() => onSelect(selected === a.shortId ? null : a.shortId)}
        >
          <AreaIcon icon={a.icon} /> {a.name} <span className="n">{a.count}</span>
        </button>
      ))}
    </div>
  );
}
