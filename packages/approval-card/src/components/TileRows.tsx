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

export function TileRow({ mark, name, detail, tag, strongTag, testid }: {
  /** One or two letters in the round mark. */
  mark: string; name: string; detail?: ReactNode; tag?: string; strongTag?: boolean; testid?: string;
}) {
  return (
    <div className="su-m" data-testid={testid}>
      <span className="su-av">{mark}</span>
      <div className="su-who">
        <b>{name}</b>
        {detail !== undefined && <span>{detail}</span>}
      </div>
      {tag && <span className={`su-role${strongTag ? ' is-admin' : ''}`}>{tag}</span>}
    </div>
  );
}
