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
    // While a pointer is pressed, wait for its release: hiding the bar between press and release
    // shifted the page and the click landed on the element below (2026-11-06, e2e core-objects E).
    let pressed = false;
    let pending = false;
    const onDown = () => { pressed = true; };
    const onUp = () => {
      pressed = false;
      if (pending) { pending = false; window.setTimeout(update, 0); }
    };
    const afterOut = () => {
      if (pressed) { pending = true; return; }
      window.setTimeout(update, 0);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    document.addEventListener('focusout', afterOut);
    // Dialogs appear and go without focus events of their own.
    const mo = new MutationObserver(update);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', afterOut);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      mo.disconnect();
    };
  }, [pathname]);
  return typing;
}
