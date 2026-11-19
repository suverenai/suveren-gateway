/** A tiny observable state holder: the logic of every flow lives in a driver (testable in node), React only subscribes. Same shape as the gateway page's (apps/ui/src/lib/driver.ts). */
export class Driver<S> {
  private listeners = new Set<() => void>();
  constructor(protected state: S) {}
  get = (): S => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  protected set(next: S): void {
    this.state = next;
    for (const l of this.listeners) l();
  }
}
