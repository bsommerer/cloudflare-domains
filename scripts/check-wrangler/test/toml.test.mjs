import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToml, TomlError } from "../toml.mjs";

test("Skalare, Tabellen und Arrays von Tabellen", () => {
  const t = parseToml(`
a = 1
b = "x # kein Kommentar" # Kommentar
c.d = true
[t]
k = 'lit'
[[l]]
n = 1
[[l]]
n = 2
[t.u]
z = [1, 2,
  3]
`);
  assert.equal(t.a, 1);
  assert.equal(t.b, "x # kein Kommentar");
  assert.equal(t.c.d, true);
  assert.equal(t.t.k, "lit");
  assert.deepEqual(t.l, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(t.t.u.z, [1, 2, 3]);
});

test("Inline-Tabellen und Escapes", () => {
  const t = parseToml(`x = { a = "\\u00e4\\n", b = { c = 1 } }`);
  assert.deepEqual(t.x, { a: "ä\n", b: { c: 1 } });
});

test("verschachtelte Array-Tabellen hängen am letzten Elternelement", () => {
  const t = parseToml(`[[a]]\n[[a.b]]\nx=1\n[[a]]\n[[a.b]]\nx=2`);
  assert.equal(t.a[0].b[0].x, 1);
  assert.equal(t.a[1].b[0].x, 2);
});

test("Syntaxfehler und doppelte Schlüssel werfen", () => {
  assert.throws(() => parseToml("a = "), TomlError);
  assert.throws(() => parseToml("a = 1\na = 2"), TomlError);
  assert.throws(() => parseToml(`a = """x"""`), TomlError);
  assert.throws(() => parseToml(`a = 1 b = 2`), TomlError);
});
