/**
 * A tab still running the previous build after an update. While someone is signed in, UpdateBanner asks before
 * reloading so that work in progress is not lost. Signed out there is nothing to lose, so the tab reloads by itself.
 */
export function shouldReloadAfterUpdate({ signedIn, serverRestarted }: { signedIn: boolean; serverRestarted: boolean }): boolean {
  return serverRestarted && !signedIn;
}
