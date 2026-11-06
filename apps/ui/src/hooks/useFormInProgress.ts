import { useEffect, useState } from 'react';
import { isFormInProgress, isTypingTarget, isWizardRoute } from '../lib/approval-panel';

/** Elements that belong to the approval panel itself — typing there is not "a form in progress". */
const OWN_UI = '[data-apr-ui]';
const DIALOGS = '.modal-backdrop, [role="dialog"][aria-modal="true"]';

function read(pathname: string): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement as HTMLElement | null;
  const fieldFocused = isTypingTarget(el) && !el?.closest(OWN_UI);
  // A dialog counts unless it is one of ours.
  const modalOpen = Array.from(document.querySelectorAll(DIALOGS)).some((d) => !d.closest(OWN_UI));
  return isFormInProgress({ modalOpen, fieldFocused, wizardRoute: isWizardRoute(pathname) });
}

/**
 * True while the person is typing in a form or dialog: focus in a text field,
 * a dialog open, or the new-mandate wizard. The approval panel never slides
 * over this; it waits (and shows a bar instead).
 */
export function useFormInProgress(pathname: string): boolean {
  const [typing, setTyping] = useState(() => read(pathname));
  useEffect(() => {
    const update = () => setTyping(read(pathname));
    update();
    document.addEventListener('focusin', update);
    // focusout fires before the next element has focus: look again after the browser has moved it.
    const afterOut = () => { window.setTimeout(update, 0); };
    document.addEventListener('focusout', afterOut);
    // Dialogs appear and go without focus events of their own.
    const mo = new MutationObserver(update);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', afterOut);
      mo.disconnect();
    };
  }, [pathname]);
  return typing;
}
