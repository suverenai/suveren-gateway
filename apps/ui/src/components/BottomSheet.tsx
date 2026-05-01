import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Generic bottom-sheet drawer. Slides up from the bottom of the
 *  viewport, with backdrop tap-to-close and Escape-to-close. Used on
 *  mobile widths where a side-by-side layout doesn't fit. */
export function BottomSheet({
  open,
  onClose,
  children,
  ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  ariaLabel?: string;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement;
    document.body.style.overflow = 'hidden';
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    sheetRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = '';
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, [open, onClose]);

  return createPortal(
    <>
      <div
        className={`bottom-sheet-backdrop${open ? ' is-open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        ref={sheetRef}
        className={`bottom-sheet${open ? ' is-open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
      >
        <div className="bottom-sheet-handle" aria-hidden="true" />
        <button
          type="button"
          className="bottom-sheet-close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
        {children}
      </aside>
    </>,
    document.body,
  );
}
