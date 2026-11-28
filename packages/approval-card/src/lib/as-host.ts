/**
 * The name of the Authority Server in the sentences the person reads.
 *
 * The texts are written with "suveren.ai", the hosted server. A company that runs its own Authority Server sees that server's
 * host instead: the app says which one it uses once (`setAsHost`, from the address it was built with or the gateway reports),
 * and every text is read through `liveTexts` / `hostText`, so the sentence always names the server actually in use.
 *
 * The hosted server is "suveren.ai" however it is written (`www.suveren.ai` too): its texts are never rewritten. A rewrite
 * touches only the word "suveren.ai" standing alone in a text's own wording, so it can be applied twice with the same result
 * (a host such as `staging.suveren.ai` is not rewritten again), and never an argument passed into a text (a name, an email).
 *
 * Pure: no React, no network.
 */

export const DEFAULT_AS_HOST = 'suveren.ai';

let host = DEFAULT_AS_HOST;

/** The host of an Authority Server address (`https://as.example.com` -> `as.example.com`); the hosted server's for none, for `www.suveren.ai` or when it does not parse. */
export function asHostOf(url: string | undefined | null): string {
  if (!url) return DEFAULT_AS_HOST;
  try {
    const h = new URL(url).host.toLowerCase();
    if (!h || h === DEFAULT_AS_HOST || h === `www.${DEFAULT_AS_HOST}`) return DEFAULT_AS_HOST;
    return h;
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

/** "suveren.ai" as a word of its own: not the end of another host (`staging.suveren.ai`), not an email's domain, not the start of one (`suveren.ai.example.com`). */
const HOSTED_NAME = /(?<![\w.@-])suveren\.ai(?![\w-]|\.\w)/g;

/** One sentence, naming the server in use. */
export function hostText(text: string): string {
  return host === DEFAULT_AS_HOST ? text : text.replace(HOSTED_NAME, () => host);
}

/** An argument passed into a text keeps its own "suveren.ai" (an email, a name): hidden while the text is rewritten. */
const HIDDEN = 'suveren\u0000ai';
const hide = (a: unknown): unknown => (typeof a === 'string' ? a.split(DEFAULT_AS_HOST).join(HIDDEN) : a);

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
          const out = (value as (...a: unknown[]) => unknown).apply(target, args.map(hide));
          return typeof out === 'string' ? hostText(out).split(HIDDEN).join(DEFAULT_AS_HOST) : out;
        };
      }
      return value;
    },
  });
}
