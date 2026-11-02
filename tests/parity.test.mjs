// Признаки в браузере (app/js/features.js) совпадают с Python (prep/features.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeFeatures } from "../app/js/features.js";

const dir = mkdtempSync(join(tmpdir(), "parity-"));
execFileSync(".venv/bin/python", ["tests/parity_fixture.py", dir]);
const ref = JSON.parse(readFileSync(join(dir, "ref.json"), "utf8"));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9);

test("JS и Python дают одинаковые признаки на одних и тех же сэмплах", () => {
  for (const r of ref) {
    const buf = readFileSync(join(dir, r.file));
    const x = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    const js = computeFeatures(x, r.sr);
    assert.ok(rel(js.dur, r.py.dur) < 1e-3, `${r.file} dur ${js.dur} vs ${r.py.dur}`);
    assert.ok(rel(js.f0, r.py.f0) < 2e-3, `${r.file} f0 ${js.f0} vs ${r.py.f0}`);
    assert.ok(rel(js.centroid, r.py.centroid) < 2e-3, `${r.file} centroid ${js.centroid} vs ${r.py.centroid}`);
    js.spec.forEach((v, i) => assert.ok(Math.abs(v - r.py.spec[i]) < 0.01, `${r.file} spec[${i}] ${v} vs ${r.py.spec[i]}`));
  }
});

test("частота дискретизации 44.1 и 48 кГц почти не влияет на признаки", () => {
  const by = {};
  for (const r of ref) (by[r.lib.id] ||= {})[r.sr] = r.py;
  let bad = 0, n = 0;
  for (const [id, v] of Object.entries(by)) {
    n++;
    if (rel(v[48000].f0, v[44100].f0) > 0.05 || rel(v[48000].centroid, v[44100].centroid) > 0.05) bad++;
  }
  assert.ok(bad <= Math.ceil(n * 0.1), `расхождение >5% у ${bad} из ${n}`);
});
