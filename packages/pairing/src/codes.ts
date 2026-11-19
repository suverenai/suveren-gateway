/** The comparison code the person taps (plan 20.11): the real one and two others, never two equal, in random order. */

function sixDigits(): string {
  const n = globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  return String(n % 1_000_000).padStart(6, '0');
}

export function codeChoices(real: string): string[] {
  const out = [real];
  while (out.length < 3) {
    const c = sixDigits();
    if (!out.includes(c)) out.push(c);
  }
  // Fisher-Yates with the platform's random source.
  for (let i = out.length - 1; i > 0; i--) {
    const j = globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Compare a tapped code with the real one without an early exit on the first different digit. */
export function sameCode(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
