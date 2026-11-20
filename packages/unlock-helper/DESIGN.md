# Native unlock helper — design (step 5a, DEC-38 and DEC-47)

Status: design, a working macOS helper, and its integration into the gateway's control plane (step 5a, behind
`SUVEREN_DEVICE_KEYS=on`). Windows is designed, not built.
Measured on a MacBook Air M5, macOS 26.6.2, Swift 6.3.3, command-line tools only (no Xcode).

The helper does two things for the Suveren gateway:

1. **Unlock.** It holds a second wrap of the gateway's random vault key. The wrap opens only after the
   person touches Touch ID (macOS) or Windows Hello (Windows). The unlock password stays as the first
   wrap and as the fallback.
2. **Check key.** It holds the computer's check key (`device.check` of type `platform`): a P-256 key in
   the Secure Enclave or the TPM that signs the SHA-256 hash of one object, only after a touch, and
   shows a reason text in the system prompt.

Plan references: device-keys-dev-plan.md sections 3.1, 7 (rows "new unlock by the computer's platform
authenticator" and "new confirmation for sensitive changes"), 12 row 5a, 12.1 line 26, 12.3, 14
(DEC-38, DEC-47), 21.

What the person needs to know: they touch the sensor, and the system says what for. Nothing else.

---

## 1. What is built and what is not

| Part | State |
|---|---|
| Swift helper for macOS (`macos/`), Secure Enclave keys, wrap/unwrap, check signature, caller refusal | built, runs |
| Node client (`src/`) and protocol types | built, tested against a fake and against the real helper |
| Touch prompts (unwrap, sign) on the real Secure Enclave | **not run**: they need a touch. Manual checks for the maintainer: section 9 |
| Windows helper | designed (section 8), not built, not measured |
| The prompt text built by the helper from the object | built (section 5, 3.3) |
| The provider in `vault.ts` (third way to the vault key), the computer's check key, the per-change confirmation | built in `apps/control-plane` (section 12), tested with the helper's software backend and a fake |
| The helper as an ad-hoc signed `Suveren.app` inside the npm package, hashes checked before every start | built (`macos/build-app.sh`, `bundle/build.mjs --with-helper`, section 12) |
| Apple Developer ID signing and notarisation, the Windows installer | open points, section 10 |

---

## 2. Process model

**The gateway starts the helper as a child process and talks to it over the child's stdin and stdout.
One JSON object per line.**

Why stdio and not a Unix socket or a named pipe:

- A pipe to a child has exactly two ends. No other program can connect. A socket in the file system
  (or a Windows named pipe) is an address that any program of the same user can open; the helper would
  then have to tell callers apart by their process id, which is easy to get wrong.
- The helper's life is the gateway's life: stdin closes when the gateway ends, the helper exits.
  No daemon, no port, no file to clean up, no state between runs.
- The same model works on Windows (anonymous pipes), so the Node client is one piece of code.

How it runs:

- The gateway starts it **on demand** and may keep it for a short time. The client serves one request at
  a time: only one prompt can be on screen, and the person must know which request a touch answers.
- The helper is **stateless**. It keeps no key and no file. The gateway stores the opaque key blobs and
  the wrapped key in `vault.enc.json` (the same file as the password wrap). Nothing to configure, and
  one atomic write covers everything.
- A touch that takes too long (default 120 s in the client) ends the helper process, so a late touch
  cannot answer a request the gateway has already given up on.
- stderr carries one short line on refusal. No secret is ever logged.

Files in this package:

```
packages/unlock-helper/
  DESIGN.md
  src/        Node client and protocol types (TypeScript)
  test/       tests; fake-helper.mjs is a fake and doubles as the reference for the wrap format
  macos/      Swift package: UnlockCore (library), suveren-unlock-helper (executable), tests
    manual-check.mjs   the manual check of section 9
    test.sh            swift test with command-line tools only
```

---

## 3. Protocol (version 1)

Request: `{ "id": <int|string>, "op": "<name>", …fields }`. Response: `{ "id": …, "ok": true, …fields }` or
`{ "id": …, "ok": false, "error": { "code": "<code>", "message": "<text for a log>" } }`.
All binary fields are base64url without padding. A request line is at most 16 KiB.

### 3.1 Operations

| op | Request fields | Response fields | Touch |
|---|---|---|---|
| `hello` | — | `helper`, `version`, `protocol` (1), `platform`, `backend`, `secureHardware`, `biometry`, `userPresence` | no |
| `wrap.create` | `policy` | `keyBlob`, `publicKey`, `policy` | no |
| `wrap` | `publicKey`, `vaultKey` (32 bytes), `aad` (string) | `wrapped` | no (public-key operation) |
| `unwrap` | `keyBlob`, `wrapped`, `aad` | `vaultKey` | **yes** |
| `check.create` | `policy` | `keyBlob`, `publicKey`, `policy` | no |
| `check.sign` | `keyBlob`, `digest`, `object` (no text of any kind) | `signature`, `publicKey`, `reason` (the text the prompt showed) | **yes** |
| `shutdown` | — | — | no |

`policy` is `user-presence`, `biometry-current-set` or `biometry-any` (section 6.1). `publicKey` is the
uncompressed P-256 point, 65 bytes, `0x04 || X || Y`. `keyBlob` is opaque: on macOS CryptoKit's
`dataRepresentation` of the Secure Enclave key (the key encrypted to this computer's Secure Enclave,
with its access control). It is useless on another computer.

`hello.biometry` and `hello.userPresence` are asked of the system without a prompt.
`hello.secureHardware` false means the helper cannot protect a key: the gateway offers only the password.

### 3.2 Exact bytes

**Check signature.** `digest` is `"sha256:"` plus 64 lower-case hex digits, the entry hash (or grant
hash, or change-request hash) the verifier computes. The helper signs the **32 raw digest bytes** with
ECDSA P-256; the SHA-256 inside ECDSA runs over those 32 bytes. This is exactly what hap-core's
`verifyCheck` does for `type: "platform"` (`subtle.verify({name:"ECDSA", hash:"SHA-256"}, key, rs, digestBytes)`).
`signature` is the ASN.1 DER encoding (what CryptoKit's `derRepresentation` gives, which `ecdsaDerToRaw`
accepts). The chain entry then holds `device.check = { type: "platform", pub: <publicKey> }` and
`checks[i].check = { signature: <signature> }` (client helpers `platformCheckKey`, `platformCheckProof`).

`object` is required: the exact bytes that were hashed. The helper first checks `SHA-256(object) == digest` and
refuses with `digest_mismatch`, before any prompt, then builds the prompt text from the object (3.3, section 5).
For a chain entry the object is hap-core's `entrySignedBytes(entry)` (the digest is `entryHash(entry)`); for a
connector-login change it is the canonical JSON of the change request (plan section 7).

**Wrap.** 126 bytes, base64url:

```
wrapped = 0x01 || ephemeralPublicKey (65 bytes, X9.63) || nonce (12) || ciphertext (32) || tag (16)
key     = HKDF-SHA256( ECDH(ephemeralPrivate, wrapPublicKey),
                       salt = ephemeralPublicKey || wrapPublicKey,
                       info = "suveren-unlock-wrap-v1", length 32 )
AES-256-GCM, plaintext = the 32-byte vault key, authenticated data = UTF-8 of `aad`
```

`aad` is a string the caller chooses. The gateway uses `"suveren-vault-key-platform-wrap-v1|" + accountId` (the
password wrap's own string, `suveren-vault-key-wrap-v1|` + account id, is another), so a wrap cannot be moved
to another account or used for another purpose. Why ECIES and not "encrypt with the Secure Enclave":
the Secure Enclave only holds EC keys for signing and key agreement. With key agreement, **wrapping
needs no touch** (only the public key) and **no helper**: Node does the ECIES wrap itself (`wrapVaultKey` in
`src/wrap.ts`), so a vault-key rotation or a new account binding re-wraps silently, and the plaintext vault key is
never sent to the helper (the helper has no `wrap` operation). Only **unwrapping** asks the person. A second
Node reference for the format is in `test/fake-helper.mjs`; a test proves the Swift helper opens what both make.

### 3.3 The reason text

`check.sign` takes **no text**. A request that carries a `reason` is refused (`bad_request`). The helper builds
the text of the system prompt from the object it signs: `ReasonText.forObject` in `macos/Sources/UnlockCore/Reason.swift`
(and `reasonFor` in `test/fake-helper.mjs`, which a test compares on the same objects). The text is 1 to 120
characters, NFC, with no control, format, line or paragraph separator characters (the rule of hap-core's device
label), starts with a verb in lower case (macOS puts "<program> is trying to" before it), and is returned as
`reason` so the gateway and the tests can see what was shown. An object the helper has no text for is refused
before any prompt (`bad_request`). `unwrap` takes no text either; the helper says "unlock the Suveren vault".

**All texts are PLACEHOLDERS for the maintainer's wording (O19).** Where `<label>` appears it is the device label
from the object (at most 64 characters, so the whole text stays within 120):

| Object | Text shown after "Suveren is trying to " |
|---|---|
| unlock (`unwrap`, fixed) | `unlock the Suveren vault` |
| chain entry `genesis` | `set up the device "<label>" with its own key` |
| chain entry `add` | `add the device "<label>"` |
| chain entry `reset` | `replace every device with "<label>"` |
| chain entry `remove` | `remove a device` |
| chain entry `set` with a check key | `give a device a check key` |
| chain entry `set` removing the check key | `remove the check key of a device` |
| chain entry `rotate-root` | `replace the recovery code` |
| mandate grant, `op` `grant` (typ `suveren-mandate-grant`, the fixed members and a `profile_id`) | `grant the mandate for "<profile_id>"` |
| mandate grant, `op` `change` | `change the mandate for "<profile_id>"` (a `revoke` is signed without a check: no text, no prompt) |
| change request, `kind` replace | `replace the login of "<name>"` |
| change request, `kind` remove | `remove the login of "<name>"` |
| Touch ID unlock switch, `action` enable | `turn on Touch ID unlock for Suveren` |
| Touch ID unlock switch, `action` disable | `turn off Touch ID unlock for Suveren` |
| cancel of a request for a new identity (`suveren-identity-cancel`) | `cancel the request for a new identity` |
| team anchor (`suveren-team-anchor`, hap-core 0.16.0), naming an admin | `trust the admin of the team you asked to join` (DRAFT; the object has the team's id but not its name) |
| team anchor clearing the statement (`admin_did` null) | `stop trusting the admin of a team` (DRAFT) |
| team member list (`suveren-team-members`) with `focus` | `add "<name>" to the team, code <code>` (DRAFT). `focus` is a DID the caller names to pick one member; the name and the 24-digit identity code come from that member's entry in the object. Without a focus, or with one not in the list, or a code that is not 6 groups of 4 digits: `bad_request` before any prompt. |
| team member list (`suveren-team-members`) with `previous` (DEC-73 step 5) | `previous` is the signed bytes of the list before (base64url, at most 200 000 bytes) and is REQUIRED for every list after version 1: only version 1 (the admin alone, `prev` null) may go without it, with a `focus`. The helper requires `sha256(previous)` = the list's `prev`, the same `team_id`, `version` = previous + 1, both lists well formed, every staying member unchanged. It then diffs the two itself: one added `add "<name>" to the team, code <code>`; one removed (not the admin) `remove "<name>" from the team, code <first 4 groups of its code>` (the whole code does not fit next to a 64-character name inside 120 characters; the 4 groups tell two members of the same name apart); one replaced by another (not the admin) `new identity for "<name>", code <code of the new identity>`; same members `sign the team list again`; a new admin with the same members and `handover` naming the old admin `hand the team over to "<name>"` (DRAFT, all). Anything else (several changes, the admin removed, a changed entry, a hand-over that also changes members, a hand-over with the same admin, a change of admin without hand-over) is `bad_request` before any prompt. `focus`, if given, must be the added member. The caller supplies no text; a text over 120 characters is refused. |

A `<label>` or `<name>` comes from the object and is put between double quotes with `\` and `"` escaped, so no
name can end the quote and add words ("x\" and approve \"y" stays one quoted name); control, bidi and
line characters are refused as before; a text over 120 characters is refused, not cut.

The change request carries the connector's name (`name`), added to plan section 7's five members
(`request_id`, `kind`, `change_hash`, `gateway_key_id`, `expires_at`) so the prompt can say which login; the
helper accepts exactly these six members. The Touch ID switch object is exactly `typ` `suveren-platform-unlock`, `v`,
`action`, `nonce`, `issued_at`. The cancel object (hap-core 0.15.0, plan 6.2) is exactly `typ`, `v`, `aud`, `root_did`,
`key_id`, `request_id`, `chain_seq`, `chain_head`, `issued_at`. All texts are placeholders for the maintainer's wording (O19).

Mandate grants (steps 13 and 14) are not in the table: their object format is not frozen.

### 3.4 Error codes

| code | meaning |
|---|---|
| `bad_request` | malformed field, wrong size, bad policy, reason or digest out of range |
| `unsupported` | unknown op |
| `no_secure_hardware` | no Secure Enclave / TPM, or no way to verify a person |
| `no_biometry` | a fingerprint is needed and none is enrolled or Touch ID is unavailable |
| `biometry_locked` | Touch ID locked out after failures; the login password unlocks it |
| `user_cancelled` | the person cancelled |
| `auth_failed` | the person was not recognised |
| `interaction_required` | a touch is needed and prompts are switched off (`SUVEREN_HELPER_NO_PROMPT=1`, used in tests) |
| `key_invalid` | the key blob cannot be used here: another computer, fingerprints changed under `biometry-current-set`, damaged |
| `unwrap_failed` | the wrap does not open: other key, other account, damaged. Always after the touch |
| `digest_mismatch` | `digest` is not the SHA-256 of `object` |
| `caller_refused` | the helper does not serve this caller; it sends this once and exits (code 77) |
| `internal` | anything else |

The client adds `helper_missing`, `helper_exited`, `timeout`, `bad_response`. How the gateway shows them
is wording for the screens (O19); the gateway's rule is: any error except `user_cancelled` and
`auth_failed` leaves the password path open.

---

## 4. Refusing a caller that is not the gateway

Three layers, all in `CallerPolicy.swift`:

1. **No address to connect to** (section 2). The only program that can write to the helper's stdin is the
   program that started it.
2. **The helper checks its parent at start and before every request.** It reads
   `allowed-callers.json` from the folder of its own executable, or, inside `Suveren.app/Contents/MacOS`, from
   the folder that holds the `.app` (a file added inside a signed bundle breaks its seal: measured, `codesign
   --verify --strict` fails). Not from an argument: in a release build no flag can change the file. It requires:
   - the parent is still the process that started it (`getppid` unchanged);
   - stdin is a pipe or a socket, not a terminal or a file;
   - the parent's executable (resolved path, `proc_pidpath`) is one listed, e.g. the Node binary the
     gateway runs under;
   - the parent's `argv[1]`, resolved, lies **inside the gateway's install directory**
     (`scriptPrefix`, compared as a path prefix after resolving `..` and links);
   - `argv[1]` is a script, not an option: a parent started as `node --require evil.js gateway.js`
     is refused; so is a parent with `NODE_OPTIONS` set.
   The parent's arguments and environment come from the kernel (`sysctl KERN_PROCARGS2`), not from
   anything the caller sends.
3. On refusal the helper sends `caller_refused` (no id) and exits with 77. A missing or unreadable list
   also refuses.

Verified by running: real helper, real child processes (test `real helper refuses a caller that is not
the gateway`): served for a launcher inside the allowed folder; refused for a launcher outside it, for a
parent started with `--no-warnings`, for a parent with `NODE_OPTIONS`, for a missing list, and for the
test process itself. Release build: `--backend software`, `--allow-any-caller` and `--allowed-callers`
are compiled out (checked by running the release build).

**What the caller check is worth: nothing against a program of the same user.** The list is written by the
gateway's control plane before every start of the helper (`lib/platform-helper.ts`): this Node program and the
folder its entry script lies in. The file sits in the package folder, which the person's own user can write, and
the gateway itself rewrites it. So any other program of that user writes itself into the list and is served
(confirmed by an attacker script in the review of this step). The check stops accidents and programs of other
users, nothing more; it is kept because it costs nothing. NODE_OPTIONS (the helper refuses a *parent* that has it,
but the attacker is not that parent), DYLD_INSERT_LIBRARIES into the gateway, and an inspector signal into the
running gateway are further ways past it. **The real fix is a list written at install time into a folder the user
cannot write, and the gateway as its own OS user** (plan section 21, S1 to S3, O29). Until then the protection of
the vault key and of the check key is the touch and nothing else: see "Honest limits" and `PLATFORM_UNLOCK_OPENS_PAGE_SESSION`
(section 12.1). Where the package folder is not writable by the person at all (a root-owned global install) the list
cannot be written and the helper is reported unavailable (`helper_failed`).

**Hashes.** Before every start of the helper process the control plane hashes every file of `Suveren.app` against a
list it carries (`dist/control-plane/helper-manifest.json`, written by `bundle/build.mjs --with-helper`), and hashes
them again after the helper answered `hello`. That list sits in the same writable install, so it too adds nothing
against a same-user program (which rewrites binary and list together); it catches a damaged or half-updated install and a
swap that leaves the list alone. `bundle/build.mjs --with-helper` refuses a DEBUG helper (a binary that contains
`software-test`, `--backend`, `--allow-any-caller` or `--allowed-callers`) and any file that does not match its list.

### Honest limits

- **A program of the same user can ask for the prompt.** It can start `node <gateway>/entry.js` as its
  own child (argv looks right), patch the gateway's files, inject code into the running gateway, or read
  its memory. Then it can ask the helper for an unlock (the person sees "unlock the Suveren vault") or
  for a check signature with a reason it makes up. The checks above stop a *different* program that
  launches or talks to the helper; they do not stop a program that *is* the gateway or controls it.
  That is plan section 21: the answer is separation (the gateway as its own OS user or service, signed
  files in a protected folder; S1 to S3, O29).
- **The same applies to key blobs.** The blob is not bound to the helper binary: a blob made by one
  ad-hoc signed binary opened in another binary with another signing identity (measured, section 7).
  Any program of this user can load a blob it can read and ask for a touch. The blob is bound to this
  computer's Secure Enclave and to the person's touch, not to the program. The blobs are in the vault file
  (the wrap key's) and in a sealed vault slot (the check key's), next to the files the same program could read.
- **What does protect:** the vault key and the check key are never usable without a touch, and an AI
  cannot supply a fingerprint. Under `user-presence` an AI that has the login password and sees the
  screen could type it; that is why the check key should use biometry (6.1).
- **If the AI can run the helper and the person touches without reading,** the AI gets the vault key
  (unlock) or a signature (check). The only help is that the prompt says what it is for, and that the
  reason is derived from the signed object, not chosen by the caller (section 5).
- The helper never receives the vault key (Node wraps). When it unwraps, it sends the key back in plain text over the
  pipe. Only the parent can read that pipe. Swift cannot guarantee that memory is wiped;
  the process is short-lived.
- Windows: not built; the same model applies (section 8).

---

## 5. What the system prompt can and cannot show

Measured by the maintainer (plan 12.3 line 26, a plain command-line program): the prompt shows the program's
icon and name, then "<program> is trying to <reason>." and "Touch ID to allow this." A 47-character
reason was shown in full over two lines.

**It can show:** one short plain-text sentence, starting with a verb in lower case, because macOS puts
"<program> is trying to" in front. Examples that fit: "unlock the Suveren vault", "add the device
'iPhone'", "grant the mandate: offers by email, up to 3 per day".

**It cannot show:** line breaks, bold, lists, a table of limits, the object itself. The helper refuses
control and bidi characters so a reason cannot reshape the prompt. Not measured: how macOS cuts a
reason of 120 characters (manual check 2), what the prompt looks like over remote desktop, and whether
the login-password fallback of `user-presence` shows the reason too.

**Who writes the reason.** The helper, from the object (3.3). A caller cannot supply text. A caller that
gives a different object than the one it hashes is refused (`digest_mismatch`); a caller that gives a true object
gets a true text. What the person reads is what the signature covers, as long as the template is faithful.
The template for the mandate grant (step 13) is in 3.3: placeholder wording naming the profile id; the grant has no title, so the text cannot say "offers by email".

A touch to open a session and a touch for a change look different because the reasons differ.
(Under DEC-47 an approval needs no check; only the unlock and *grant* touch.)

---

## 6. Key lifecycle

Two keys, both made by the helper, both usable only after a touch:

| Key | Kind | Used for |
|---|---|---|
| **wrap key** | Secure Enclave P-256, key agreement | unwrap the vault key (the second wrap) |
| **check key** | Secure Enclave P-256, signing | `device.check` of type `platform` |

They are separate keys (CryptoKit's key types are separate, and a key that signs changes should not also
open the vault).

### 6.1 Access control: `.userPresence` or `.biometryCurrentSet`

Both keys are created with `.privateKeyUsage` plus one of:

| Policy | Allows | Fingerprint change | Mac without Touch ID |
|---|---|---|---|
| `user-presence` (`.userPresence`) | Touch ID, or the Mac's login password | key survives | works with the login password |
| `biometry-current-set` | Touch ID only | key becomes **invalid** when a finger is added or removed | cannot be created (`no_biometry`) |
| `biometry-any` | Touch ID only | key survives | cannot be created |

All three were created on this Mac and all refused to sign or agree without a touch
(`interaction_required`, LocalAuthentication -1004). The prompt itself was not run.

**Recommendation (the maintainer decides):**

- **Wrap key: `user-presence`.** The unlock has the password as fallback anyway, a Mac without Touch ID
  can still use the login password, and a changed fingerprint set does not lock the person out of the
  convenient path. A touch is "the computer's own lock", which is what DEC-38 asks for.
- **Check key: `biometry-current-set`.** The value of the check is that a person touched. A login
  password can be typed by an AI that sees the screen; a fingerprint cannot. `biometry-current-set` also
  stops someone who knows the login password from enrolling their own finger and then signing. The cost:
  a fingerprint change invalidates the key, and the device then holds no valid check until another
  granting device (or the recovery root) replaces `device.check` with a `set` entry. A person with only
  this computer must use recovery. `biometry-any` avoids that cost and gives up the protection against a
  newly enrolled finger. A Mac without Touch ID has no check key; its owner uses a security key through
  the page (plan 7).

`biometry-current-set` invalidation was not tested (it needs a fingerprint change). It is Apple's
documented behaviour; the helper reports a blob that no longer loads as `key_invalid`.

### 6.2 Create

1. Gateway, vault unlocked by the password: `hello`; if `secureHardware` is false, stop.
2. `wrap.create` → `keyBlob`, `publicKey`. `wrap` the vault key with `aad = accountId` → `wrapped`.
3. **One test `unwrap` (one touch) before the password becomes optional.** Only if it returns the same
   key does the gateway store the header. This catches a broken prompt before it matters.
4. The gateway writes `platform: { v:1, backend, policy, keyBlob, publicKey, wrapped }` into
   `vault.enc.json` in one atomic write, beside the password header. Nothing in it is secret: the blob
   needs this computer's Secure Enclave and a touch.
5. Check key: `check.create` at set-up, when the person asks for it (section 12.3). The gateway keeps `keyBlob`
   in a sealed vault slot; `publicKey` goes into the first chain entry (`device.check`). One check key per gateway.

### 6.3 Use

- After a restart: `unwrap` → vault key → the gateway adopts it (one touch). Wrong touch, cancel or any
  error: the password dialog remains.
- A change that needs a check: the gateway builds the object, hashes it, calls `check.sign` with
  `digest` and `object` (one touch), checks the signature itself with hap-core `verifyCheck` against the key's
  public half, and puts `signature` into `checks` (a chain entry) or counts it as the confirmation (a change request).

### 6.4 Rotation and re-wrap

- **Vault key changes** (the rekey of `vault.ts`, with its `pending` old key): `wrap` again with the same
  public key. No touch. Wrap the old key too while a rekey is unfinished, as the password header does.
- **Wrap key replaced** (fingerprints changed, `key_invalid`, or the person asks): `wrap.create`, `wrap`
  the vault key (vault unlocked by the password), test `unwrap`, replace the header, drop the old blob.
- **Check key replaced:** `check.create`, then a chain entry (`set`) that carries the new `device.check`,
  signed by a granting device that still works. If the old key is gone and no other granting device
  exists, the recovery root (plan section 10).
- **Deleting a key.** CryptoKit Secure Enclave keys are not stored anywhere by the system: the blob is
  the key. Delete the blob and the key is gone (the Secure Enclave cannot make a new one from nothing).
  No `SecItemDelete` is needed or possible. Keys made in probes and tests exist only in the memory of
  the running process.

### 6.5 Reinstall, update, another computer

| Case | Result |
|---|---|
| Gateway reinstalled or updated; data folder kept | the blob is not bound to the helper binary (measured), so a new helper build opens it |
| Helper re-signed with another identity (ad-hoc to Developer ID) | opens the same blob (measured: ad-hoc blob opened by a binary with another identifier) |
| `vault.enc.json` and the blob copied to another computer | `key_invalid`: the Secure Enclave there cannot load it; the password works; the gateway offers to set up again. Not tested (one computer), Apple documents the binding |
| Mac wiped, or logic board replaced, or restored to a new Mac | the same: password, then set up again |
| Data folder deleted | nothing to unwrap; the account re-binds as a new install (plan sections 3, 11) |
| Fingerprints changed | `user-presence` wrap key: nothing happens. `biometry-current-set` check key: `key_invalid` (6.1) |

---

## 7. macOS: signing, entitlements, notarisation — what was measured

**Question:** can an unsigned or ad-hoc signed command-line binary create and use Secure Enclave keys
with access control on macOS 26, or does it need a signed binary with a keychain-access-group
entitlement?

**Answer: no signing identity and no entitlement are needed, as long as the keys are CryptoKit keys that
the helper stores itself (the `dataRepresentation` blob), not keychain items.**

Measured with a minimal probe (`SecureEnclave.P256`, MacBook Air M5, macOS 26.6.2, Swift 6.3.3):

| Probe | Result |
|---|---|
| Build with `swift build` (the linker adds an **ad-hoc** signature on arm64) | creates SE signing and key-agreement keys with `.userPresence`, `.biometryCurrentSet`, `.biometryAny` and none |
| Use without interaction (`LAContext.interactionNotAllowed`) | the three touch policies refuse with LocalAuthentication -1004 "User interaction is required"; the key with no policy signs |
| `codesign --force -s -` (explicit ad-hoc) | same results |
| **No signature at all** (`codesign --remove-signature`) | **the kernel kills it** (exit 137) before main. arm64 needs at least an ad-hoc signature; SwiftPM and `swiftc` provide it |
| Keychain-stored SE key (`SecKeyCreateRandomKey`, `kSecAttrIsPermanent`, access control) | **fails with -34018 (`errSecMissingEntitlement`)** for the ad-hoc binary: that route needs a keychain access group, i.e. a signed binary with an application identifier |
| Keychain query for SE keys after the probe | status -25300, 0 items: nothing was left behind |
| Blob made by one ad-hoc binary, opened by another binary in an ad-hoc signed `Suveren.app` bundle (other identifier) | opens (reaches `interaction_required`, not `key_invalid`) |

So the design deliberately uses `dataRepresentation` blobs, kept in `vault.enc.json`. It avoids the
entitlement, and it avoids keychain items, so there is nothing to clean up in the user's keychain.

What this does **not** answer, and needs a person on the real prompt: whether a **Developer ID signed**
or **notarised** build behaves the same at the prompt (it should: signing only adds identity, and
the blob is not bound to it); and the prompt's name and icon for an `.app` bundle (below).

Keys created and deleted while measuring: the probe made 4 SE signing keys and 4 SE key-agreement keys
(one per policy), each only in memory of the running probe, and one attempt at a keychain-stored key,
which failed, so nothing existed to delete. `swift test` makes SE keys the same way (2 policies, 2 kinds,
in memory). The keychain query afterwards showed no items. No file with key blobs was written; the real
helper never writes files. The probe was in the scratchpad, not in this repository.

**Notarisation.** Notarisation needs a Developer ID Application certificate and the hardened runtime
(`codesign --options runtime`). The helper needs **no entitlement** under the hardened runtime. A bare
Mach-O binary cannot carry a stapled ticket (only an app bundle, disk image or installer package can);
a bare binary shipped inside an npm package is not quarantined and Gatekeeper does not assess it, but
an `.app` bundle inside the package can be stapled and also gives the prompt a name and an icon.

**What the prompt calls the program.** Plan 12.3 shows the program's name and icon for a plain binary.
The helper ships as a minimal bundle `Suveren.app` (`Contents/MacOS/suveren-unlock-helper`, `Info.plist` with
`CFBundleName` "Suveren", `LSUIElement` so it has no Dock icon), made by `macos/build-app.sh`, so the prompt
should read "Suveren is trying to unlock the Suveren vault". Not run at the prompt: manual check 3 (section 9).
Measured on 2026-11-18: the ad-hoc signed bundle passes `codesign --verify --strict --deep`; a file added
inside it afterwards does not (this is why the list of callers sits beside the `.app`, section 4).

**Intel Macs.** Secure Enclave exists on T2 Macs. A universal build was not tried. Open point.

---

## 8. Windows design (not built, not measured)

Same process model, same protocol, same Node client. The helper is `suveren-unlock-helper.exe`, started by
the gateway with anonymous pipes. Everything below is **design from documentation, not run**.

**Language.** Native, small, no runtime to install: C++ or Rust (the `windows` crate). .NET would add a
runtime to the installer. To decide.

**Check key (`device.check` type `platform`, ECDSA P-256).**
- Route A: CNG with the **Microsoft Platform Crypto Provider** (`MS_PLATFORM_CRYPTO_PROVIDER`):
  `NCryptCreatePersistedKey` with `BCRYPT_ECDSA_P256_ALGORITHM`, a key name unique to the install, the
  key non-exportable (it lives in the TPM). The persisted key is stored by Windows under the user's
  profile and referenced by name, so the helper's "blob" is the key name. `NCryptSignHash` over the 32
  digest bytes gives IEEE P1363 `r || s` (64 bytes); the helper converts it to DER (hap-core's
  `ecdsaRawToDer`), so the signature format is the same as on macOS. *Open and critical:* whether this
  provider asks for **Windows Hello** at each signature. `NCRYPT_UI_POLICY_PROPERTY`
  (`NCRYPT_UI_PROTECT_KEY_FLAG`) is a software-provider mechanism; for TPM keys the usual way to demand
  a person is an authorisation value (PIN) or the **Passport / NGC provider**. To be measured.
- Route B: the **Microsoft Passport Key Storage Provider** (`MS_NGC_KEY_STORAGE_PROVIDER`, what
  `KeyCredentialManager` uses). Hello gates every use and shows the Hello prompt with a message the caller
  can set. *Open and critical:* whether it can hold ECDSA P-256 on current Windows 11 builds, or only RSA
  (the documented default for `KeyCredential`). If RSA only, Route B cannot produce a `platform` check
  (the format is P-256) and would need a format decision.
- Route C (fallback if A and B fail): the Windows WebAuthn API (`webauthn.dll`,
  `WebAuthNAuthenticatorMakeCredential` / `GetAssertion`) with the platform authenticator, ES256, the
  challenge being the digest. That is a `webauthn` check, not `platform` (rp_id fixed per install, as in
  plan 3.1). The prompt shows the relying party, not a custom reason. Weaker for DEC-47's "prompt names
  the change", but no custom crypto.

**Unlock (the second wrap).** Windows has no key agreement with a Hello-gated key through CNG that is
simple to use. Two designs, both to be measured:
- With Route A and a key-agreement-capable TPM key (`BCRYPT_ECDH_P256_ALGORITHM` in the Platform provider):
  the same ECIES wrap as on macOS, `NCryptSecretAgreement` as the touch.
- With Route B (Hello sign): derive the wrap key from a **deterministic** Hello signature over a fixed
  random nonce kept in the header: `key = HKDF(signature)`; RSA PKCS#1 v1.5 signatures are
  deterministic, ECDSA ones are not, so this works only with RSA. The vault key is then AES-GCM sealed
  under that key. The protocol (`wrap.create`, `wrap`, `unwrap`) stays the same; `wrapped` is then not 126
  bytes of ECIES, so the version byte (`0x01` on macOS) tells the formats apart (`0x02`).

**Caller refusal.** `GetNamedPipeClientProcessId` is not needed (anonymous pipes). The parent check:
`NtQueryInformationProcess` for the parent id, `QueryFullProcessImageName` for the image path, and the
command line from the parent's PEB (or `WMI`) for the script path, with the same list file
(`allowed-callers.json`) next to the helper in `Program Files`, which a standard user cannot write. That
folder protection is what makes the list trustworthy on Windows; on macOS the list sits in the user's own
home unless the gateway is installed system-wide (O29).

**The prompt.** Hello shows its own text ("Making sure it's you") and the app name; a reason text is not
promised on every route (Route B and C: the app name; Route A: unknown). To be measured, as plan 12.1
line 26 says.

**Windows Hello absent or no TPM:** `hello` reports `secureHardware: false` and the password remains.

**Build and installer.** A new project beside `macos/` (`windows/`). The helper goes into the existing MSI
(`bundle/windows`, which IT signs) next to `allowed-callers.json`, written by the installer.

To measure on one Windows 11 machine with Hello (a person with the machine, about half a day):
Route A: does `NCryptSignHash` prompt Hello? Route B: can it hold P-256? Prompt wording and length. Remote
desktop. A machine with Hello but without a TPM 2.0. Behaviour when the PIN is used instead of the face.

---

## 9. Manual checks for the maintainer (each shows a touch prompt; none runs by itself)

Run everything from the root of the repository. Prepare once (about two minutes; builds the control plane, the
debug helper and the release helper `Suveren.app`):

```
pnpm -r build
cd packages/unlock-helper/macos && swift build && ./build-app.sh && cd ../../..
```

The scripts print PASS and FAIL lines and never a key. Nothing here touches a real gateway's data folder; the
keys of checks 1 to 3 exist only in memory during the run. Each `>>> TOUCH` line below is one Touch ID prompt.
The screen must be unlocked: the Secure Enclave refuses to make a key with a touch policy while the Mac is locked.

**Check 0 (the gateway's own code, four touches, start here).** Starts the release helper the way the gateway does
(hashes, list of callers, no password typed), turns unlock on in a throw-away vault, opens it again after a
"restart" with a touch, and signs a connector-login change and a set-up entry with the check key:
```
node packages/unlock-helper/macos/manual-check-gateway.mjs
```
Expect: PASS on every line and these prompt texts (placeholders, section 3.3): touch 1 and 2 "Suveren is trying to
unlock the Suveren vault"; touch 3 `… replace the login of "gmail"`; touch 4 "… set up the device "This
computer" with its own key". Touches 1 and 2 accept the Mac password under "Use Password…"; touches 3 and 4 are
Touch ID only. Write down: the name and icon in the prompt (an `.app` bundle: check 3), and whether the prompt
for touch 3 is clear to a person who does not know what a connector is.

**Check 1: unlock, the helper alone** (3 touches: the first succeeds, the second you cancel, the third succeeds
but the answer must be a refusal). Uses the debug build.
```
node packages/unlock-helper/macos/manual-check.mjs unlock --policy user-presence
```
Expect: PASS on all four lines. Look at: does it ask Touch ID first and the password only after a failure?

**Check 2: check key and text length** (1 touch each). The prompt text comes from the object; the only thing you
can vary is the device label, at most 64 characters in a real chain.
```
node packages/unlock-helper/macos/manual-check.mjs check --policy biometry-current-set
node packages/unlock-helper/macos/manual-check.mjs check --policy biometry-current-set --label "Work Mac in the office on the second floor, next to the printer room"
```
Expect PASS including "Node verifies the DER signature" and a printed line with the text the helper says it
showed. Write down: is the long text (the second command, 100 characters in the prompt) cut off, and where?
To also run hap-core's `verifyCheck` on that signature, add
`--hap-core node_modules/.pnpm/@humanagencyp+hap-core@0.14.0/node_modules/@humanagencyp/hap-core/dist/device-keys/index.mjs`.

**Check 3: the name and icon in the prompt** (the debug helper inside the same ad-hoc signed `Suveren.app`; 1 touch).
The release helper serves only the gateway, so the hand script uses a debug build in the same kind of bundle:
```
CONFIG=debug packages/unlock-helper/macos/build-app.sh packages/unlock-helper/macos/dist-debug
UNLOCK_HELPER=packages/unlock-helper/macos/dist-debug/Suveren.app/Contents/MacOS/suveren-unlock-helper node packages/unlock-helper/macos/manual-check.mjs check --policy user-presence
```
Expect: the prompt reads "Suveren is trying to add the device "This computer"" with or without an icon: write it down.
With `user-presence`, press **Use Password…** on one run and see whether the text is also shown on the password dialog.

**Check 4 (needs the whole gateway; the integration round): fingerprint change.** After a check key was made with
`biometry-current-set` (set-up with `checkKey: true`, section 12.3), enrol a test finger: expect `key_invalid` on the
next change and unlock by the password; the person then needs another granting device or the recovery code.

**Check 5 (needs the whole gateway): remote desktop and a second Mac.** Copy `vault.enc.json` of a throw-away
gateway to a second Mac: expect `key_invalid` on the unlock, not a prompt, and the password working.

## 10. Open points for the maintainer

1. **Apple Developer ID.** An Apple Developer Program membership (annual fee, held by a person or
   company) and a "Developer ID Application" certificate to sign the helper; credentials for `notarytool`
   (App Store Connect API key or app-specific password) as secrets in the release CI on a macOS runner.
   Who holds the account and where the certificate lives is yours to decide. Until then the helper is
   ad-hoc signed. It works on this Mac (measured); on other Macs it should, because npm does not
   quarantine the files it writes, but that was not run.
2. **Bare binary or `Suveren.app` bundle.** Decided for the bundle (ad hoc signed, no Developer ID, never offered
   as a download; the gateway hashes its files before every start). The bundle can be notarised and stapled later
   and shows a name and icon in the prompt; manual check 3 shows what the prompt does.
3. **`.userPresence` or biometry.** Recommendation in 6.1: wrap key `user-presence`, check key
   `biometry-current-set`. The cost of `biometry-current-set` is the recovery after a fingerprint change.
   Alternative for the check key: `biometry-any`.
4. **Helper-derived reason text** (section 5): built (3.3) for chain entries and connector-login changes. Still to
   do: the mandate grant's text when steps 13 and 14 freeze its object; and your wording for every text in 3.3 (O19).
5. **Intel Macs:** password only for now (the control plane reports `unsupported_arch`); a universal build was not tried.
6. **Windows:** a Windows machine with Hello to measure the routes in section 8; the language
   (C++ or Rust); an Authenticode certificate (the MSI is signed by IT today; the helper `.exe` inside
   needs its own signature or the same signing step) and SmartScreen reputation.
7. **Where `allowed-callers.json` is written and who can change it.** In the user's own folder it is only
   a guard against another program, not against the user's AI (section 4). A system-wide install with
   a root-owned list is the S1/S2 answer (O29).
8. **How the binary reaches the person:** inside the npm package (built on a macOS arm64 machine with
   `macos/build-app.sh`, then `node bundle/build.mjs --with-helper`); the gateway verifies the hashes of the
   bundle's files before every start. Open: the release script and CI do not run these two steps yet; a package
   built on Linux has no helper (and says so).
9. **Which release carries 5a** (the plan lists it as open) and the wording of the screens when the helper
   is missing, refuses, or the key is invalid (O19).

---

## 11. Tests and what they cover

| Where | Count | Covers |
|---|---|---|
| `macos` `swift test` (`./macos/test.sh`) | 20 | wrap/unwrap, wrong account, wrong key, tampering, digest rules, prompt text from the object (every template, a caller's `reason` refused, objects with no text refused, a label that cannot reshape the prompt), DER signature verified by CryptoKit, `interaction_required`, error codes, caller policy (pure), Secure Enclave keys made and refused without a touch (needs an unlocked screen) |
| `test/client.test.ts` | 17 | Node client against a **fake** helper (the real one needs a touch): framing, order, timeouts, helper death, bad answers, no way to pass prompt text |
| `test/real-helper.test.ts` | 11 (one needs `HAP_CORE_DEVICE_KEYS`) | the real helper binary (debug): software keys through the same code path (Swift and Node unwrap each other's wraps; the signature verifies in Node and in hap-core `verifyCheck`; the prompt text equals the Node reference on every template); Secure Enclave with prompts off; the caller refusal with real processes |
| `apps/control-plane` `platform.test.ts` | 38 | section 12, through the real routers, vault and page sessions. **SOFT** = the real Swift helper, debug build, `--backend software` (real process and protocol, no hardware, never a touch); **FAKE** = `test/fake-helper.mjs`, only where a touch must be cancelled, slow or lying |
| `apps/control-plane` `platform-release-helper.test.ts` | 3 (runs only with `SUVEREN_HELPER_BUILD`) | the RELEASE helper from `build-app.sh` started by the control plane's own code in a plain node process: hashes, list of callers, `hello`; a swapped binary; another program refused (exit 77). No touch |

Limits of this evidence, in plain words:

- **No touch was made.** Every test that signs or unwraps with real hardware stops at "a touch is needed".
  The signature format was checked with a P-256 software key through the same Handler code
  (`SoftwareBackend` replaces only the key and says it has secure hardware, Touch ID and presence; the signing, DER
  and verification code is the same). A Secure Enclave signature has the same type and encoding (CryptoKit's
  `ECDSASignature.derRepresentation`) and plan 12.1 line 26 verified one with Node.
- The software backend exists only in debug builds and in tests; a release build has no such flag (checked: the release
  binary contains neither `software-test` nor `--allow-any-caller`).
- The Authority Server is a stand-in over HTTP (`StubAs`, port 0) that checks what it is sent with hap-core `verifyChain`;
  the real Authority Server was not run here.
- Windows, Intel Macs, remote desktop, long prompt text, fingerprint change, a root-owned install folder: not run.

---

## 12. In the gateway (step 5a, behind `SUVEREN_DEVICE_KEYS=on`)

Files: `apps/control-plane/src/lib/{vault,platform-helper,platform-checks,change-confirmation,device-setup}.ts`,
`routes/{platform,device-setup,device-keys-mount}.ts`. With the switch off, or with no helper, nothing of this
runs and every path is the one of steps 5 and 6 (tests: `platform.test.ts`, "a vault that never turned it on",
"with the switch off none of it exists", "a computer with no usable helper").

### 12.1 Unlock by Touch ID: a third way to the vault key

`Vault` gets a third unseal provider (`PlatformUnsealProvider`, id `platform`) beside the account key and the
password, and a `platform` header in `vault.enc.json` (`PlatformHeader`: backend, policy, key blob, public key,
wrapped key, account id; nothing secret). The password header is never touched by it.

- `POST /auth/platform/enable` `{ password }` (page session, vault unlocked): needs the **unlock password** and,
  where this computer has a check key, a **fresh check** over an object whose prompt text the helper builds
  ("turn on Touch ID unlock for Suveren"); both are asked inside `Vault.enablePlatformUnlock`, where the write
  happens, not in the route. Then it opens the wrap once (the test unwrap of 6.2 step 3: a second touch) and only
  then writes the header in one atomic rename. Refused while a re-key is unfinished, while another step runs
  (`busy`), and when the vault key, the account or the header changed during the touches (`vault_changed`): the
  check and the write are one synchronous step after the last `await`. A computer without a check key has the
  password only (plan 7: the password stands in only there).
- `POST /auth/unlock/platform` (no session; the vault is locked): one touch, then the key must open the vault's
  verifier (`wrap_mismatch` otherwise: a stale wrap, another vault), the header must be unchanged, and the vault
  must still be locked; only then it is adopted. **Since DEC-92 (2026-11-20, the maintainer) it also opens a page session**
  (`PLATFORM_UNLOCK_OPENS_PAGE_SESSION = true`), with the limits of a password session; the risk below was accepted.
  Until then: **it opened the vault, not a page session**
  (`PLATFORM_UNLOCK_OPENS_PAGE_SESSION = false`, `routes/platform.ts`): after a restart the agents continue, and the
  page needs the unlock password. Why: a session is what an AI that drives the page uses, and "unlock the Suveren
  vault" is a prompt a person confirms without reading what the page does next; until the gateway runs apart from the
  AI's OS user (S1 to S3, O29) the session stays with the password. the maintainer decides; flip the constant only on that
  answer. On an already unlocked vault the route answers `already_unlocked` while the constant is false (with
  `true`, a touch there verifies the key and opens a session, like the password does). Its own attempt limiter, so
  spamming the prompt cannot lock the password out.
- `POST /auth/platform/disable` `{ password }`: the same password and fresh check ("turn off Touch ID unlock for
  Suveren"), then it **revokes by re-keying**: a fresh vault key, the password wrap of it (the old key kept as
  `pending`), no platform header, in one atomic write, then the control plane's files and the MCP server's stores are
  re-sealed exactly as the move to a password does (`/internal/rekey`, with the server's own report of which key its
  stores are sealed with; an interrupted run answers 202 and is finished at the next unlock). What this gives: no
  credential entered later, and nothing the MCP server holds, opens with the old key. What it does **not** give: a
  copy of `vault.enc.json` made while Touch ID unlock was on still holds its own key blob and opens *what was in it
  then*, with a touch on this computer; no re-key can change that, the old data was always sealed with the old key.
- `GET /auth/platform/status` (no session, starts nothing), `GET /auth/platform/capabilities` (session; starts the
  helper, no touch).
- A re-key of the vault key (`setPassword`) wraps the new key for the helper without a touch (6.4), in the same
  atomic write as the password wrap; with no helper to wrap with, the stale wrap is dropped. With a password
  already set the re-key cannot happen again, so this is for a damaged or hand-edited vault and for a later key
  rotation; it is tested by building that state.
- Unlock policy `user-presence` (Touch ID or the Mac password); a Mac without Touch ID still works.
- Any error but `user_cancelled` and `not_recognised` leaves the password path open (it always is).

### 12.1a Fingerprint change and orphans (the way out)

`key_invalid` on a check (a fingerprint change under `biometry-current-set`, or a blob that no longer loads) leaves the
person unable to confirm a connector-login change: the password is refused where a check key exists. **On this
computer** `POST /auth/platform/check-key/reset` `{ password, recoveryCode }` clears the stale check-key slot, only when
the helper has reported the key invalid since the last clear (a working key is never dropped this way), the password
is right and the recovery code derives the stored chain's root DID (hap-core `rootKeyFromRecoveryCode`). It is logged
(`[Control Plane] The check key of this computer was cleared …`, no secret), and connector-login changes then take the
password again (plan 7). **What it does not do:** the device chain still names the old check key, so this computer cannot
grant until a root-signed `set` replaces it. That entry needs the email-link session at the Authority Server (plan
3.2, DEC-15), which a program on 127.0.0.1 cannot present, so it is **not built**, not even as far as the boundary:
nothing could be tested against the real route, and a signed entry handed to a page that cannot submit it helps no one.
Chosen because it is the least that gets the person back to a working computer without lowering anything the plan
protects (clearing needs the password and the recovery code and a real `key_invalid`).

**Orphans.** The check-key slot is written before the chain in `complete`. A check key counts only while this computer's
chain is stored (`CheckKeyStore` is given the chain store): a slot without a chain, left by a crash between the two
writes or by a cancelled set-up, counts for nothing, so it can never lock the password out; a failed chain write takes
the slot back, and `cancel` clears it.

### 12.2 The helper process

`lib/platform-helper.ts`: found next to the package (`helper/Suveren.app`, hashes in `dist/control-plane/helper-manifest.json`;
`SUVEREN_HELPER_APP` names another build for the dev lane and a hand test, with its list beside it, which is weaker),
started on demand with an empty environment, kept for 60 s, ended when it dies or times out. Not available, with a
neutral reason, on: other platforms (`unsupported_platform`), Intel (`unsupported_arch`), a package with no helper
(`helper_not_installed`), a file that is not the one in the list (`helper_modified`), a start that fails or is
refused (`helper_failed`, `caller_refused`), no secure hardware (`no_secure_hardware`). The routes then answer
`helper_unavailable` with the reason and nothing else changes. If `NODE_OPTIONS` is set where the gateway runs,
the helper refuses it (section 4): the same answer.

### 12.3 This computer's check key

`device.check` of type `platform` (plan 3.1). Policy `biometry-current-set` (Touch ID only). It is made **at set-up**:
`POST /auth/device/setup/start` with `{ "checkKey": true }` makes the key in the helper, puts it into the `genesis`
entry (`device.check`) and adds the device's check over the entry hash (one touch; the prompt says "set up the
device …"). The entry is verified with hap-core before the recovery code is handed out; a cancelled or lying touch ends
the set-up with nothing kept or sent. The key blob is kept with the started set-up, sealed, and moves into the
vault slot `deviceCheckKey` in the same step that stores the chain (a lock or restart in between is survived).

**Why in `genesis` and not in a later `set` entry (read this).** Plan 3.2: a `set` that gives a device its first
check key is signed by a granting device or by the root key, and "a device cannot give itself a check key with its
own signature alone". Until stage B no device has a check key (plan 23.3), so the first `set` is root-signed:
the recovery code **and** an email-link session of the account at the Authority Server (`POST /api/devices/chain`
answers `EMAIL_LINK_REQUIRED` otherwise; DEC-15). The email-link session is a browser cookie at suveren.ai. The
plan does not say how a gateway (a program on 127.0.0.1) presents it, so a gateway-side root-signed `set` is **not
built**. Plan 23.3 settles the case another way: stage-B accounts are "set up fresh", "so no chain needs a check key
added afterwards", and 3.2 allows a check key in `genesis` ("plus `device`'s check if `device.check` is set"). An
account set up by step 6 without a check key therefore has none and cannot get one from the gateway; replacing a
check key later (fingerprint change, `key_invalid`) needs another granting device or the recovery code, which are
stage C and D or the open question above.

### 12.4 The per-change confirmation, computer path

A computer with a check key (the slot exists; an unreadable slot counts as yes) no longer accepts the password for a
connector-login replace or remove (`POST /auth/confirm` answers `check_key_required`). `POST /auth/confirm/request`
builds the change request as before; `POST /auth/confirm/check` (page session, one prompt at a time) has the helper
sign the SHA-256 of the canonical JSON of that request (the object, which the helper reads to build `replace the
login of "<name>"` or `remove the login of "<name>"`; the request has a sixth member, `name`, inside the signed
object and bound again in `change_hash`), verifies the signature with hap-core against the
stored public key, and only then confirms the request. The gate that carries the change out
(`ChangeConfirmations.consume`) also refuses a confirmation made by the password while a check key exists, so a
password confirmation given before the key existed cannot carry a change out afterwards. One change, one request id,
once, from the page session that asked, within 300 seconds, as for the password path.

### 12.5 What is not built

- A root-signed `set` from the gateway (12.3), and replacing the check key in the chain after `key_invalid` (12.1a: only clearing it on this computer).
- The caller check and the hash list as protection against a program of the same user (they add nothing there; section 4).
- The check on mandate grants, `add`, `remove`, passkey registration (steps 13, 14): the helper can sign any chain
  entry (the texts exist), but no route asks it to.
- Windows; Intel Macs; notarisation; a release script that runs `build-app.sh` and `--with-helper`.
- Nothing in the UI (no screens; wording is O19).
