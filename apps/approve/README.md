# @suveren/approve — the phone approval app

Stage D1 of the device-keys plan (`suveren-as/docs/device-keys-dev-plan.md`, section 8, step 11, part 1):
register this phone with an enrolment code and a passkey, or join an existing account; add a computer;
the device list; read requests. **Read-only: approve and reject are D2.**

Static files only: HTML, JavaScript, CSS, a web manifest, a service worker. No server code, no secrets
(DEC-1). The only build-time values are the public address of the Authority Server and the build commit
(`VITE_AS_URL`, `VITE_BUILD_COMMIT`, `src/lib/config.ts`). It is never published on a merge; publishing
is the gated release path (step 10, DEC-18), which this stage does not build.

## One UI

The approval card is the shared one (`packages/approval-card`), configured for the phone in
`src/lib/app-host.ts`. The phone loads the gateway page's `tokens.css` and `design-system.css`
(`src/main.tsx`) and adds a few rules of its own in `src/approve.css` (tokens only, tested in
`approve-css.test.ts`). The words are in ONE module, `src/texts.ts`, every text `DRAFT` (the maintainer's
wording); texts that already exist in the shared package (`S8`, `S13`) are imported, not copied.

## Layout

    src/lib/       logic, no React (drivers hold the state of a flow; the screens only draw it)
      key-store.ts        device keys and where they live (below)
      check.ts            the passkey: registration and checks (WebAuthn, ES256, user verification)
      session.ts          sign-in with a check, the chain fetched and verified, the phone's own session limits
      register-driver.ts  genesis from a phone      join-driver.ts   this phone is admitted
      admit-driver.ts     this phone admits a computer       mailbox.ts   pairing mailbox, MACs
      content.ts          opening sealed content (own wrap, fingerprint check, card context)
      proposals.ts        reading requests       app-host.ts  the host seam of the shared card
      transport.ts        THE one network module (no other file calls fetch)
      as-api.ts as-key.ts compat.ts chain-view.ts account-store.ts kv.ts idb.ts scan.ts
      test-kit.ts         a fake server, a fake passkey, a fake computer (real keys and signatures)
    src/screens/   one file per screen group, plus `screens.test.tsx`
    public/        manifest, service worker (static shell only), icons, fonts

## Keys and storage

- Signing key: Ed25519, created non-extractable, stored in IndexedDB as a CryptoKey.
- Reading key: X25519. On iOS 18.7 an X25519 CryptoKey cannot be stored (reads back as null; step 1,
  check 3), so it is made extractable, wrapped at once with a non-extractable AES-GCM key that IndexedDB
  keeps, stored ONLY as ciphertext, and unwrapped as non-extractable for each use (check 3c). The raw
  private key is in page memory once, at creation. The same code runs on Android and on a computer.
- A write is trusted only after it was read back and used; a store that cannot keep keys fails visibly.
- Stored in the clear: the public facts of the account (root DID, key id, head, the pinned server key).
  Never stored: the recovery code, a token (memory only), decrypted content.
- The app asks the browser to keep its storage (`navigator.storage.persist()`) and shows the answer.

## Security notes

- Content Security Policy (plan 8) sent as a header at hosting time (step 10): no inline script, no inline
  style attribute (React sets styles through the CSSOM, which the policy allows), no third-party origin.
  The app needs `font-src 'self'` as well: the plan's policy has `default-src 'none'`, which would block
  the self-hosted fonts in `public/fonts`.
- The phone proves the server holds its pinned key before it signs anything (`as-key.ts`).
- The chain is verified from the genesis on against the head the phone stored; a lower head is a
  rollback, the same number with another hash a fork. The server's word never decides who is active.
- A check is an assertion over the exact object hash; it proves a touch, not what was read.

## Tests

`pnpm --filter @suveren/approve test` (vitest, node): the flows run against a fake server with real
WebCrypto keys and real hap-core verification. The Playwright run against the real stack (step 11) is in
`suveren-e2e`.
