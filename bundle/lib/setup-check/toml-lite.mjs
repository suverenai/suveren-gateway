/**
 * A minimal TOML reader for the Setup check (`suveren-gateway check`).
 *
 * It reads only the subset the AI apps' config files use: comments, tables
 * (`[a]`, `[a.b."c d"]`), arrays of tables (`[[a]]`), bare / quoted / dotted
 * keys, basic and literal strings (single- and multi-line), integers, floats,
 * booleans, arrays (multi-line, trailing comma, comments inside) and inline
 * tables.
 *
 * Anything else (dates, times, a duplicate key, a syntax error) throws a
 * `TomlLiteError`. The Setup check turns that into a "cannot tell" line for
 * the file; it never guesses at a value it could not read. Error messages
 * never quote file content: a config file can hold a key in an `env` table.
 *
 * No dependency: Node built-ins only, like the rest of bundle/lib.
 */

export class TomlLiteError extends Error {
  constructor(message, line) {
    super(`${message} (line ${line})`);
    this.name = 'TomlLiteError';
    this.line = line;
  }
}

const BARE_KEY = /[A-Za-z0-9_-]/;

export function parseTomlLite(text) {
  const src = String(text).replace(/\r\n/g, '\n');
  let i = 0;
  let line = 1;
  const root = {};
  let current = root;
  // Tables defined explicitly with a [header] — redefining one is an error.
  const defined = new Set();

  const fail = (msg) => { throw new TomlLiteError(msg, line); };
  const peek = (n = 0) => src[i + n];
  const eof = () => i >= src.length;
  const advance = () => {
    const c = src[i++];
    if (c === '\n') line++;
    return c;
  };

  function skipWs() {
    while (!eof() && (peek() === ' ' || peek() === '\t')) i++;
  }
  function skipComment() {
    if (peek() === '#') while (!eof() && peek() !== '\n') i++;
  }
  /** Whitespace, newlines and comments (inside arrays). */
  function skipWsNlComments() {
    for (;;) {
      skipWs();
      skipComment();
      if (peek() === '\n') { advance(); continue; }
      break;
    }
  }
  function expectLineEnd() {
    skipWs();
    skipComment();
    if (eof()) return;
    if (peek() !== '\n') fail('Unexpected text after a value');
    advance();
  }

  function parseBasicString() {
    // opening " already consumed
    let out = '';
    for (;;) {
      if (eof()) fail('Unterminated string');
      const c = advance();
      if (c === '"') return out;
      if (c === '\n') fail('Newline in a single-line string');
      if (c === '\\') out += parseEscape();
      else out += c;
    }
  }
  function parseEscape() {
    const e = advance();
    switch (e) {
      case 'b': return '\b';
      case 't': return '\t';
      case 'n': return '\n';
      case 'f': return '\f';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      case 'u':
      case 'U': {
        const len = e === 'u' ? 4 : 8;
        const hex = src.slice(i, i + len);
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) fail('Invalid unicode escape');
        i += len;
        return String.fromCodePoint(parseInt(hex, 16));
      }
      default:
        return fail(`Invalid escape "\\${e}"`);
    }
  }
  function parseMultilineBasic() {
    // opening """ consumed
    if (peek() === '\n') advance();
    let out = '';
    for (;;) {
      if (eof()) fail('Unterminated multi-line string');
      if (src.startsWith('"""', i)) {
        i += 3;
        // Up to two extra quotes may close the string ("""" or """"").
        while (peek() === '"') { out += '"'; i++; }
        return out;
      }
      const c = advance();
      if (c === '\\') {
        // Line-ending backslash: trim the newline and following whitespace.
        let j = i;
        while (src[j] === ' ' || src[j] === '\t') j++;
        if (src[j] === '\n') {
          while (!eof() && /[ \t\n]/.test(peek())) advance();
          continue;
        }
        out += parseEscape();
      } else {
        out += c;
      }
    }
  }
  function parseLiteralString() {
    let out = '';
    for (;;) {
      if (eof()) fail('Unterminated string');
      const c = advance();
      if (c === "'") return out;
      if (c === '\n') fail('Newline in a single-line string');
      out += c;
    }
  }
  function parseMultilineLiteral() {
    if (peek() === '\n') advance();
    let out = '';
    for (;;) {
      if (eof()) fail('Unterminated multi-line string');
      if (src.startsWith("'''", i)) {
        i += 3;
        while (peek() === "'") { out += "'"; i++; }
        return out;
      }
      out += advance();
    }
  }

  function parseKeyPart() {
    skipWs();
    const c = peek();
    if (c === '"') { i++; return parseBasicString(); }
    if (c === "'") { i++; return parseLiteralString(); }
    let k = '';
    while (!eof() && BARE_KEY.test(peek())) k += src[i++];
    if (!k) fail('Expected a key');
    return k;
  }
  function parseDottedKey() {
    const parts = [parseKeyPart()];
    for (;;) {
      skipWs();
      if (peek() !== '.') break;
      i++;
      parts.push(parseKeyPart());
    }
    return parts;
  }

  function parseValue() {
    skipWs();
    const c = peek();
    if (c === undefined) fail('Expected a value');
    if (src.startsWith('"""', i)) { i += 3; return parseMultilineBasic(); }
    if (c === '"') { i++; return parseBasicString(); }
    if (src.startsWith("'''", i)) { i += 3; return parseMultilineLiteral(); }
    if (c === "'") { i++; return parseLiteralString(); }
    if (c === '[') { i++; return parseArray(); }
    if (c === '{') { i++; return parseInlineTable(); }
    if (src.startsWith('true', i) && !BARE_KEY.test(src[i + 4] ?? '')) { i += 4; return true; }
    if (src.startsWith('false', i) && !BARE_KEY.test(src[i + 5] ?? '')) { i += 5; return false; }
    // Number (or an unsupported date/time).
    let raw = '';
    while (!eof() && /[0-9A-Za-z_+\-.:]/.test(peek())) raw += src[i++];
    if (!raw) fail('Unexpected character where a value should be');
    if (/^[+-]?(inf|nan)$/.test(raw)) return raw.includes('nan') ? NaN : (raw.startsWith('-') ? -Infinity : Infinity);
    if (/^[+-]?(0|[1-9](_?\d)*)$/.test(raw)) return Number(raw.replace(/_/g, ''));
    if (/^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$/.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 16);
    if (/^0o[0-7](_?[0-7])*$/.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 8);
    if (/^0b[01](_?[01])*$/.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 2);
    if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(raw)) return Number(raw.replace(/_/g, ''));
    return fail('Unsupported value (for example a date or time)');
  }

  function parseArray() {
    const out = [];
    for (;;) {
      skipWsNlComments();
      if (peek() === ']') { i++; return out; }
      out.push(parseValue());
      skipWsNlComments();
      if (peek() === ',') { i++; continue; }
      if (peek() === ']') { i++; return out; }
      fail('Expected "," or "]" in an array');
    }
  }

  function parseInlineTable() {
    const out = {};
    skipWs();
    if (peek() === '}') { i++; return out; }
    for (;;) {
      const key = parseDottedKey();
      skipWs();
      if (peek() !== '=') fail('Expected "=" in an inline table');
      i++;
      const value = parseValue();
      assign(out, key, value);
      skipWs();
      if (peek() === ',') { i++; continue; }
      if (peek() === '}') { i++; return out; }
      fail('Expected "," or "}" in an inline table');
    }
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function assign(target, keyParts, value) {
    let t = target;
    for (const part of keyParts.slice(0, -1)) {
      if (!Object.prototype.hasOwnProperty.call(t, part)) t[part] = {};
      else if (!isPlainObject(t[part])) fail(`Key "${part}" is already a value`);
      t = t[part];
    }
    const last = keyParts[keyParts.length - 1];
    if (Object.prototype.hasOwnProperty.call(t, last)) fail(`Duplicate key "${last}"`);
    t[last] = value;
  }

  function openTable(parts, isArray) {
    let t = root;
    for (let n = 0; n < parts.length; n++) {
      const part = parts[n];
      const lastPart = n === parts.length - 1;
      if (lastPart && isArray) {
        if (!Object.prototype.hasOwnProperty.call(t, part)) t[part] = [];
        if (!Array.isArray(t[part])) fail(`"${part}" is not an array of tables`);
        const fresh = {};
        t[part].push(fresh);
        return fresh;
      }
      if (!Object.prototype.hasOwnProperty.call(t, part)) t[part] = {};
      let next = t[part];
      if (Array.isArray(next)) next = next[next.length - 1];
      if (!isPlainObject(next)) fail(`"${part}" is already a value`);
      t = next;
    }
    const id = JSON.stringify(parts);
    if (defined.has(id)) fail(`Table [${parts.join('.')}] defined twice`);
    defined.add(id);
    return t;
  }

  while (!eof()) {
    skipWs();
    skipComment();
    if (eof()) break;
    if (peek() === '\n') { advance(); continue; }
    if (peek() === '[') {
      i++;
      const isArray = peek() === '[';
      if (isArray) i++;
      const parts = parseDottedKey();
      skipWs();
      if (peek() !== ']') fail('Expected "]"');
      i++;
      if (isArray) {
        if (peek() !== ']') fail('Expected "]]"');
        i++;
      }
      current = openTable(parts, isArray);
      expectLineEnd();
      continue;
    }
    const key = parseDottedKey();
    skipWs();
    if (peek() !== '=') fail('Expected "=" after a key');
    i++;
    const value = parseValue();
    assign(current, key, value);
    expectLineEnd();
  }
  return root;
}
