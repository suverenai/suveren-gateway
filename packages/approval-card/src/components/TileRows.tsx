/**
 * The gateway's list of people on the Team page (`ob-tile su-members`, `su-m` rows: a round mark, a name over a line of detail, a
 * quiet tag on the right), as components so the phone's list of devices is drawn by the same markup and the same CSS.
 */
import type { ReactNode } from 'react';

export function TileList({ title, children, testid }: { title?: string; children: ReactNode; testid?: string }) {
  return (
    <section className="ob-tile su-members" data-testid={testid}>
      {title && <div className="su-tile-h">{title}</div>}
      {children}
    </section>
  );
}

export function TileRow({ mark, name, detail, tag, strongTag, testid, action, tagInName, warn, className }: {
  /** One or two letters in the round mark. */
  mark: string; name: string; detail?: ReactNode; tag?: string; strongTag?: boolean; testid?: string;
  /** A small button at the end of the row (the phone's "Remove", as the Team page's member actions). */
  action?: ReactNode;
  /** The tag sits on the name's line, so the row is two lines (UI review, DEC-88: the device list). */
  tagInName?: boolean;
  /** One line under the row, about this row only (a device added recently). */
  warn?: string;
  className?: string;
}) {
  const tagEl = tag ? <span className={`su-role${strongTag ? ' is-admin' : ''}`}>{tag}</span> : null;
  return (
    <div className={`su-m${className ? ` ${className}` : ''}`} data-testid={testid}>
      <span className="su-av">{mark}</span>
      <div className="su-who">
        <b><span className="su-name" data-testid="row-name">{name}</span>{tagInName && tagEl ? <> {tagEl}</> : null}</b>
        {detail !== undefined && <span>{detail}</span>}
      </div>
      {!tagInName && tagEl}
      {action}
      {warn && <p className="su-warn" data-testid="row-warn">{warn}</p>}
    </div>
  );
}
