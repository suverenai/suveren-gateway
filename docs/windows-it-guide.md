# Windows installer — a guide for IT

Suveren Gateway ships for Windows as a `.msi` installer. We build it but we do
**not sign it** — we don't sell the software, so there's no commercial reason
for us to hold a code-signing certificate. Instead, we publish it with a
verifiable origin, and **your IT team checks it, signs it with your own
certificate, and distributes it** through your normal software deployment
(Intune). This page is everything you need to do that.

## 1. Get the release

Every release is published on GitHub:
<https://github.com/suverenai/suveren-gateway/releases>

Download three files for the version you want:
- `suveren-gateway-X.Y.Z-windows-unsigned.msi` — the installer (unsigned)
- `suveren-gateway-X.Y.Z-windows-signing-kit.zip` — everything needed to sign it yourself
- `SHA256SUMS` — checksums for both

## 2. Verify where it came from

Two independent checks — do both.

**Checksum** (proves the files weren't corrupted or swapped in transit):

```powershell
Get-FileHash suveren-gateway-X.Y.Z-windows-unsigned.msi -Algorithm SHA256
# compare the Hash value against the matching line in SHA256SUMS
```

**Build provenance** (proves the file was actually built by our GitHub Actions
workflow from the tagged source — not hand-assembled and uploaded by someone
with repo write access):

```powershell
gh attestation verify suveren-gateway-X.Y.Z-windows-unsigned.msi `
  --owner suverenai
```

(Needs the [GitHub CLI](https://cli.github.com/).) Do the same for the
signing-kit zip. Don't proceed to signing until both checks pass.

## 3. Sign it with your own certificate

Unzip the signing kit. It contains:

```
payload/              the installer's contents (Node.js runtime, the gateway,
                       and every connector it uses — ERP, CRM, calendar, etc.)
wix/Product.wxs        the installer's source (WiX Toolset)
launcher.cmd            the small script the Start Menu shortcut runs
build-signed.ps1        the script below
```

Run, with your code-signing certificate's thumbprint:

```powershell
.\build-signed.ps1 -Thumbprint <your-certificate-thumbprint>
```

This signs every `.exe`, `.dll` and `.node` file inside `payload\` (strict
policies such as WDAC or AppLocker check every loaded binary, not just the
installer), rebuilds the `.msi` from the now-signed payload, signs the `.msi`
itself, and writes a fresh `SHA256SUMS` for what it produced. Needs
`signtool.exe` (from the Windows SDK) and the WiX CLI with its UI extension
(`dotnet tool install --global wix --version 5.0.2` then `wix extension add -g
WixToolset.UI.wixext/5.0.2`) on the machine you run it on.

If you'd rather use a `.pfx` file instead of a certificate already in a
store: `.\build-signed.ps1 -PfxPath .\your-cert.pfx`.

## 4. Distribute via Intune

The installer is **per-user** — it installs under
`%LOCALAPPDATA%\Programs\Suveren`, needs **no admin rights**, and shows **no
UAC prompt**. In Intune:

1. Package your now-signed `.msi` as a **Win32 app**.
2. Install behavior: **User** (not "System") — a per-user `.msi` run in
   System context would install into the System account's own, inaccessible
   profile, not the signed-in user's.
3. Install command: `msiexec /i suveren-gateway.msi /qn`
4. Uninstall command: `msiexec /x suveren-gateway.msi /qn`

No further configuration is required for the app to install — the gateway
starts itself and sets up autostart the first time the user opens it from the
Start Menu.

### Port and data folder (optional)

Three install options change where the gateway listens and keeps its data.
Each is optional; leave it out for the default.

| Option | Default | Meaning |
|---|---|---|
| `PORT` | `3400` | Port of the gateway app in the browser |
| `MCP_PORT` | `3430` | Port AI assistants connect to (`http://localhost:<MCP_PORT>/mcp`) |
| `DATA_DIR` | `%USERPROFILE%\.suveren` | Folder for the vault, mandates and logs — a full path |

```
msiexec /i suveren-gateway.msi /qn PORT=3500 MCP_PORT=3530 DATA_DIR="D:\Suveren"
```

Ports must be 1024–65535 and different from each other; an invalid value stops
the install before anything is installed. A double-click install shows the same
three fields on a "Gateway settings" page.

The values are saved per user in `HKCU\Software\Suveren\Gateway` (`Port`,
`McpPort`, `DataDir`) and kept on upgrade — an upgrade command does not need to
repeat them. The user can change them later with `suveren-gateway config set
port|mcp-port|data-dir`. **Changing the data folder does not move existing
data.** Uninstalling removes the saved values but never the data folder.

To lock them so the user cannot change them, use the `Port`, `McpPort` and
`DataDir` policy keys instead (§5).

## 5. IT-managed settings

Your policy settings — Authority Server address, a TLS certificate for a
company proxy, TLS pinning, simulation mode, the corporate proxy itself, and
the gateway's ports and data folder —
are set centrally via the Windows registry (`HKLM\SOFTWARE\Policies\Suveren\
Gateway`, or `HKCU` for the same key) and read by every installed gateway.
Settings made this way are shown to the user as "set by your IT" and cannot be
changed from the gateway's own UI or CLI. Full reference, including every
registry value name and type:
**[`managed-settings.md`](managed-settings.md)**.

**The proxy, specifically:** on a company laptop the proxy is usually already
configured at the Windows/system level, not something a user sets in a shell
— push it via the `Proxy` (and, if needed, `NoProxy`) registry keys rather
than relying on `HTTP_PROXY`/`HTTPS_PROXY` being present in whatever
environment the gateway happens to start in. A policy-set `Proxy` **overrides**
an already-set `HTTP_PROXY`/`HTTPS_PROXY`, so this is safe to push even to
machines that already have one. See the README's
[**"Behind a company proxy"**](../README.md#behind-a-company-proxy) section
for the full behaviour (what gets proxied, TLS inspection, and the one
combination — proxy plus TLS pinning — that refuses on purpose).

## 6. Network requirements

The installer is fully **offline** — the Node.js runtime and every connector
it uses are already inside the `.msi`. Installing and running it needs:

- **No access to the public npm registry.** The gateway never runs `npm
  install`; every connector ships pre-installed and pinned to an exact,
  tested version.
- **Access to your Authority Server's address only** — by default
  `https://www.suveren.ai`, or your own self-hosted Authority Server if your
  policy settings point there (see §5), reached either directly or through a
  corporate proxy set via the `Proxy` policy key (§5) — nothing else is ever
  contacted. Behind a TLS-inspecting proxy, point the gateway at your root
  certificate via the same policy settings.

## 7. Updates

**Set `InstallMethod = managed` in your policy (§5).** Without it, the gateway
assumes the person installed it themselves and shows a red "Update available —
Download installer" banner pointing at the public release. With it, the banner
is neutral: "Updates for this gateway come from your company's IT — no action
needed here."

To update:

1. Download the new release, verify it (§2), sign it (§3) — **every version
   needs re-signing**; a signature on 1.2.0 does not carry over to 1.3.0.
2. Push the new `.msi` through Intune the same way. Windows treats it as an
   upgrade: the installer stops the running gateway (also one started by the
   login task), replaces the files, keeps the user's data in its data folder
   (`%USERPROFILE%\.suveren` unless set otherwise, §4) and the saved port and
   folder settings, and starts the gateway again. Silent installs show
   no windows and open no browser.

The new connector set ships inside the new `.msi` — there's nothing separate
to update. Uninstalling stops the gateway and removes the login task; the
user's data folder is kept.

## 8. What "unsigned" means for you, concretely

- **Installed via Intune (recommended path):** your signed `.msi`, pushed
  through Intune, installs silently with no publisher warning — Intune is
  the trust boundary, not Authenticode.
- **Double-clicked directly** (not recommended, but possible): Windows
  SmartScreen shows an "Unknown publisher" warning for the *unsigned* file we
  publish. Your *signed* one (after §3) does not show this, because it now
  carries your own certificate.
- **WDAC / AppLocker:** if your policy only allows binaries signed by a
  specific set of certificates, you must sign the payload (§3) and allow your
  own certificate — the unsigned release will be blocked outright, by design.
