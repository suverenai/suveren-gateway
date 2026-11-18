/** A tiny observable state holder for the device flows: the logic lives here (testable in node), React only subscribes. */
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
