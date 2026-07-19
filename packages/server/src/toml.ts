/**
 * Minimal TOML parser for the documented `mathlens.toml` subset (plan §3.5, §5):
 * comments, `[table]` / `[a.b]` headers, bare / quoted / dotted keys, and
 * string / number / boolean values. Literal strings ('...') take no escapes —
 * important for TeX values like '\tilde{A}'. No arrays, inline tables, or
 * multi-line strings (none appear in the documented config surface).
 *
 * Written in-repo because no TOML dependency is installed and the shared
 * lockfile must not change (see CONTRACTS.md). Swap for a real parser if one
 * is ever added.
 *
 * OWNED BY AGENT B.
 */

export type TomlValue = string | number | boolean | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlParseError extends Error {
  constructor(
    message: string,
    /** Zero-based line the error occurred on. */
    readonly line: number,
  ) {
    super(`TOML parse error at line ${line + 1}: ${message}`);
    this.name = 'TomlParseError';
  }
}

const BARE_KEY = /^[A-Za-z0-9_-]+/;

class LineCursor {
  pos = 0;
  constructor(
    readonly text: string,
    readonly line: number,
  ) {}

  skipWs(): void {
    while (this.pos < this.text.length && (this.text[this.pos] === ' ' || this.text[this.pos] === '\t')) {
      this.pos++;
    }
  }

  peek(): string | undefined {
    return this.text[this.pos];
  }

  atEndOrComment(): boolean {
    this.skipWs();
    return this.pos >= this.text.length || this.text[this.pos] === '#';
  }

  fail(message: string): never {
    throw new TomlParseError(message, this.line);
  }

  /** One key segment: bare, "basic quoted", or 'literal quoted'. */
  parseKeySegment(): string {
    this.skipWs();
    const c = this.peek();
    if (c === '"') return this.parseBasicString();
    if (c === "'") return this.parseLiteralString();
    const m = BARE_KEY.exec(this.text.slice(this.pos));
    if (!m) this.fail(`expected a key at column ${this.pos + 1}`);
    this.pos += m[0].length;
    return m[0];
  }

  /** Dotted key path, e.g. `a.b."c.d"`. */
  parseKeyPath(): string[] {
    const path = [this.parseKeySegment()];
    this.skipWs();
    while (this.peek() === '.') {
      this.pos++;
      path.push(this.parseKeySegment());
      this.skipWs();
    }
    return path;
  }

  parseBasicString(): string {
    // assumes text[pos] === '"'
    this.pos++;
    let out = '';
    while (this.pos < this.text.length) {
      const c = this.text[this.pos];
      if (c === '"') {
        this.pos++;
        return out;
      }
      if (c === '\\') {
        const esc = this.text[this.pos + 1];
        this.pos += 2;
        switch (esc) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case 'u': {
            const hex = this.text.slice(this.pos, this.pos + 4);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) this.fail('invalid \\u escape');
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            this.fail(`invalid escape \\${esc ?? '<eol>'}`);
        }
        continue;
      }
      out += c;
      this.pos++;
    }
    this.fail('unterminated string');
  }

  parseLiteralString(): string {
    // assumes text[pos] === "'"
    this.pos++;
    const end = this.text.indexOf("'", this.pos);
    if (end < 0) this.fail('unterminated literal string');
    const out = this.text.slice(this.pos, end);
    this.pos = end + 1;
    return out;
  }

  parseValue(): TomlValue {
    this.skipWs();
    const c = this.peek();
    if (c === undefined) this.fail('expected a value');
    if (c === '"') return this.parseBasicString();
    if (c === "'") return this.parseLiteralString();
    // bare token: up to whitespace or comment
    let end = this.pos;
    while (end < this.text.length && this.text[end] !== ' ' && this.text[end] !== '\t' && this.text[end] !== '#') {
      end++;
    }
    const token = this.text.slice(this.pos, end);
    this.pos = end;
    if (token === 'true') return true;
    if (token === 'false') return false;
    const num = Number(token.replace(/_/g, ''));
    if (token.length > 0 && Number.isFinite(num)) return num;
    this.fail(`unsupported value ${JSON.stringify(token)} (strings must be quoted)`);
  }
}

function ensureTable(root: TomlTable, path: string[], line: number): TomlTable {
  let current = root;
  for (const segment of path) {
    const existing = current[segment];
    if (existing === undefined) {
      const next: TomlTable = {};
      current[segment] = next;
      current = next;
    } else if (typeof existing === 'object') {
      current = existing;
    } else {
      throw new TomlParseError(`key ${JSON.stringify(segment)} is already a value, not a table`, line);
    }
  }
  return current;
}

/** Parse the documented mathlens.toml subset. Throws TomlParseError on invalid input. */
export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('[')) {
      if (trimmed.startsWith('[[')) throw new TomlParseError('arrays of tables are not supported', i);
      const cur = new LineCursor(trimmed.slice(1), i);
      const path = cur.parseKeyPath();
      cur.skipWs();
      if (cur.peek() !== ']') cur.fail("expected ']' to close table header");
      cur.pos++;
      if (!cur.atEndOrComment()) cur.fail('unexpected text after table header');
      current = ensureTable(root, path, i);
      continue;
    }

    const cur = new LineCursor(raw, i);
    const keyPath = cur.parseKeyPath();
    cur.skipWs();
    if (cur.peek() !== '=') cur.fail("expected '=' after key");
    cur.pos++;
    const value = cur.parseValue();
    if (!cur.atEndOrComment()) cur.fail('unexpected text after value');

    const table = keyPath.length > 1 ? ensureTable(current, keyPath.slice(0, -1), i) : current;
    table[keyPath[keyPath.length - 1]] = value;
  }
  return root;
}
