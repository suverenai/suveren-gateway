# S1: the gateway under its own operating-system user

Status: design plus a small macOS experiment. Nothing here is built into the gateway. Written
2026-11-18 for plan section 21 (S1 to S3, O29, O30) and DEC-65, DEC-66.

Words used here: the **person's user** is the OS account the person and their AI app run
under. The **daemon** is the gateway process under its own account. The **agent** is a small
signed program in the person's login session that shows the Touch ID or Windows Hello prompt
for the daemon. The **blob** is the encrypted key handle that only the Secure Enclave (or the
TPM) can use.

## 0. The answer in one page

1. Today the gateway, its vault, its data folder, its config file and its code all belong to the
   person's user. An AI that runs as that user can read, change and patch all of them, and can
   start the same Touch ID helper the gateway starts. S1 moves all of that to another account.
2. **Touch ID cannot be shown by the daemon.** A prompt needs a graphical login session of
   the person; a system service has none (macOS and Windows alike). So the daemon asks an agent
   in the person's session to show it. Everything hard in S1 is how the daemon knows that the
   thing answering is the agent and not the AI.
3. **The answer does not have to be authenticated by the channel.** It is authenticated by
   what it contains. The daemon keeps the key blob (the AI cannot read it) and a fresh
   challenge. Only a touch on the Secure Enclave produces a valid answer. An AI that cannot
   read the blob cannot make one. The channel only has to protect the one secret that travels
   (the vault key after an unlock), and for that it checks which program is calling.
4. **What the AI can still do** (it is the same user): start a lookalike prompt that unlocks
   nothing, launch the real agent so that a prompt appears, click in the agent if it has screen
   control, connect to the open ports, and reach the MCP endpoint (which is meant). It cannot
   read or change the daemon's memory, vault, data, config or code, cannot stop it, and cannot
   obtain a session or an unlock from the agent.
5. **S1 is only real together with a protected install folder** (the core of S2). If the
   daemon runs code that the person's user can change, the AI changes the code and then runs as
   the daemon. So S1 includes the root-owned code folder; S2's signature check can follow.
6. **Not verified here:** everything that needs a second account or a touch. Section 11 lists the
   manual steps for the maintainer. What was run: the peer-identity check of section 4.2, on
   one account, with no prompt.

## 1. Where it stands today (read from this worktree)

| Fact | Where | Consequence for S1 |
|---|---|---|
| Autostart is per user, no admin: macOS LaunchAgent, Windows Task Scheduler logon task (InteractiveToken), Linux systemd user unit | `bundle/lib/autostart-templates.mjs`, `suveren-gateway service install` | S1 needs system-level service definitions: LaunchDaemon, Windows service, systemd system unit |
| Data folder `~/.suveren` or `SUVEREN_DATA_DIR`; pid file, log, `config.json` (AS address, TLS pin, CA file, proxy) inside it | `bundle/bin/suveren-gateway.js`, `bundle/lib/config.mjs` | The person's user can edit `config.json` today (point the gateway to another Authority Server, switch off the pin). Under S1 only an admin can |
| The CLI (`status`, `stop`, `config`) reads the pid file and config directly and kills by pid | `suveren-gateway.js` | Under S1 the CLI becomes a thin client: status over `/health`, stop and config through an admin step |
| Control plane (UI, `/api`, `/internal`) on 127.0.0.1, MCP server on 127.0.0.1, Host check, no CORS, internal calls need a random shared secret generated at start | `docs/security.md` | Unchanged. Loopback ports are reachable by every account, which the design needs: the AI app uses `http://localhost:<mcp-port>/mcp` |
| The MCP endpoint has no login by default (token optional) | `docs/security.md`, "Agent Port" | The AI needs no file and no secret to reach it. S1 keeps that |
| Windows MSI is per user, no admin, in `%LOCALAPPDATA%\Programs\Suveren`, IT signs it, Intune "user context" | `bundle/windows/wix/Product.wxs` | Needs a per-machine variant (section 6) |
| Linux autostart "has never been run" | plan section 21 | The Linux unit below is untested design |
| The Touch ID helper's caller check "is worth nothing against a program of the same user" | Touch ID branch, `packages/unlock-helper/DESIGN.md`, section 4 | This is the gap S1 closes. Its real fix is named there: install-time list in a folder the user cannot write, and the gateway as its own user |

The connectors (downstream MCP servers) are started by the gateway with `npx` and a minimal
environment. Under S1 they run as the daemon's user too, so the connector logins stay out of
the AI's reach. That is the main benefit.

## 2. macOS

### 2.1 The accounts and the service

- A hidden role account `_suveren` (no login shell, no home in `/Users`, no group `admin`),
  created at install time by the installer package. Its user and group id are chosen at install
  time from the free ids in 200 to 399 (on the machine used for this design 87 of them were in
  use up to 308, so never hard-code one).
- A LaunchDaemon `/Library/LaunchDaemons/ai.suveren.gateway.plist`: `UserName _suveren`,
  `RunAtLoad`, `KeepAlive`, logs to `/var/log/suveren/`. The daemon starts at boot, before any
  login, and comes up locked, like today.
- Folders:

  | Path | Owner, mode | Holds |
  |---|---|---|
  | `/usr/local/libexec/suveren/<version>/` and the symlink `current` | `root:wheel`, 755 | gateway code, a Node binary of its own (the person's nvm or Homebrew Node is writable by the person), the signed broker, the signed agent |
  | `/var/lib/suveren/` | `_suveren`, 700 | data folder (`SUVEREN_DATA_DIR`), vault, config, connector caches, the home of the connectors |
  | `/var/run/suveren/` | `_suveren`, 755 | the agent socket (section 4) |

  A root-owned code folder is not optional (section 0, point 5).
- Ports: unchanged (3400 and 3430 by default, or what `install-settings` says). The service
  definition reads them from a root-owned settings file instead of the person's environment.

### 2.2 Touch ID when the gateway is another user

Finding, from how the platform works and from the earlier helper's measurements. Two things
are not run here and are manual step M2:

- Touch ID and the system prompt belong to the **graphical session of the logged-in person**
  (LocalAuthentication needs a window server session, Aqua). A LaunchDaemon, whatever its
  user, is in the system session. It can neither show the prompt nor receive a touch.
- A Secure Enclave key made with CryptoKit is a **blob that is bound to the machine, not to
  a user or a program** (measured, Touch ID branch design notes: a blob made by one ad-hoc signed
  binary opened in another binary). Whoever holds the blob can ask the Secure Enclave to use it;
  the access control on the key then demands the touch.

Options:

| Option | How | Verdict |
|---|---|---|
| A. Agent in the person's session, blob held by the daemon | The agent runs in the login session, connects to the daemon, receives blob and challenge for each prompt, shows the prompt, returns the result. Section 3 | **Recommended.** Works with what the Touch ID helper already does; the daemon keeps the secrets |
| B. Daemon asks the OS for a user session (`launchctl asuser`) | Needs root; a non-root `_suveren` cannot | No |
| C. Daemon runs as a LaunchAgent of the person's user again | No S1 | No, that is today |
| D. Login keychain item with an access list naming the agent | The AI, same user, can ask for keychain items too; access is by code identity and prompts on mismatch | Weaker than A, no gain |
| E. The browser does the touch (WebAuthn platform authenticator) | A passkey in the browser (Safari or Chrome) gives a signature after a touch, with no native code; the daemon verifies it | **Worth keeping as a fallback for the page session**: no agent, no installer signing. Cannot unwrap the vault key. Not in the plan today (the plan's O27 looks at a passkey on the local address) |

So the Secure Enclave work (`unwrap`, `check.sign`) moves from "the gateway's child process"
to "the agent, on request of the daemon". The Touch ID helper's Swift core (`UnlockCore`) is
reused; the file `allowed-callers.json` and the parent check are replaced by section 4.

### 2.3 How the person's browser reaches the page

Unchanged: `http://localhost:<port>` over loopback. The Host check and the lack of CORS stay.
What changes is how a page session starts (section 3.2): not by any request to the port, but by
the agent opening the browser with a one-time link after a touch. The password path (computers
without Touch ID) stays an ordinary request to the page.

A new risk appears that exists today too but gets sharper: **a program of the person's user can
take a loopback port while the daemon is down** and show a fake page or a fake MCP endpoint. A
daemon that starts at boot makes this rare. The fix is socket activation: launchd owns the two
listening sockets (`Sockets` in the plist) and hands them to the daemon, so the port is never
free. Node can listen on an inherited descriptor, so the broker passes it (design item P2).

### 2.4 How the AI app reaches the MCP endpoint

Exactly as today: `http://localhost:<mcp-port>/mcp` (or `/sse`). Reading the endpoint needs no
file of the daemon; the daemon accepts the connection and acts as the signed-in person's agent
under the live mandates. Nothing the AI app needs lives in the data folder. Claude Desktop,
Claude Code, ChatGPT connectors and the Docker sandbox of `docs/sandbox.md` keep their config.
If `SUVEREN_MCP_TOKEN` is set, the token is shown to the person at setup, not read from a file.

### 2.5 Install, update, uninstall

- **Install:** a notarised `Suveren.pkg` (Developer ID installer), run with an admin password
  (or pushed by the company's device management). Its postinstall script: creates `_suveren`, lays out the
  folders, copies the files, writes the plist, `launchctl bootstrap system ...`, registers the
  agent for every user (`/Library/LaunchAgents/ai.suveren.agent.plist`), and, if `~/.suveren`
  exists, offers the migration (section 8).
- **npm path:** `npm i -g @suveren/gateway` keeps working as the home-folder install. The new
  step is `sudo suveren-gateway install --system`: it copies the package out of the npm folder
  into the root-owned folder, checks the file hashes it ships with, and does what the pkg does.
  Plain npm cannot be the protected install, because the files stay in a folder the person's
  user owns.
- **Update:** `sudo suveren-gateway update --system` (or a new pkg): unpack into
  `/usr/local/libexec/suveren/<new-version>/`, verify, flip `current`, `launchctl kickstart -k`.
  The daemon comes up locked; the person unlocks with a touch. The daemon never updates its own
  code: a daemon that can rewrite its code turns one break-in into a permanent one. Auto-update
  would need a separate root-owned updater that verifies a signature; later, not S1.
- **Uninstall:** `sudo suveren-gateway uninstall --system`: `launchctl bootout`, remove plist,
  agent, code folder, `/var/lib/suveren` only after a question (it holds the vault), then the
  account. The person's own data is untouched.

### 2.6 What the person's own user can still do

| Action | Result | Why |
|---|---|---|
| Kill the daemon | Refused (not their process). With an admin password it works; launchd restarts it | `KeepAlive`, other uid |
| Read its memory, attach a debugger | Refused (other uid; the agent is also hardened) | Not run here: M5 |
| Read the vault, data, config; change code | Refused | file modes |
| Read the port | **Yes, and it must.** Anyone can connect to loopback | By design; protection is the Host check, no CORS, the session |
| Squat the port while the daemon is down | Possible without socket activation | P2 |
| Connect to the agent socket | Yes (mode 666), but the daemon refuses any peer that is not the signed agent | section 4.2, measured |
| Start the real agent itself | Yes. It then shows a prompt only on the daemon's request (it holds no secret and takes no commands) | the agent is stateless |
| Click in the agent's window | Yes, if the AI has screen control or Accessibility rights | honest limit; the same limit as the phone approval |
| Pose as a lookalike prompt | Yes. It shows its own name in the system prompt and unlocks nothing, because it holds no blob | section 3 |
| Use `sudo` | If the person's user has passwordless sudo, S1 is void. S3 checks for it | section 7 |

## 3. The prompt flow

### 3.1 Unlock after a restart

1. The daemon starts locked. The agent (in the person's session) shows a menu-bar icon
   "Suveren is locked". The person clicks it (or the page's button opens the agent through its URL
   scheme `suveren://unlock`; either way the click is the person's, the AI can only send the
   same request, which is the same as launching the agent).
2. The agent opens an authenticated connection to the daemon (section 4) and asks "unlock".
3. The daemon answers with the **blob**, the **wrapped vault key** and a **fresh 32-byte challenge**
   bound to the purpose "unlock" and to this connection.
4. The agent asks the Secure Enclave to unwrap (touch; the prompt says what for, built by the
   agent from the purpose, never from text of the daemon or anything else), and signs the
   challenge with the check key (second touch avoided by using one key object for both: design
   detail for step 5a).
5. The agent returns the vault key (or the signature) to the daemon. The daemon checks the
   signature against the public key it registered at set-up, then opens the vault.

Why a same-user program cannot forge this: step 3 only happens on a connection the daemon
authenticated (section 4). A program without the blob cannot unwrap anything. A program that
makes its own Secure Enclave key makes a signature the daemon rejects (wrong key). The touch
cannot be given by software.

### 3.2 Page session (DEC-66: Touch ID alone opens the page)

The page session must start without any request an AI could also send:

1. The person clicks "Open Suveren" in the agent.
2. Same exchange as 3.1 with purpose "page session"; the touch is the proof.
3. The daemon makes a **one-time code** (valid 15 seconds, used once) and sends it to the agent
   over the authenticated connection.
4. The agent opens the default browser at `http://localhost:<port>/session?code=...`. The
   daemon answers with `Set-Cookie` (HttpOnly, SameSite=Strict) and a redirect to the page.

The AI never receives the code: it is not in an HTTP answer to anyone but the browser. It would
have to read the browser's address bar or the OS's open-URL events, in 15 seconds, before the
browser uses it.

The page must not have a "Touch ID" button that makes an HTTP request which then triggers a
prompt: that is exactly the trigger an AI can send. A button may only hand over to the agent.

### 3.3 Sensitive changes (the check key, DEC-47)

Same shape: the daemon builds the object, the agent builds the prompt text from the object and
signs its hash after a touch. The object must be shown to the agent by the daemon, not by the page.

## 4. The authenticated channel

### 4.1 What it has to do

- The daemon sends a blob, a challenge and (after an unlock) receives a vault key. Both ends
  must know the other is real.
- The agent must know it talks to the daemon, or a program of the person's user could stand in
  for the daemon and collect an unwrapped vault key. This direction is easy: the agent connects
  to a socket in `/var/run/suveren/`, which only root and `_suveren` can create files in, and
  checks that the other end's user id is `_suveren`. A program of the person's user cannot be it.
- The daemon must know the other end is the genuine, unmodified agent. This is the hard part:
  the AI has the same user id as the agent.

### 4.2 Options, with honest limits

| Option | What proves the agent | Limit |
|---|---|---|
| **1. Unix socket + code-signing check of the peer** (macOS) | The daemon (through its small signed broker) reads the peer's audit token from the kernel (`LOCAL_PEERTOKEN`) and asks the system whether that code satisfies a requirement (`Security.framework`, `SecCodeCopyGuestWithAttributes`). A hardened-runtime build cannot be injected by `DYLD_INSERT_LIBRARIES` and, without the debug entitlement, cannot be attached to by the same user | The genuine agent can be started by the AI. It then holds no secrets and answers only prompts for requests the daemon sends. Needs a stable signing identity (Developer ID team id, or the cdhash of the build with the installer updating it as root) |
| **2. XPC Mach service of the daemon** (macOS 13 and later) | The same check, done by the system (`setCodeSigningRequirement`) | Same limit; needs native code in the daemon, so a Swift broker either way. Slightly less code than option 1 |
| **3. Prompt shows what it is for + the person must match a short code on the page** | A human check, not a program check | An AI with screen control reads both. Useful against distraction, not against a controlling AI |
| **4. Secret in a file or the keychain that only the agent reads** | Possession | The AI is the same user: a file is readable, a keychain item prompts or can be read by an app with the same signature. Rejected |
| **5. Result authenticated by the touch itself** (the daemon accepts only a Secure Enclave signature over its fresh challenge) | The key that needs a fingerprint | Does not need a channel at all for the signature. Does not protect the one secret that travels (the vault key after unwrap) |
| **6. Passkey in the browser for the page session** | The authenticator in the browser | No vault unwrap; the browser is also reachable by a screen-controlling AI |

Recommendation: **5 for correctness, 1 for the secret in transit, 3 as a human check, 6 as the
fallback where the agent is not installed.** Option 2 later, if the broker becomes small enough
to drop.

### 4.3 What was measured (macOS, one account, no prompt)

`prototype/peer-check/` (Swift, 0 packages, ad-hoc signed). A server over a Unix socket checks
the peer's code through the kernel's audit token. Results on macOS 26.6.2, in
`prototype/peer-check/results-2026-11-18.txt`:

| Peer | Requirement: identifier only | Requirement: identifier + cdhash |
|---|---|---|
| the genuine hardened agent | accepted | accepted |
| a copy re-signed by the "attacker" with the same identifier | **accepted** | refused |
| a different signed program | refused | refused |
| `python3` (an AI's script) | refused | refused |
| the genuine binary with one code byte changed | killed by the system before it runs | same |

And: `DYLD_INSERT_LIBRARIES` loads the attacker's library into an ordinary build and is
**ignored** by a hardened-runtime build.

Reading: the check tells genuine from other programs, including a script of the same user. The
identifier alone is not enough with ad-hoc signatures; production needs the Developer ID team id
(or the cdhash). What it does not tell: whether the person or the AI started the genuine
agent, which is why the agent must hold nothing and the daemon must hold the blob.

### 4.4 What the experiment cannot show

- That the check works across accounts. The kernel call is the same (`LOCAL_PEERTOKEN` is the
  connecting process, whoever owns the socket), but this was not run (M3).
- That a same-user program cannot attach to the hardened agent (`task_for_pid`, `lldb`). The
  tool can prompt for developer rights, so it was not run (M5).
- Touch ID itself. It was not run, on purpose.
- That the prompt of a lookalike program is distinguishable. The system prompt names the
  requesting program (measured earlier on the Touch ID branch), but the AI can name its program
  "Suveren". It still unlocks nothing.

## 5. Windows

### 5.1 Service

A Windows service under a **virtual service account** (`NT SERVICE\SuverenGateway`) or a local
account, started automatically at boot, restart on failure. Code in `C:\Program Files\Suveren\`
(admin-writable only). Data in `C:\ProgramData\Suveren\` with a DACL that gives access to the
service account and SYSTEM only (no `Users`). Ports, MCP and page as macOS. The service wrapper
needs a small native piece or a node service wrapper; both are new code (WiX `ServiceInstall`
can register the service).

### 5.2 Windows Hello from a service

Same problem as macOS, from a different cause: services run in session 0 with no desktop; the
Hello prompt (`UserConsentVerifier`, `KeyCredentialManager`, WebAuthn) needs the person's
interactive session. So the same agent design: a signed tray program started at logon (a
Task Scheduler logon task or a Run entry for every user), talking to the service over a named
pipe.

- The pipe is created by the service with a DACL for `Authenticated Users`. The service checks
  the client with `GetNamedPipeClientProcessId`, then the image path (must lie under
  `Program Files`, where the person cannot write) and its Authenticode signature
  (`WinVerifyTrust`, signer = Suveren's certificate).
- **Weaker than macOS**: the AI runs as the same user, and a same-user program can normally
  write into another process of that user (`WriteProcessMemory`) and start threads in it. macOS
  hardened runtime stops that; Windows has no equivalent for ordinary signed programs (protected
  processes need Microsoft's anti-malware program). Possible mitigations, **not tried**: start
  the agent with a restrictive process DACL and an `OWNER RIGHTS` entry that takes the owner's
  implicit rights away; process mitigation policies (block non-Microsoft DLLs, dynamic code
  off). Treat Windows as "raises the bar, does not close it" until M-W1 is run.
- The Hello key lives in the person's profile (Passport key storage), so the same user can open
  the key handle. As on macOS, the AI lacks the ciphertext (kept by the service) and the
  daemon's challenge, so an unlock stays out of its reach. The prompt trigger is as on macOS.
- Windows Hello for Business versus a local PIN: Hello without a sensor is a PIN. The daemon
  should record which was used, as the plan already does for the passkey flags.

### 5.3 Install and IT

The present MSI is per user, no admin, "user context" in Intune (`Product.wxs`). S1 needs a
**second MSI, per machine** (admin or SYSTEM context): service, program files, ProgramData,
logon task for the agent for all users, the same Suveren certificate that IT's certificate
re-signs today. IT keeps its own signing flow (`build-signed.ps1`). The per-user MSI stays for
people without admin rights. Update = a new per-machine MSI (major upgrade; the service stops,
files replace, the service starts, locked).

## 6. Linux

- `useradd --system --no-create-home --shell /usr/sbin/nologin suveren`; code in
  `/opt/suveren/<version>/` (`root:root`, 755), data in `/var/lib/suveren` (`StateDirectory=suveren`,
  mode 700).
- Unit `/etc/systemd/system/suveren-gateway.service`: `User=suveren`, `Restart=always`,
  `NoNewPrivileges=yes`, `ProtectHome=yes`, `ProtectSystem=strict`, `PrivateTmp=yes`,
  `ReadWritePaths=/var/lib/suveren`, `StateDirectory=suveren`, `ExecStart=/opt/suveren/current/node ...`.
  Starts at boot, without `loginctl enable-linger` (the user-unit's open problem today).
  Optional `suveren-gateway.socket` for the two ports (the same squat protection as launchd).
- A same-user program cannot read `/proc/<pid>/mem` (other uid; with the default Yama setting it
  cannot even trace its own children's siblings), nor the data folder, nor stop the unit without
  polkit rights.
- No Touch ID or Hello on Linux today, so there is no agent: the unlock stays the password.
  The page session stays the password session. S1 still delivers the main benefit there (the
  AI cannot read the vault, the config, the connector logins, or patch the code).
- Packaging: `.deb` and `.rpm` with the above in a postinstall script; the npm path
  `sudo suveren-gateway install --system` does the same. Updates: the package manager.

## 7. The setup check for S3

`suveren-gateway check`, run by the person at a terminal as their own user. It tests from
outside, by doing, not by reading a claim (option A of O30). Each line is one real attempt:

| Test | Pass |
|---|---|
| Who is the gateway: look the listening process up by port, read its owner | owner is another account, not this user |
| Read `<data folder>/vault.enc.json`, list the folder | permission denied |
| Write to the code folder and to a copy of the config | permission denied |
| Read the gateway's process memory or environment (`ps eww`, `/proc`) | denied or empty |
| Is any code of the gateway under a folder this user can write (walks the install) | none |
| Does this user have passwordless `sudo` (`sudo -n -l`, `net localgroup administrators` and token elevation) | no |
| Connect to the agent socket or pipe as this check program (unsigned) | refused by the daemon |
| The signature of the installed files verifies (S2) | yes |
| MCP port answers; page port answers with the expected Host check | yes |
| Where S1 is not installed: name each open path (data folder, config, port) | listed |

It reports "open" for anything it could reach and never "confined" because the AI said so; the
AI app's sandbox settings (option B of O30) come as a hint only. The check cannot prove an AI
app is boxed in; it proves what a program of this user can reach. The result is for the person
and, if IT wants, for a report file the person chooses to hand over.

## 8. Moving an existing install

Data in `~/.suveren` becomes `/var/lib/suveren`. The vault file is encrypted, so a copy is safe
to move; the old copy must be deleted, and while it existed an AI could have read it. For the
connector logins the person decides whether to renew them (the plan's section 21 says so for
any previously unconfined set-up). Folders the connectors need on the person's side (a shared
folder for the document connector, signed off but not built) must be granted to the daemon's
account with an ACL; the daemon cannot read the person's home. This is a restriction of S1
and belongs in the setup text.

## 9. Effort (judgement, working days of AI building including suveren-e2e tests)

The plan's 10 to 15 days cover installers and service definitions. They do not include the
prompt channel, which belongs to the Touch ID step but changes shape here. My split:

| Part | Days |
|---|---|
| macOS: pkg, plist, accounts, root-owned code folder, broker with peer check, agent with menu bar and session link, migration | 7 to 10 |
| Linux: unit, packages, install command, migration | 2 to 3 |
| Windows: per-machine MSI with service, DACLs, agent, pipe with Authenticode check, process-hardening trial | 6 to 9 |
| Shared: thin CLI, socket activation, `check` program (S3 is 3 to 5 in the plan, counted separately), documents, e2e with a second account on real machines | 3 to 4 |
| **S1 total** | **18 to 26**, of which about 6 to 10 would otherwise be in step 5a (caller check, helper start) |

Real-machine tests (second account, a second login, the real prompt, an IT-signed MSI) need
the maintainer's time: about one day per platform.

## 10. Decisions for the maintainer

| # | Decision | Recommendation |
|---|---|---|
| D1 | The installer default (O29, already decided for S1 as a precondition of Touch ID by DEC-66) | Own user where admin rights exist; the home-folder install stays for people without admin, **without Touch ID**, with the password |
| D2 | Make the root-owned code folder part of S1 | Yes. S1 is void without it; S2's signature check follows |
| D3 | Apple Developer ID and notarisation for the pkg, the broker, the agent; and an Authenticode certificate of our own for the agent and the per-machine MSI | Yes, this is the identity the channel relies on. Fallback while waiting: cdhash pin written by the installer |
| D4 | The page session starts only from the agent (3.2), never from a button that makes a request | Yes |
| D5 | Agent form: menu-bar program, auto-started for every user | Yes; the smallest one that shows state and opens the page |
| D6 | Socket activation for the ports (squat protection) | Yes, as a second increment (P2) |
| D7 | Updates: an admin step or a package, no self-update of a daemon with its own rights | Yes. Auto-update later, by a separate root-owned updater that verifies a signature |
| D8 | Order of platforms | macOS first (Touch ID needs it), Linux second, Windows third after the process-hardening trial; Windows Hello waits for it |
| D9 | The passkey in the browser as a fallback for the page session (option E) | Decide with O27; it removes the agent from the page path but cannot unwrap the vault |
| D10 | A per-machine Windows MSI beside the per-user one | Yes |
| D11 | What S3 does with the AI app's sandbox settings (O30) | A as decided; B as a hint |

## 11. Manual steps for the maintainer (need an admin; not run)

Use a throwaway test user and a scratch folder; none of these use the ports 3400 to 3730 or
4100 to 4700.

**M1. A test account.** Pick a free id first: `dscl . -list /Users UniqueID | awk '$2>=300 && $2<400'`.
Then, with `ID` a free number: `sudo dscl . -create /Users/_suverentest`; set `UserShell /usr/bin/false`,
`UniqueID ID`, `PrimaryGroupID ID` (create group `_suverentest` with `PrimaryGroupID ID` first),
`NFSHomeDirectory /var/empty`, `IsHidden 1`. Remove with `sudo dscl . -delete /Users/_suverentest`.

**M2. Touch ID from a daemon user.** Run the Touch ID branch's helper as the test account:
`sudo -u _suverentest <helper> ` with a `hello` request, then a `check.sign` of a test object.
Expected: `hello` answers; `unwrap`/`check.sign` fail with no interactive session
(`interaction_required`, `no_biometry` or a hang). This is the one fact the design leans on
and I could not run.

**M3. The peer check across accounts.** As admin: `sudo mkdir -p /var/run/suverentest && sudo chown _suverentest /var/run/suverentest`.
Run `peer-check serve` as `sudo -u _suverentest` with the socket in that folder, `chmod 666`
the socket, and connect with `peer-check connect` (genuine, hardened) and with the experiment's
other cases as the person. Expected: the same table as section 4.3. (The experiment script
`prototype/peer-check/run-experiment.sh` builds and signs every binary it needs.)

**M4. Port squat.** A LaunchDaemon plist with a `Sockets` entry on an unused high port and a
trivial server that exits after a minute: while it is not running, as the person try to bind
that port (expect failure, launchd holds it).

**M5. Debugger attach.** As the person, against the hardened `agent` of the experiment, run
`lldb -p <pid>` and `DevToolsSecurity -status`. Expected: refused. (May ask for developer
rights; that is why it was not run.)

**M-W1 (Windows).** On a test machine: start the agent with an `OWNER RIGHTS` ACE and a
mitigation policy, then try `WriteProcessMemory` into it as the same user.

## 12. What was not verified

Everything that needs a second account, a touch, an installer, Windows or Linux. The only
facts run here are in section 4.3. Nothing was changed on the machine: the experiment builds
and signs ad-hoc binaries in a scratch folder, binds one Unix socket there, and uses no port.

## 13. Build plan, macOS first (DEC-74, 2026-11-19)

Branch `feat/s1-own-user`, worktree `temp/ws-gw-s1-build`, based on gateway main. S1 does
not depend on the device-keys stack, except increment 5, which reuses the Touch ID helper's
`UnlockCore` (Touch ID branch). Increments 1 to 4 and 6 to 7 stand alone. Each is one PR.

Test kinds: **unit** = vitest in `apps/control-plane/src/__tests__`, no admin, no machine
change. **scratch** = the real code run against a scratch folder as prefix, as the normal
user. **real** = needs a second account, root, launchd or a touch: run in a macOS VM (UTM,
snapshot before and after) or by the maintainer on the Mac, using `sudo` steps the plan
prints. Nothing in `real` runs on the maintainer's live lane; test ports are outside
3400 to 3730 and 4100 to 4700.

| # | Increment | Done when | Tested how |
|---|---|---|---|
| 1 | **The plan as data.** `bundle/lib/system-install-mac.mjs`: layout, free-id picker, `dscl` steps, daemon plist, root-owned settings file, file manifest with hashes, ordered install plan, `install --system --dry-run` (prints, changes nothing) | The dry run on a real Mac prints a plan whose id is free, whose code and settings belong to root, whose data belongs to `_suveren`, and the plist contains no path in a user home and no secret | unit (builders, ordering, ownership rules, XML escaping, manifest diff); scratch (dry run prints, exit codes) |
| 2 | **The executor.** `sudo suveren-gateway install --system`, `update --system`, `uninstall --system` run the plan: only listed program calls, refuse when not root or not admin, copy then compare hashes, flip `current` last, uninstall asks before removing data. A `--prefix` option lays the tree out in a scratch folder without root and without account or launchd steps | In a scratch prefix the tree matches the plan byte for byte; a changed byte after the copy aborts before `current` flips; uninstall removes exactly what install made | scratch as normal user (tree, modes simulated by a recording runner, abort on hash mismatch). **real:** VM, a fresh macOS, run install, `id _suveren`, `ls -le /usr/local/libexec/suveren`, `launchctl print system/ai.suveren.gateway`, uninstall leaves no account, no plist, no folder |
| 3 | **The gateway runs as the account.** Data folder and config under `/var/lib/suveren`; the CLI becomes thin when the data folder is not the caller's: `status` over `/health`, `stop`, `config` and `logs` give a clear "needs admin" message instead of reading files; `service` refuses to install a second login service next to the system one | As the person's user: `curl localhost:3430/mcp` answers; `cat /var/lib/suveren/*` and writing to the code folder are refused; `kill` of the daemon is refused; the daemon comes up locked after `launchctl kickstart -k` | unit (CLI choice logic, refusal texts). **real (VM, two accounts):** the table in section 2.6, row by row, as the person's user; the daemon's connectors start with the minimal PATH (the one thing that can break: `npx` and the node of the code folder) |
| 4 | **The agent channel without the touch.** Small signed broker (Swift, from `prototype/peer-check`): socket in `/var/run/suveren` owned by the account, peer check by audit token, installer writes the cdhash pin file (root-owned, no Developer ID); the agent connects, checks the daemon's uid, asks `hello`; the daemon answers only a peer that passes | A genuine agent gets `hello`; the same binary re-signed, `python3`, and a changed byte are refused; the agent refuses a socket that is not the account's | scratch (the Swift tool's own experiment script, extended: cross-check against the pin file); **real (VM):** M3 and M5 of section 11 with the real daemon account |
| 5 | **Unlock and page session through the agent** (needs the Touch ID branch). Agent asks the daemon for blob, wrapped key and challenge; shows the prompt; returns the answer; the daemon issues a one-time page link only to the agent; no HTTP route starts a prompt | Touch ID alone opens the vault after a restart and opens the page; a request an AI can send never produces a prompt or a session | **real, by hand with a finger:** M2, then unlock, then page link, then a `curl` that tries to start a session (refused). Cannot be automated |
| 6 | **Menu-bar agent, per user.** `/Library/LaunchAgents/ai.suveren.agent.plist` for every user, state icon (locked, open, not installed), "Open Suveren" | A second login on the same Mac gets the icon without any step | **real (VM, two logins)** |
| 7 | **The pkg and the migration.** `Suveren.pkg` built from the plan, postinstall runs the executor; `~/.suveren` moves to `/var/lib/suveren` after a question, old copy deleted; update by new pkg; socket activation for the two ports (P2, may become its own increment) | A double-click install with an admin password gives increment 3's state; update keeps the vault; a port cannot be taken while the daemon is down | **real:** pkg on a fresh VM, then update to a later pkg, then M4 |

After 3 the gateway is protected without Touch ID (password unlock); after 5 the S1
precondition of DEC-66 holds. DEC-66 forbids releasing Touch ID before 5 is done on a real
machine; 1 to 4 may ship earlier, dark, because the home-folder install stays the default
until 7.

Open for the maintainer, found while planning: the daemon starts connectors with `npx`; the
code folder holds one Node of our own, but connector packages download into the account's
home (`/var/lib/suveren`). That works and keeps them out of the AI's reach, but every
connector then needs network access from the account, and a company proxy set only in the
person's environment does not reach it (the settings file is the only source). Increment 3
tests this; the fix may be the `proxy` entry of the account's `config.json`, set by an admin step.

### 13.1 Status

- Increments 1 and 2: unit and scratch tests pass; dry run and scratch install and uninstall ran on a Mac. A `--prefix` inside the package folder is refused.
- Increment 3 (thin CLI), built without a second account: `lib/system-mode.mjs` detects the protected install (plist and root-owned settings file both present). Ports come from the settings file, not the person's environment. `status` asks `/health`; `config get port|mcp-port|data-dir` reads the settings file; `stop`, `restart`, `start`, `logs`, `service`, `simulation` and `config set` refuse and name the admin command. `SUVEREN_SYSTEM_PREFIX` points the CLI at a scratch install (tests only).
- Connectors: they start with `npx`. The code folder now holds node, npm and the npm/npx links of one Node distribution (copied and hash-checked like the rest) and its `bin` leads the daemon's PATH. A Node that loads libraries from outside macOS is refused for a real install: **the Homebrew Node is one** (it loads `/opt/homebrew/...`, a folder the person's user can write). The install needs the official Node from nodejs.org. Dry run and scratch install only warn.
- Increment 4 (channel without the touch, without a signing identity): `native/macos/suveren-broker.swift` checks every peer on the socket against `identifier + cdhash` from the root-owned pin file (`agent-pin.json`, written by the installer from `codesign -dvvv`) and passes only verified messages to the daemon (`lib/agent-channel.mjs`, JSON lines over its stdin/stdout). Tested on this Mac as a normal user with real signed binaries: the genuine build is served; a re-signed copy with the same identifier, another signed program, `python3` and the genuine build with one byte changed are refused and never reach the handler; the socket goes when the daemon goes. The plan writes the pin and copies the broker when given them. **Not wired yet:** the CLI install does not pass the broker or an agent (none is built before increment 5), and the daemon does not start the channel (needs the agent's unlock messages).
- **Only the VM run can show:** section 14.

## 14. VM test script (increments 2 to 4)

For a macOS VM with a snapshot taken first. Two accounts: the VM's admin account is "the
person" (use `sudo` only where written); `_suveren` is made by the install. Every command is
meant to be pasted as written. Ports 3400 and 3430 are the defaults inside the VM, which has no
live lane. Expected output follows each block; anything else is a finding to report, not to
work around.

**P0. Prepare (as the person).**
```
# official Node from nodejs.org (the .pkg installer), then:
node -v; otool -L "$(which node)" | grep -v "/usr/lib/\|/System/" | wc -l      # expect: 1 (only the header line)
git clone <the repository>; cd suveren-gateway; git checkout feat/s1-own-user
pnpm install && node bundle/build.mjs --build-apps && (cd bundle/dist && npm install)
```
Expect the last count to be `1` (the file name line only). If it is more, this Node cannot
be used for the install: that is the finding.

**P1. Increment 2, plan and install.**
```
cd bundle/dist
node bin/suveren-gateway.js install --system --dry-run | head -30     # expect: 19+ lines, "dscl", "mkdir", "copy", "symlink", "launchctl bootstrap"
node bin/suveren-gateway.js install --system                          # as the person: expect "must run as root" and exit 2
sudo node bin/suveren-gateway.js install --system                     # expect: Done.
id _suveren                                                           # expect: uid=2xx(_suveren) gid=2xx(_suveren) groups=2xx(_suveren)
dscl . -read /Users/_suveren UserShell NFSHomeDirectory IsHidden      # expect: /usr/bin/false, /var/empty, 1
ls -ld /usr/local/libexec/suveren/* /usr/local/etc/suveren /var/lib/suveren
                                                                      # expect: code and settings root wheel; data drwx------ _suveren _suveren
ls -l /usr/local/libexec/suveren/current                              # expect: -> <version>
sudo launchctl print system/ai.suveren.gateway | grep -E "state|pid|user"   # expect: state = running
```

**P2. Increment 3, the daemon and the person's refusals (as the person, no sudo).**
```
ps -o user=,pid=,command= -p "$(pgrep -f 'current/node/bin/node' | head -1)"    # expect: user _suveren
curl -s localhost:3400/health                                         # expect: JSON with "vaultUnlocked":false (locked)
node /usr/local/libexec/suveren/current/bin/suveren-gateway.js status          # expect: running (under its own account)
node /usr/local/libexec/suveren/current/bin/suveren-gateway.js stop            # expect: needs an administrator + the sudo command, exit 2
ls /var/lib/suveren                                                   # expect: Permission denied
cat /var/lib/suveren/vault.enc.json                                   # expect: Permission denied (or No such file: still no content)
touch /usr/local/libexec/suveren/current/x                            # expect: Permission denied
echo '{}' > /usr/local/etc/suveren/gateway.json                       # expect: Permission denied
kill "$(pgrep -f 'current/node/bin/node' | head -1)"                  # expect: Operation not permitted
lldb -p "$(pgrep -f 'current/node/bin/node' | head -1)" -b -o quit    # expect: refused (attach not permitted); note exact text
sudo -u _suveren env PATH=/usr/local/libexec/suveren/current/node/bin:/usr/bin:/bin /usr/local/libexec/suveren/current/node/bin/npx --version
                                                                      # expect: an npm version number, no error (the connectors' launcher)
sudo tail -n 20 /var/log/suveren/gateway.log                          # expect: gateway start lines, no EACCES
```
Then, in a browser as the person, open `http://localhost:3400`, set up with a test account,
add one connector (needs the VM's network) and check it shows "running". If it fails, copy the
line from the log: this is the connector-start question left open in 13.

**P3. Increment 3, restart, reboot, update.**
```
sudo launchctl kickstart -k system/ai.suveren.gateway; sleep 6
curl -s localhost:3400/health                                         # expect: locked again, new pid
# reboot the VM, log in as the person, open nothing:
curl -s localhost:3400/health                                         # expect: answers, locked (it started at boot)
# update: change the version first
sed -i '' 's/"version": "[^"]*"/"version": "9.9.9-vmtest"/' bundle/dist/package.json
sudo node bundle/dist/bin/suveren-gateway.js update --system          # expect: Done.
ls /usr/local/libexec/suveren; ls -l /usr/local/libexec/suveren/current        # expect: two versions, current -> 9.9.9-vmtest
curl -s localhost:3400/health                                         # expect: version 9.9.9-vmtest (or the old one: finding), locked
```

**P4. Increment 4, the channel.**
```
cd apps/control-plane && npx vitest run src/__tests__/agent-channel.test.ts      # expect: 7 passed (same account; as on the Mac)
```
Across accounts (the one fact only this run shows): the broker runs as `_suveren`, the agent
as the person.
```
W=/tmp/s1vm; rm -rf $W; mkdir $W && chmod 755 $W
swiftc -O native/macos/suveren-broker.swift -o $W/broker && swiftc -O native/macos/test/agent-stub.swift -o $W/stub
for n in agent other; do cp $W/stub $W/$n; done
codesign --force -s - -i ai.suveren.agent -o runtime $W/agent
codesign --force -s - -i com.example.other -o runtime $W/other
H=$(codesign -dvvv $W/agent 2>&1 | sed -n 's/^CDHash=//p'); echo "{\"identifier\":\"ai.suveren.agent\",\"cdhash\":\"$H\"}" > $W/pin.json
chmod 644 $W/pin.json; chmod 755 $W/*
sudo mkdir -p /var/run/s1test && sudo chown _suveren /var/run/s1test
(sleep 120 | sudo -u _suveren $W/broker --socket /var/run/s1test/a.sock --pin $W/pin.json > $W/broker.log 2>&1 &)
sleep 2; cat $W/broker.log                                            # expect: {"event":"ready"}
perl -e 'alarm 4; exec @ARGV' $W/other /var/run/s1test/a.sock '{"op":"hello"}'   # expect: {"error":"refused"}
perl -e 'alarm 4; exec @ARGV' $W/agent /var/run/s1test/a.sock '{"op":"hello"}'   # expect: no reply (nothing answers on the broker's stdin), then killed after 4 s
cat $W/broker.log                                                     # expect: a "refused" line for `other`, "open" and a "msg" line with {"op":"hello"} for `agent`
```
If `agent` is refused as well, the cross-account check does not work: report the broker log
line. Clean up: `sudo pkill -u _suveren -f $W/broker; sudo rm -rf /var/run/s1test $W`.

**P5. Uninstall.**
```
sudo node bundle/dist/bin/suveren-gateway.js uninstall --system       # expect: Done.
ls /usr/local/libexec/suveren /Library/LaunchDaemons/ai.suveren.gateway.plist   # expect: No such file (both)
id _suveren; ls -ld /var/lib/suveren                                  # expect: both still exist (data is kept)
sudo node bundle/dist/bin/suveren-gateway.js uninstall --system --remove-data
id _suveren; ls /var/lib/suveren                                      # expect: no such user; No such file
sudo launchctl print system/ai.suveren.gateway                        # expect: could not find service
```
Revert the snapshot afterwards. Report: each "expect" line that did not hold, with the exact output.
