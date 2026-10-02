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
`signtool.exe` (from the Windows SDK) and the WiX CLI
(`dotnet tool install --global wix`) on the machine you run it on.

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

## 5. IT-managed settings

Your policy settings (Authority Server address, a TLS certificate for a
company proxy, TLS pinning, simulation mode) are set centrally via a registry
key and read by every installed gateway — see
**[`docs/managed-settings.md`](docs/managed-settings.md)** *(placeholder — this
doc is written as part of a parallel change; link it here once merged)*.
Settings made this way are shown to the user as "set by your IT" and cannot be
changed from the gateway's own UI.

## 6. Network requirements

The installer is fully **offline** — the Node.js runtime and every connector
it uses are already inside the `.msi`. Installing and running it needs:

- **No access to the public npm registry.** The gateway never runs `npm
  install`; every connector ships pre-installed and pinned to an exact,
  tested version.
- **Access to your Authority Server's address only** — by default
  `https://www.suveren.ai`, or your own self-hosted Authority Server if your
  policy settings point there (see §5). Behind a TLS-inspecting proxy, point
  the gateway at your root certificate via the same policy settings.

## 7. Updates

There is no in-place "check for updates" on a managed install — your policy
setting marks it `managed`, and the gateway tells the user updates come from
IT instead of offering to self-update. To update:

1. Download the new release, verify it (§2), sign it (§3) — **every version
   needs re-signing**; a signature on 1.2.0 does not carry over to 1.3.0.
2. Push the new `.msi` through Intune the same way (a newer version replaces
   the old one automatically — Windows treats it as an upgrade, not a
   separate install).

The new connector set ships inside the new `.msi` — there's nothing separate
to update.

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
