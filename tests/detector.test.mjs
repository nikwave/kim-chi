import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { synth, loadDetector, runDetector } from "./helpers.mjs";

const SR = 48000;
const Core = await loadDetector();
const syl = out => out.filter(m => m.type === "syllable");

test("находит крики с правильными границами", () => {
  const calls = [{ t: 2.0, dur: 0.2 }, { t: 3.5, dur: 0.12 }, { t: 5.0, dur: 0.4 }];
  const s = syl(runDetector(Core, synth(SR, 7, calls), SR));
  assert.equal(s.length, 3);
  s.forEach((e, i) => {
    assert.ok(Math.abs(e.t0 - calls[i].t) < 0.02, `начало ${e.t0}`);
    assert.ok(Math.abs(e.t1 - (calls[i].t + calls[i].dur)) < 0.03, `конец ${e.t1}`);
    assert.ok(e.samples.length > 0.9 * calls[i].dur * SR, "сэмплы события захвачены");
  });
});

test("тихие звуки ниже порога не срабатывают", () => {
  const s = syl(runDetector(Core, synth(SR, 5, [{ t: 2, dur: 0.2, db: -75 }], { noiseDb: -60 }), SR));
  assert.equal(s.length, 0);
});

test("первую секунду только учит шумовой пол", () => {
  const s = syl(runDetector(Core, synth(SR, 3, [{ t: 0.3, dur: 0.2 }, { t: 2, dur: 0.2 }]), SR));
  assert.equal(s.length, 1);
  assert.ok(s[0].t0 > 1.9);
});

test("порог адаптируется к шуму: тот же крик теряется в громком шуме, но не создаёт ложных срабатываний", () => {
  const quiet = syl(runDetector(Core, synth(SR, 6, [{ t: 4, dur: 0.2, db: -40 }], { noiseDb: -70 }), SR));
  const loud = syl(runDetector(Core, synth(SR, 6, [{ t: 4, dur: 0.2, db: -40 }], { noiseDb: -35 }), SR));
  assert.equal(quiet.length, 1);
  assert.equal(loud.length, 0);
});

test("резкий и долгий рост шума не даёт вечного события — отбрасывается как долгий шум", () => {
  const sr = SR, x = synth(sr, 20, [], { noiseDb: -70 });
  const y = synth(sr, 20, [], { noiseDb: -40, seed: 7 });
  for (let i = 5 * sr; i < x.length; i++) x[i] = y[i];
  const out = runDetector(Core, x, sr);
  assert.equal(syl(out).length, 0);
  assert.ok(out.some(m => m.type === "aborted" && m.reason === "долгий шум"));
  // после переучивания пола крик снова ловится
  const z = synth(sr, 20, [{ t: 17, dur: 0.2, db: -15 }], { noiseDb: -70 });
  for (let i = 5 * sr; i < x.length; i++) x[i] = y[i] + (i >= 17 * sr ? z[i] : 0);
  const s = syl(runDetector(Core, x, sr));
  assert.equal(s.length, 1);
  assert.ok(Math.abs(s[0].t0 - 17) < 0.03);
});

test("во время глушения вход игнорируется; звук, попавший на начало глушения, прерывается", () => {
  const x = synth(SR, 8, [{ t: 2, dur: 0.2 }, { t: 4, dur: 0.3 }, { t: 6, dur: 0.2 }]);
  const out = runDetector(Core, x, SR, {}, 128, [{ from: 3.9, to: 4.5 }, { from: 6.1, to: 6.6 }]);
  const s = syl(out);
  assert.equal(s.length, 1);
  assert.ok(Math.abs(s[0].t0 - 2) < 0.02);
  assert.ok(out.some(m => m.type === "aborted" && m.reason === "mute"), "крик на 6.0 с прерван глушением");
});

test("размер аудиоблока не влияет на результат", () => {
  const x = synth(SR, 6, [{ t: 2, dur: 0.2 }, { t: 4, dur: 0.15 }]);
  const a = syl(runDetector(Core, x, SR, {}, 128)).map(e => [e.t0.toFixed(4), e.t1.toFixed(4)]);
  const b = syl(runDetector(Core, x, SR, {}, 1000)).map(e => [e.t0.toFixed(4), e.t1.toFixed(4)]);
  assert.deepEqual(a, b);
});

test("чувствительность: ниже onDb — больше срабатываний на слабые звуки", () => {
  const x = synth(SR, 6, [{ t: 2, dur: 0.2, db: -45 }, { t: 4, dur: 0.2, db: -30 }], { noiseDb: -60 });
  assert.equal(syl(runDetector(Core, x, SR, { onDb: 18 })).length, 1);
  assert.equal(syl(runDetector(Core, x, SR, { onDb: 8 })).length, 2);
});

// Реальная запись: детектор приложения против нарезки Python на тех же минутах.
const RAW = "data/raw/010117-051554.MP3";
test("на настоящей записи находит примерно столько же звуков, сколько нарезка на Mac", { skip: !existsSync(RAW) }, () => {
  const from = 240, len = 180;
  const buf = execFileSync("ffmpeg", ["-v", "error", "-ss", String(from), "-t", String(len), "-i", RAW,
    "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  const x = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const js = syl(runDetector(Core, x, SR)).length;
  const py = Number(execFileSync(".venv/bin/python", ["-c", `
import sys, json; sys.path.insert(0, "prep")
import yaml, slice as S
cfg = yaml.safe_load(open("prep/config.yaml"))
x = S.load("${RAW}", 22050)[${from} * 22050:${from + len} * 22050]
syl, _ = S.detect_syllables(x, cfg)
print(len([s for s in syl if s["t0"] > 1.0 and (s["t1"] - s["t0"]) * 1000 >= 30]))`]).toString().trim());
  console.log(`    JS: ${js} слогов, Python: ${py} слогов на ${len} с записи`);
  assert.ok(Math.abs(js - py) / py < 0.35, `JS ${js} vs Python ${py}`);
});
