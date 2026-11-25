import { T } from './device-texts';

/** Mirrors the control plane's rule (routes/password.ts MIN_PASSWORD_LENGTH); it enforces it again. */
export const MIN_PASSWORD_LENGTH = 10;

/** The first thing wrong with a new password pair, as the sentence to show, or null. */
export function checkNewPassword(password: string, again: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return T.passwordTooShort;
  if (password !== again) return T.passwordMismatch;
  return null;
}
