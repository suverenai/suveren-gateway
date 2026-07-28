/**
 * Autostart file contents, per platform — pure string builders, no side effects.
 *
 * Separated from the CLI so they can be tested. The macOS plist builder shipped
 * with no tests and interpolated paths straight into XML: a home directory
 * containing `&` or `<` (both legal) produced a malformed plist and an install
 * that failed confusingly. Escaping is applied here, once, for every format
 * that needs it.
 *
 * All three mechanisms are USER-level — no admin, no root:
 *   macOS    LaunchAgent   (~/Library/LaunchAgents)
 *   Windows  Task Scheduler ONLOGON task, registered from XML
 *   Linux    systemd user unit (~/.config/systemd/user)
 */

/** Escape the five XML predefined entities. Used by both plist and Task XML. */
export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * macOS LaunchAgent.
 *
 * RunAtLoad → start at login. KeepAlive → restart on crash. The API key is
 * NEVER placed here: no argument or environment variable carries a secret, so
 * the gateway always boots locked.
 */
export function buildLaunchAgentPlist({ nodePath, serverEntry, label, logFile, dataDir, path }) {
  // launchd hands a process a MINIMAL PATH (/usr/bin:/bin:/usr/sbin:/sbin).
  // The gateway itself still starts — its node path is absolute — but it then
  // cannot find npx or the integration bin shims, so every integration silently
  // fails to launch and the UI shows them all "Not running". Carry the PATH
  // captured at install time, when it is the user's real one.
  const entries = [];
  if (dataDir) entries.push(['SUVEREN_DATA_DIR', dataDir]);
  if (path) entries.push(['PATH', path]);

  const env = entries.length
    ? '  <key>EnvironmentVariables</key>\n  <dict>\n' +
      entries.map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>\n`).join('') +
      '  </dict>\n'
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(serverEntry)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logFile)}</string>
${env}</dict>
</plist>
`;
}

/**
 * Linux systemd USER unit.
 *
 * Restart=always is the KeepAlive equivalent. WantedBy=default.target starts it
 * with the user session; `loginctl enable-linger` (offered separately) extends
 * that to boot, before any login.
 *
 * Environment values are quoted because systemd splits unquoted values on
 * whitespace — a data directory with a space would otherwise be truncated.
 */
export function buildSystemdUnit({ nodePath, serverEntry, logFile, dataDir, path }) {
  // Same problem as launchd: a systemd user unit does not inherit the shell's
  // PATH, so npx and the integration shims go missing and every integration
  // fails to start.
  const envLines = [];
  if (dataDir) envLines.push(`Environment="SUVEREN_DATA_DIR=${dataDir}"`);
  if (path) envLines.push(`Environment="PATH=${path}"`);
  const envLine = envLines.length ? envLines.join('\n') + '\n' : '';
  return `[Unit]
Description=Suveren gateway (Human Agency Protocol)
Documentation=https://www.suveren.ai
After=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${serverEntry}
${envLine}Restart=always
RestartSec=5
# The gateway boots LOCKED. Nothing in this unit can unlock the vault, so a
# restart brings the process back but never the credentials.
StandardOutput=append:${logFile}
StandardError=append:${logFile}

[Install]
WantedBy=default.target
`;
}

/**
 * Windows Task Scheduler task, as registration XML.
 *
 * Registered with `schtasks /Create /XML`. XML rather than the flag form
 * because the flags cannot express restart-on-failure, and cannot reliably
 * carry paths containing spaces.
 *
 * LogonType=InteractiveToken keeps it in the user's own session with no stored
 * password and no admin rights. Hidden + no execution time limit stop it
 * flashing a console window or being killed after the default 72 hours.
 */
export function buildWindowsTaskXml({ nodePath, serverEntry, author, dataDir }) {
  // Task Scheduler requires \Command to be the executable and \Arguments the
  // rest; quoting the script path handles spaces (e.g. under "Program Files").
  const args = `"${serverEntry}"`;
  const envNote = dataDir ? `Suveren data directory: ${dataDir}` : 'Suveren gateway';

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(envNote)}</Description>
    <Author>${escapeXml(author)}</Author>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(nodePath)}</Command>
      <Arguments>${escapeXml(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}
