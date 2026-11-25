/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The Authority Server's public address (suveren.ai, or a customer's own). A public value, never a secret. */
  readonly VITE_AS_URL?: string;
  /** The commit this build was made from, shown in the app (plan 8: "The app shows its build commit"). */
  readonly VITE_BUILD_COMMIT?: string;
}
