# Setup check (`suveren-gateway check`)

IT runs it on an employee's computer. It answers one question: does the AI
assistant on this computer have a way into the company's systems other than
the Suveren gateway?

```
suveren-gateway check          # report for people
suveren-gateway check --json   # the same findings for scripts
```

It reports. It does not fix anything. It is a check, not a guarantee.

## What it does not do

- It changes nothing on disk and starts no service.
- It makes no network request, not even to the gateway on this computer.
- It never prints a password, token or key. For a secret it names the file,
  the program and the kind of argument, or the variable name.

## The three results

Every line is exactly one of:

| Result | Meaning |
|---|---|
| `closed` | Nothing found here that goes around the gateway. |
| `open` | A way around the gateway, or a lock the user can undo. |
| `cannot tell` | The check cannot see it (unknown app, unreadable file, a setting kept in the cloud). Confirm it by hand. |

## What it looks at

**No other route** — for each AI app it finds (Claude desktop app, Claude
Code, ChatGPT desktop app / Codex, GitHub Copilot in VS Code):

- every connector (MCP server) other than the gateway, by name;
- whether the gateway is connected. A connector counts as the gateway when
  all its addresses point to the gateway's port on this computer; its name
  does not matter;
- whether an IT lock allows only the gateway, and whether the user can change
  that lock;
- terminal, file access, browser control and screen control: allowed,
  switched off, or cannot tell;
- whether the user is an administrator on this computer (an administrator can
  undo every lock);
- one "cannot tell" line per AI provider account: connectors switched on there
  are not stored on the computer.

AI apps it does not know get one "cannot tell" line.

**No passwords within reach**

- passwords and tokens in the start commands of running programs. On macOS
  and Linux every user can read the process list. On Windows the check reads
  it with PowerShell (`Get-CimInstance Win32_Process`); run without
  administrator rights it sees only this user's programs. On Linux without
  the `ps` tool it reads `/proc` directly. Example: a
  connector started as
  `mcp-remote <url> --header "Authorization: Bearer <token>"`;
- key files of common tools in the home folder (npm, AWS, GitHub CLI, Google
  Cloud, `.netrc`, saved Git passwords, Docker, a `.env` file);
- secret-looking names in the environment the check was started from.

**No hand on the gateway**

- whether the gateway is set to answer only on this computer. The check
  reads the settings (`SUVEREN_BIND_HOST` in this terminal and in the login
  service); it does not probe the port;
- whether the user can change the gateway's program files;
- whether IT has fixed the Authority Server address, and whether this user
  can change that ([Managed settings](managed-settings.md)). This is the
  setting that matters: whoever can change the address can point the gateway
  at a server of their own that signs anything, and the company's limits no
  longer bind that gateway.
  - `closed`: the address is fixed in the IT settings file and this user
    cannot change that file, or it is fixed in the machine registry
    (`HKLM\SOFTWARE\Policies\Suveren\Gateway`).
  - `open`: there are no IT settings; or they do not fix the address; or the
    address is fixed only where this user can change it (a settings file this
    user can write, or the user's own registry hive `HKCU`). When there is no
    settings file, the same line says whether this user could create it
    (for example under `C:\ProgramData`, where standard users may create
    files).
  - `cannot tell`: whether the user can change the settings file could not
    be read.
  - A team that is not fixed is a note on the line, not an open line: teams
    are optional;
- whether the AI app and the gateway run under the same user account. In that
  setup the gateway relies on the AI app having no terminal;
- the installed version. Whether it is the newest needs a network request, so
  it stays "cannot tell".

## What it cannot see (confirm by hand)

The report always ends with this list:

- connectors switched on in each AI provider's account or admin console;
- that each connected system accepts only the gateway's own service account,
  older keys are revoked, and that account allows no more than the mandates
  need;
- that the AI cannot operate the browser or the screen in which the person
  approves;
- every line marked "cannot tell".

## When the person is their own administrator

In a one-person business the person administers their own computer. Nobody
stands above them. The lines about the administrator, the IT settings and
the same user account then stay `open` by design. That is expected; it is
not a fault of the installation.

## How it decides whether the user can change a file

- macOS and Linux: the operating system's own permission check
  (`access(2)`), without opening anything for writing. A file also counts as
  changeable when its folder is writable, except in a folder with the sticky
  bit (like `/tmp`).
- Windows: Node's permission check only looks at the read-only attribute,
  so the check reads the access list with `icacls <path>` and compares it with
  the user's account and groups from `whoami /user` and `whoami /groups`. It
  never creates or opens a file to find out.
  - `open` when an allow entry for the user or one of its groups grants
    F, M, W, WD, AD, GA, GW, WDAC or WO, and no deny entry applies.
  - `closed` when no such allow entry applies, or a deny entry with F does.
  - `cannot tell` when icacls or whoami fail or print something it does not
    parse, when a deny entry denies only part of the write rights, when an
    entry depends on the owner (CREATOR OWNER, OWNER RIGHTS) or is an
    integrity label, when an account name may be garbled, or when whoami
    printed a group's state in a form it does not know (non-English Windows).
  - Entries marked `(IO)` apply to the contents of a folder, not to the
    folder itself, and are skipped.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | No line is `open`. `cannot tell` lines alone do not change this. |
| 1 | At least one line is `open`. |
| 2 | Usage error (unknown option). |
| 3 | The check could not finish. |

## Where the lock locations come from

Where each AI app keeps its settings and its IT lock comes from the vendors'
documentation. Each location carries its own "tested" mark. So far two are
tested, both on Windows 11 on 2026-11-12:

- Claude Code's `managed-mcp.json` in `C:\Program Files\ClaudeCode\` (Claude
  Code 2.1.322). While it exists, Claude Code ignores every connector in the
  user's own settings.
- Codex's `requirements.toml` in `%ProgramData%\OpenAI\Codex\` (codex-cli
  0.167.2). While it exists, Codex switches off every connector in the user's
  config that the file does not list with the same name and the same address.

The check reports those switched-off connectors as a note on a `closed`
line, not as open. The footer
says how many of the locations it looked at are not tested yet; `--json`
lists each one under `locations`. Where a setting's meaning is unclear, the
check reports "cannot tell" instead of guessing.

Not read in this version: macOS per-user managed
preferences, VS Code policies on macOS, and the contents of the macOS admin
profile for Codex (`com.openai.codex`; its presence is reported as "cannot
tell").

Each AI app is described as data in `bundle/lib/setup-check/apps/`. Adding an
app means adding one description file.
