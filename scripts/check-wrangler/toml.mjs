// Minimaler TOML-Parser, genau so groß, wie die wrangler.toml-Prüfung ihn
// braucht: Tabellen (`[a.b]`, `[[a.b]]`), Schlüssel (auch gepunktet),
// Strings, Zahlen, Booleans, (mehrzeilige) Arrays und Inline-Tabellen.
// Bewusst keine npm-Abhängigkeit – das Skript läuft im Config-Repo-CI ohne
// `npm install`. Datums-Typen und Mehrzeilen-Strings werden nicht
// unterstützt; unbekannte Syntax führt zu einem Fehler statt zu stillem
// Falschlesen (eine Prüfung, die still danebenliegt, ist schlimmer als keine).

export class TomlError extends Error {}

const BARE = /[A-Za-z0-9_-]/;

class Reader {
  constructor(src) {
    this.s = src;
    this.i = 0;
  }
  get eof() {
    return this.i >= this.s.length;
  }
  peek() {
    return this.s[this.i];
  }
  line() {
    return this.s.slice(0, this.i).split("\n").length;
  }
  fail(msg) {
    throw new TomlError(`TOML Zeile ${this.line()}: ${msg}`);
  }
  // Leerraum innerhalb einer Zeile
  skipSpace() {
    while (!this.eof && (this.peek() === " " || this.peek() === "\t")) this.i++;
  }
  // Leerraum, Zeilenumbrüche und Kommentare (in Arrays erlaubt)
  skipBlank() {
    for (;;) {
      this.skipSpace();
      if (this.peek() === "#") {
        while (!this.eof && this.peek() !== "\n") this.i++;
      } else if (this.peek() === "\n" || this.peek() === "\r") {
        this.i++;
      } else return;
    }
  }
  // Rest der Zeile muss leer oder Kommentar sein
  endOfLine() {
    this.skipSpace();
    if (this.peek() === "#") while (!this.eof && this.peek() !== "\n") this.i++;
    if (!this.eof && this.peek() === "\r") this.i++;
    if (!this.eof && this.peek() !== "\n") this.fail("unerwartete Zeichen am Zeilenende");
    if (!this.eof) this.i++;
  }
}

function parseString(r) {
  const q = r.peek();
  if (r.s.startsWith(q.repeat(3), r.i)) r.fail("Mehrzeilen-Strings werden nicht unterstützt");
  r.i++;
  let out = "";
  for (;;) {
    if (r.eof || r.peek() === "\n") r.fail("String nicht abgeschlossen");
    const c = r.peek();
    r.i++;
    if (c === q) return out;
    if (q === '"' && c === "\\") {
      const e = r.peek();
      r.i++;
      const map = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f" };
      if (e in map) out += map[e];
      else if (e === "u" || e === "U") {
        const len = e === "u" ? 4 : 8;
        out += String.fromCodePoint(parseInt(r.s.slice(r.i, r.i + len), 16));
        r.i += len;
      } else r.fail(`unbekannte Escape-Sequenz \\${e}`);
    } else out += c;
  }
}

function parseKey(r) {
  r.skipSpace();
  const c = r.peek();
  if (c === '"' || c === "'") return parseString(r);
  const start = r.i;
  while (!r.eof && BARE.test(r.peek())) r.i++;
  if (start === r.i) r.fail("Schlüssel erwartet");
  return r.s.slice(start, r.i);
}

function parseKeyPath(r) {
  const path = [parseKey(r)];
  for (;;) {
    r.skipSpace();
    if (r.peek() !== ".") return path;
    r.i++;
    path.push(parseKey(r));
  }
}

function parseValue(r) {
  r.skipSpace();
  const c = r.peek();
  if (c === '"' || c === "'") return parseString(r);
  if (c === "[") return parseArray(r);
  if (c === "{") return parseInlineTable(r);
  const m = /^[^\s,\]}#]+/.exec(r.s.slice(r.i));
  if (!m) r.fail("Wert erwartet");
  const tok = m[0];
  r.i += tok.length;
  if (tok === "true") return true;
  if (tok === "false") return false;
  if (/^[+-]?(inf|nan)$/.test(tok)) return Number.NaN;
  if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(tok)) return Number(tok.replaceAll("_", ""));
  if (/^0[xob][0-9a-fA-F_]+$/.test(tok)) return Number(tok.replaceAll("_", ""));
  return r.fail(`nicht unterstützter Wert „${tok}“`);
}

function parseArray(r) {
  r.i++; // [
  const arr = [];
  for (;;) {
    r.skipBlank();
    if (r.eof) r.fail("Array nicht abgeschlossen");
    if (r.peek() === "]") {
      r.i++;
      return arr;
    }
    arr.push(parseValue(r));
    r.skipBlank();
    if (r.peek() === ",") r.i++;
    else if (r.peek() !== "]") r.fail("„,“ oder „]“ erwartet");
  }
}

function parseInlineTable(r) {
  r.i++; // {
  const obj = {};
  for (;;) {
    r.skipBlank();
    if (r.peek() === "}") {
      r.i++;
      return obj;
    }
    const path = parseKeyPath(r);
    r.skipSpace();
    if (r.peek() !== "=") r.fail("„=“ erwartet");
    r.i++;
    assign(r, obj, path, parseValue(r));
    r.skipBlank();
    if (r.peek() === ",") r.i++;
    else if (r.peek() !== "}") r.fail("„,“ oder „}“ erwartet");
  }
}

// Läuft den Pfad ab und legt Zwischentabellen an. Bei Arrays von Tabellen
// gilt – wie in TOML – das zuletzt angelegte Element.
function descend(r, root, path) {
  let node = root;
  for (const k of path) {
    let next = node[k];
    if (next === undefined) next = node[k] = {};
    if (Array.isArray(next)) next = next[next.length - 1];
    if (typeof next !== "object" || next === null) r.fail(`„${k}“ ist keine Tabelle`);
    node = next;
  }
  return node;
}

function assign(r, root, path, value) {
  const node = descend(r, root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (key in node) r.fail(`Schlüssel „${key}“ doppelt`);
  node[key] = value;
}

export function parseToml(src) {
  const r = new Reader(src.replace(/^﻿/, ""));
  const root = {};
  let current = root;
  for (;;) {
    r.skipBlank();
    if (r.eof) return root;
    if (r.peek() === "[") {
      const isArray = r.s.startsWith("[[", r.i);
      r.i += isArray ? 2 : 1;
      const path = parseKeyPath(r);
      r.skipSpace();
      const close = isArray ? "]]" : "]";
      if (!r.s.startsWith(close, r.i)) r.fail(`„${close}“ erwartet`);
      r.i += close.length;
      const parent = descend(r, root, path.slice(0, -1));
      const key = path[path.length - 1];
      if (isArray) {
        if (parent[key] === undefined) parent[key] = [];
        if (!Array.isArray(parent[key])) r.fail(`„${key}“ ist kein Array von Tabellen`);
        current = {};
        parent[key].push(current);
      } else {
        current = parent[key] === undefined ? (parent[key] = {}) : parent[key];
        if (Array.isArray(current)) current = current[current.length - 1];
      }
      r.endOfLine();
    } else {
      const path = parseKeyPath(r);
      r.skipSpace();
      if (r.peek() !== "=") r.fail("„=“ erwartet");
      r.i++;
      assign(r, current, path, parseValue(r));
      r.endOfLine();
    }
  }
}
