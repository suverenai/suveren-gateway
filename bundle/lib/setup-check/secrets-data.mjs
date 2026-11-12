/**
 * Data for the Setup check's "No passwords within reach" group. Kept as data
 * so the lists can grow without touching the engine.
 *
 * Nothing here ever makes a value visible: the engine reports the kind of
 * argument, the file location or the variable NAME only.
 */

/**
 * Well-known places where command-line tools keep keys for systems the
 * gateway may connect. `pattern`: the file only counts when a line matches
 * (e.g. an npm token line); without it, the file existing is enough.
 * `anyOf`: for a folder, the files inside it that hold keys.
 */
export const CREDENTIAL_FILES = [
  { id: 'npm', label: 'npm sign-in token', path: { all: '{home}/.npmrc' },
    pattern: /^\s*(\/\/[^\s=]*:)?_(authToken|auth|password)\s*=/m },
  { id: 'aws', label: 'AWS keys', path: { all: '{home}/.aws/credentials' },
    pattern: /^\s*aws_(secret_access_key|session_token)\s*=/mi },
  { id: 'gh', label: 'GitHub CLI token',
    path: { darwin: '{xdgConfig}/gh/hosts.yml', linux: '{xdgConfig}/gh/hosts.yml', win32: '{appData}\\GitHub CLI\\hosts.yml' },
    pattern: /^\s*oauth_token\s*:/m },
  { id: 'gcloud', label: 'Google Cloud sign-in',
    path: { darwin: '{xdgConfig}/gcloud', linux: '{xdgConfig}/gcloud', win32: '{appData}\\gcloud' },
    anyOf: ['application_default_credentials.json', 'credentials.db', 'access_tokens.db', 'legacy_credentials'] },
  { id: 'netrc', label: 'saved passwords (.netrc)',
    path: { darwin: '{home}/.netrc', linux: '{home}/.netrc', win32: '{home}\\_netrc' },
    pattern: /\bpassword\b/ },
  { id: 'git-credentials', label: 'saved Git passwords', path: { all: '{home}/.git-credentials' } },
  { id: 'docker', label: 'Docker registry sign-in', path: { all: '{home}/.docker/config.json' },
    pattern: /"auth"\s*:\s*"[^"]+"/ },
  { id: 'home-env', label: 'keys in a .env file in the home folder', path: { all: '{home}/.env' },
    pattern: /^\s*(export\s+)?[A-Za-z0-9_]*(TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*\s*=\s*\S/mi },
];

/**
 * Secret-looking arguments in the process list. Each `re` has exactly one
 * capture group: the value. The engine uses the value only to make sure it
 * never appears in the program name it prints, then drops it.
 */
export const PROCESS_SECRET_PATTERNS = [
  { kind: 'a sign-in token (Authorization: Bearer)', re: /\bBearer\s+([^\s"']{6,})/i },
  { kind: 'an API key header', re: /\bx-api-key\s*:\s*([^\s"']{6,})/i },
  { kind: 'a token or key argument',
    re: /(?:^|\s)--?(?:[a-z0-9]+[-_])*(?:token|api[-_]?key|apikey|secret|password|passwd|access[-_]?key)(?:=|\s+)([^\s"']+)/i },
  { kind: 'a password argument', re: /\b(?:password|passwd|pwd)=([^\s&"']+)/i },
];

/** Values that only point at a secret (a variable reference) or are not
 *  values at all (the next flag). */
export function isPlaceholderValue(value) {
  return /^(\$|%|-)/.test(value) || /^<.*>$/.test(value);
}

/** Programs that run a script: the script names the program better. */
export const INTERPRETERS = ['node', 'nodejs', 'npx', 'bun', 'bunx', 'deno', 'python', 'python3', 'uvx', 'ruby', 'perl', 'sh', 'bash', 'zsh', 'npm', 'pnpm'];

/** Secret-looking environment variable NAMES (values never read out). */
export const SECRET_ENV_NAME_PATTERNS = [
  /_TOKEN$/i, /^TOKEN$/i, /_API_?KEY$/i, /^API_?KEY$/i, /_SECRET$/i, /_SECRET_KEY$/i, /_ACCESS_KEY$/i,
  /PASSWORD/i, /_PASSWD$/i, /_CREDENTIALS?$/i,
];
