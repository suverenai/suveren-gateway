/**
 * The name of the Authority Server in the sentences the person reads.
 *
 * The texts are written with "suveren.ai", the hosted server. A company that runs its own Authority Server sees that server's
 * host instead: the app says which one it uses once (`setAsHost`, from the address it was built with or the gateway reports),
 * and every text is read through `liveTexts` / `hostText`, so the sentence always names the server actually in use.
 *
 * Pure: no React, no network.
 */

export const DEFAULT_AS_HOST = 'suveren.ai';

let host = DEFAULT_AS_HOST;

/** The host of an Authority Server address (`https://as.example.com` -> `as.example.com`); the default when there is none or it does not parse. */
export function asHostOf(url: string | undefined | null): string {
  if (!url) return DEFAULT_AS_HOST;
  try {
    return new URL(url).host || DEFAULT_AS_HOST;
  } catch {
    return DEFAULT_AS_HOST;
  }
}

/** Say which Authority Server this app uses. Without an address (an older gateway) the hosted server's name stays. */
export function setAsHost(url: string | undefined | null): void {
  host = asHostOf(url);
}

export function asHost(): string {
  return host;
}

/** One sentence, naming the server in use. */
export function hostText(text: string): string {
  return host === DEFAULT_AS_HOST ? text : text.split(DEFAULT_AS_HOST).join(host);
}

/**
 * A texts object whose strings (and the strings its functions return) name the server in use at the moment they are read,
 * not at the moment the module loaded: the gateway page learns its server's address after it has loaded.
 */
export function liveTexts<T extends object>(texts: T): T {
  return new Proxy(texts, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value === 'string') return hostText(value);
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          return typeof out === 'string' ? hostText(out) : out;
        };
      }
      return value;
    },
  });
}
