@echo off
rem Suveren gateway launcher — installed at the root of the per-user install
rem dir (%LOCALAPPDATA%\Programs\Suveren\suveren-gateway.cmd) alongside node\,
rem gateway\ and integrations\. Thin wrapper: it exists only to (a) point the
rem bundled node.exe at the bundled CLI with the right env, and (b) give the
rem Start Menu shortcut something named "Suveren" to show instead of "node"
rem (see bundle/lib/autostart-templates.mjs's macOS launcher for the same
rem reasoning, applied here for Windows).
rem
rem Every real subcommand (start, stop, status, service install/uninstall,
rem config, simulation) is forwarded verbatim to the EXISTING CLI
rem (bin\suveren-gateway.js) — nothing about those is reimplemented here.
rem `open-ui` and `run` are the two subcommands this script adds itself: see
rem their own labels below.
setlocal enabledelayedexpansion

set "HERE=%~dp0"

rem Tells `service install` (in the forwarded CLI, see bundle/bin/
rem suveren-gateway.js's serviceInstallWindows) to register the scheduled
rem task against THIS launcher (`run`) instead of node.exe+server.js
rem directly. That is what keeps the env below scoped to just the gateway's
rem own process tree: an earlier version of this installer wrote the same
rem variables into HKCU\Environment, which is ACCOUNT-WIDE — it silently
rem shadowed a developer's own Node (on Node 24/25) with the bundled 22 for
rem EVERY program on that account, and forced every other gateway install
rem under the same user into offline+managed mode too. %~f0 is this batch
rem file's own fully-qualified path, however it was invoked.
if not defined SUVEREN_LAUNCHER set "SUVEREN_LAUNCHER=%~f0"

rem Install method: NOT set here. The installer ships gateway\install-method.json
rem ("msi") so a self-installed gateway offers "Download installer"; a company
rem marks its installs as managed via IT policy (InstallMethod=managed), which
rem wins. Forcing "managed" here told every self-installer that "updates come
rem from your IT".

rem Offline install: every connector this gateway will ever run ships inside
rem this install dir, pinned to an exact version by build-payload.mjs at
rem release time. Never attempt an npm install — see integration-manager.ts's
rem SUVEREN_OFFLINE doc comment for why instant refusal beats a slow/odd
rem failure against an unreachable registry.
if not defined SUVEREN_OFFLINE set "SUVEREN_OFFLINE=1"

rem Point straight at the shipped, read-only connector set rather than
rem seeding a per-user copy: it's already per-user (this whole install is,
rem under %LOCALAPPDATA%), and a major-upgrade MSI replacing this install dir
rem is exactly how a new pinned connector set is meant to replace the old
rem one. User data (vault, gates, execution log) is untouched — that lives in
rem the data folder (default ~/.suveren; the installer's DATA_DIR or `config
rem set data-dir` changes it), resolved by the gateway itself, never here.
if not defined SUVEREN_INTEGRATIONS_DIR set "SUVEREN_INTEGRATIONS_DIR=%HERE%integrations"

rem Every connector's node_modules\.bin shim (crm-mcp.cmd etc.) is a tiny
rem batch/npm-generated wrapper that itself invokes a bare `node ...` —
rem npm assumes SOME node.exe is already on PATH, which is true on a normal
rem npm install (the user has one to even run the CLI) but is exactly NOT
rem true on a machine with no Node at all, the whole premise of this
rem installer. Put the bundled node.exe's own directory on PATH so those
rem shims resolve it — this is the "except the bundled one" a node-free
rem company laptop needs. Prepended, so it never shadows a real difference
rem on a dev machine that already has its own PATH.
set "PATH=%HERE%node;%PATH%"

rem Unpack runtime.zip (connectors + the gateway's node_modules) on the first start
rem after an install or upgrade — see stage-msi.ps1 for why they ship as one archive.
call :prepare
if errorlevel 1 exit /b 1
if /i "%~1"=="prepare" exit /b 0
if /i "%~1"=="open-ui" goto :open_ui
if /i "%~1"=="run" goto :run_foreground

"%HERE%node\node.exe" "%HERE%gateway\bin\suveren-gateway.js" %*
exit /b %ERRORLEVEL%

:open_ui
rem Used by the Start Menu shortcut. Registers autostart on first use (so a
rem silent, IT-driven install plus "the user opens it once" is enough to
rem survive a reboot without anyone having to run `service install` by hand);
rem safe to repeat — `schtasks /Create /F` is idempotent.
schtasks /Query /TN "Suveren" >nul 2>&1
if errorlevel 1 (
  "%HERE%node\node.exe" "%HERE%gateway\bin\suveren-gateway.js" service install
)

"%HERE%node\node.exe" "%HERE%gateway\bin\suveren-gateway.js" start --detach
rem `open` uses the configured port (installer PORT / `config set port`),
rem not a fixed 3400.
"%HERE%node\node.exe" "%HERE%gateway\bin\suveren-gateway.js" open
exit /b 0

:run_foreground
rem This is what the Task Scheduler ONLOGON action actually runs (see
rem serviceInstallWindows's SUVEREN_LAUNCHER handling in bundle/bin/
rem suveren-gateway.js) — it exists so the env set above (managed, offline,
rem integrations dir, PATH) applies to the autostart path too, WITHOUT ever
rem writing any of it to HKCU\Environment (account-wide, and would affect
rem every other program the user runs). Runs server.js directly, exactly
rem like the pre-launcher task action did, not through the full CLI's
rem `start` (no PID-file/port-already-in-use bookkeeping needed — Task
rem Scheduler itself supervises this process and restarts it on failure).
"%HERE%node\node.exe" "%HERE%gateway\server.js" --autostart
exit /b %ERRORLEVEL%

:prepare
rem Nothing to do for an unpacked payload (dev/CI runs straight from the payload dir).
if not exist "%HERE%runtime.zip" exit /b 0
rem Already unpacked for exactly this archive?
fc /b "%HERE%runtime.stamp" "%HERE%runtime.extracted" >nul 2>&1
if not errorlevel 1 exit /b 0
rem One unpacker at a time (the login task and the Start menu can start together).
rem mkdir is atomic; a lock older than ~2 minutes is from a crashed run and is taken over.
set /a "_waited=0"
:prepare_lock
mkdir "%HERE%runtime.lock" 2>nul
if not errorlevel 1 goto :prepare_locked
fc /b "%HERE%runtime.stamp" "%HERE%runtime.extracted" >nul 2>&1
if not errorlevel 1 exit /b 0
if %_waited% GEQ 120 goto :prepare_locked
timeout /t 2 /nobreak >nul
set /a "_waited+=2"
goto :prepare_lock
:prepare_locked
del /q "%HERE%runtime.extracted" 2>nul
if exist "%HERE%integrations" rmdir /s /q "%HERE%integrations"
if exist "%HERE%gateway\node_modules" rmdir /s /q "%HERE%gateway\node_modules"
"%SystemRoot%\System32\tar.exe" -x -f "%HERE%runtime.zip" -C "%HERE%."
if errorlevel 1 (
  rmdir "%HERE%runtime.lock" 2>nul
  echo Suveren gateway: could not unpack runtime.zip into %HERE% 1>&2
  exit /b 1
)
copy /y "%HERE%runtime.stamp" "%HERE%runtime.extracted" >nul
rmdir "%HERE%runtime.lock" 2>nul
exit /b 0

