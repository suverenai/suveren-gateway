/** The give page's default title fills only an empty field; a title the person already typed stays. */
export function autoTitleUnlessTyped(current: string, auto: string): string {
  return current.trim() ? current : auto;
}
