import { useCallback, useRef, type ReactNode } from 'react';
import { AreaIcon } from './AreaIcon';
import { areaIcon } from '../lib/area';

/**
 * Shared pieces of the mandate, ticket and blocked cards (UI spec §18): the
 * approval card's look (§17) — type line, plain title, grey tile, folded rows
 * that open one at a time. Styles live in the "OBJECT PAGES — UI spec §18"
 * section of design-system.css (`.ob-*`).
 */

export function ObLock() {
  return <svg className="ob-i" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>;
}

export function ObChev() {
  return <svg className="ob-i ob-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>;
}

/** "MANDATE · Sales · since 23 Oct · Active" — a small solid label, then quiet parts. */
export function ObTypeLine({ tag, parts, className, profileId }: { tag: string; parts: Array<ReactNode | null | undefined | false>; className?: string; profileId?: string }) {
  // The area icon sits with the first part (the area) — §12.2, kept by §18.1.
  return (
    <div className={`ob-type${className ? ` ${className}` : ''}`}>
      <span className="ob-tag">{tag}</span>
      {parts.filter(Boolean).map((p, i) => <span key={i} className={i === 0 && profileId ? 'ob-area' : undefined}>{i === 0 && profileId && <AreaIcon icon={areaIcon(profileId)} />}{p}</span>)}
    </div>
  );
}

/** A folded row: one line (name + one-line summary), chevron. Opens grey. */
export function ObFold({ title, summary, children, open, testId, attrs, onToggle }: {
  title: string;
  summary?: ReactNode;
  children: ReactNode;
  open?: boolean;
  testId?: string;
  /** Extra attributes on the <details> (e.g. data-ok). */
  attrs?: Record<string, string>;
  onToggle?: (open: boolean) => void;
}) {
  return (
    <details
      className="ob-fold"
      data-testid={testId}
      {...attrs}
      open={open}
      onToggle={onToggle ? (e) => onToggle((e.currentTarget as HTMLDetailsElement).open) : undefined}
    >
      <summary>
        <span className="h">{title}</span>
        {summary != null && <span className="one">{summary}</span>}
        <ObChev />
      </summary>
      <div className="ob-fold-body">{children}</div>
    </details>
  );
}

/**
 * Folded rows inside the element carrying this ref are an accordion (§18.1):
 * opening one closes any other open one in the same card. A callback ref, so
 * it also works for an element that mounts later (an opened card).
 */
export function useFoldAccordion<T extends HTMLElement>() {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((el: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el) return;
    const onToggle = (e: Event) => {
      const d = e.target as HTMLDetailsElement;
      if (!d.open || !d.classList?.contains('ob-fold')) return;
      el.querySelectorAll<HTMLDetailsElement>('details.ob-fold[open]').forEach((o) => { if (o !== d) o.open = false; });
    };
    el.addEventListener('toggle', onToggle, true);
    cleanup.current = () => el.removeEventListener('toggle', onToggle, true);
  }, []);
}
