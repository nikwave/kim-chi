import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPlanner, normalizeGain, volumeToGain, impulseResponse, formatRemaining, lookFor, SLEEP_OPTIONS, FADE_OUT_S, CALM, FREQUENCY } from "../app/js/calm-logic.js";
import { mulberry32 } from "./helpers.mjs";

const LIB = JSON.parse(readFileSync("app/library.json", "utf8"));
const planner = (seed = 1, extra = {}) => createPlanner({ library: LIB, rng: mulberry32(seed), ...extra });
const episodes = (p, n) => Array.from({ length: n }, () => p.nextEpisode());
const inRange = (x, a, b) => x >= a - 1e-9 && x <= b + 1e-9;
const isRest = (r, lo = 10, hi = 20) => inRange(r, lo, hi) || inRange(r, CALM.longSilenceMinS, CALM.longSilenceMaxS);

/* ---------- ритм ---------- */

test("паузы: обычные 10–20 с или долгая 40–90 с, долгих около 5 %", () => {
  const eps = episodes(planner(1), 3000);
  for (const e of eps) assert.ok(isRest(e.restAfterS), `пауза ${e.restAfterS}`);
  const long = eps.filter(e => e.restAfterS >= CALM.longSilenceMinS).length / eps.length;
  assert.ok(long > 0.03 && long < 0.08, `долгих ${long}`);
});

test("виды выходов: одиночный 0,55 / пара 0,25 / трель 0,20", () => {
  const eps = episodes(planner(2), 3000), share = k => eps.filter(e => e.kind === k).length / eps.length;
  assert.ok(Math.abs(share("single") - 0.55) < 0.04, `single ${share("single")}`);
  assert.ok(Math.abs(share("pair") - 0.25) < 0.04, `pair ${share("pair")}`);
  assert.ok(Math.abs(share("trill") - 0.20) < 0.04, `trill ${share("trill")}`);
});

test("пара: два чирика, второй через 3–5 с после конца первого", () => {
  const pairs = episodes(planner(3), 1500).filter(e => e.kind === "pair");
  assert.ok(pairs.length > 100);
  for (const e of pairs) {
    assert.equal(e.items.length, 2);
    assert.equal(e.items[0].gapBeforeS, 0);
    assert.ok(inRange(e.items[1].gapBeforeS, 3, 5), `gap ${e.items[1].gapBeforeS}`);
  }
});

test("одиночный: один чирик без задержки", () => {
  for (const e of episodes(planner(4), 500).filter(e => e.kind === "single")) {
    assert.equal(e.items.length, 1);
    assert.equal(e.items[0].gapBeforeS, 0);
  }
});

test("трель: 4–6 коротких криков с промежутками 0,25–0,9 с и одной точкой в панораме", () => {
  const trills = episodes(planner(5), 1500).filter(e => e.kind === "trill");
  assert.ok(trills.length > 100);
  const counts = new Set();
  for (const e of trills) {
    counts.add(e.items.length);
    assert.ok(e.items.length >= 4 && e.items.length <= 6, `длина ${e.items.length}`);
    assert.equal(e.items[0].gapBeforeS, 0);
    for (const it of e.items) assert.equal(it.group, "calls");
    for (const it of e.items.slice(1)) assert.ok(inRange(it.gapBeforeS, 0.25, 0.9), `gap ${it.gapBeforeS}`);
    const pans = e.items.map(i => i.pan);
    assert.ok(Math.max(...pans) - Math.min(...pans) <= 0.1 + 1e-9, "панорама трели разъехалась");
  }
  assert.ok(counts.has(4) && counts.has(5) && counts.has(6), `встретились длины ${[...counts]}`);
});

test("первый чирик: через 2–6 с после старта", () => {
  const p = planner(6);
  for (let i = 0; i < 200; i++) assert.ok(inRange(p.firstDelayS(), 2, 6));
});

test("«как часто»: чаще → паузы 6–12 с, реже → 16–32 с, меняется на лету", () => {
  assert.deepEqual(FREQUENCY, { rare: 1.6, normal: 1, lively: 0.6 });
  const p = planner(7, { frequency: "lively" });
  for (const e of episodes(p, 500)) assert.ok(isRest(e.restAfterS, 6, 12), `lively ${e.restAfterS}`);
  p.setFrequency("rare");
  for (const e of episodes(p, 500)) assert.ok(isRest(e.restAfterS, 16, 32), `rare ${e.restAfterS}`);
});

/* ---------- какие клипы ---------- */

test("никогда не звучат «эй», «посмотрите на меня» и «злость»", () => {
  for (const e of episodes(planner(8), 3000)) for (const it of e.items) {
    assert.ok(!["эй", "посмотрите на меня", "злость"].includes(it.clip.cat), it.clip.cat);
  }
});

test("клип не повторяется, пока не прошло 8 других выборов той же группы", () => {
  const recent = { calls: [], songs: [] };
  for (const e of episodes(planner(9), 3000)) for (const it of e.items) {
    const r = recent[it.group];
    assert.ok(!r.includes(it.clip.id), `повтор ${it.clip.id} в ${it.group}`);
    r.push(it.clip.id);
    if (r.length > CALM.recentWindow) r.shift();
  }
});

test("песни Кима и Чи звучат поровну (доля Кима 0,4–0,6)", () => {
  let kim = 0, chi = 0;
  for (const e of episodes(planner(10), 4000)) for (const it of e.items) {
    if (it.group === "songs" && it.clip.cat === "Ким") kim++;
    if (it.group === "songs" && it.clip.cat === "Чи") chi++;
  }
  assert.ok(kim + chi > 200);
  const share = kim / (kim + chi);
  assert.ok(share > 0.4 && share < 0.6, `Ким ${kim}, Чи ${chi}`);
});

test("«забота» звучит чаще на каждый клип, чем «без подписи» (не меньше чем вдвое)", () => {
  const n = {};
  for (const e of episodes(planner(11), 4000)) for (const it of e.items)
    if (it.group === "calls") n[it.clip.cat] = (n[it.clip.cat] || 0) + 1;
  const size = cat => LIB.calls.filter(c => c.cat === cat).length;
  const perClip = cat => (n[cat] || 0) / size(cat);
  assert.ok(perClip("забота") >= 2 * perClip("без подписи"), `забота ${perClip("забота")}, без подписи ${perClip("без подписи")}`);
});

test("песни: около 25 % среди одиночных и пар", () => {
  let songs = 0, all = 0;
  for (const e of episodes(planner(12), 3000)) {
    if (e.kind === "trill") continue;
    for (const it of e.items) { all++; if (it.group === "songs") songs++; }
  }
  const share = songs / all;
  assert.ok(share > 0.2 && share < 0.3, `песен ${share}`);
});

/* ---------- живость звука ---------- */

test("разброс: громкость ±3 дБ, скорость ±3 %, панорама −1…1; Ким левее, Чи правее", () => {
  let kimSeen = 0, chiSeen = 0;
  for (const e of episodes(planner(13), 3000)) for (const it of e.items) {
    assert.ok(inRange(it.gainDb, -3, 3), `gainDb ${it.gainDb}`);
    assert.ok(inRange(it.rate, 0.97, 1.03), `rate ${it.rate}`);
    assert.ok(inRange(it.pan, -1, 1), `pan ${it.pan}`);
    if (e.kind === "trill") continue;
    if (it.group === "songs" && it.clip.cat === "Ким") { kimSeen++; assert.equal(it.who, "kim"); assert.ok(it.pan < 0, `Ким pan ${it.pan}`); }
    if (it.group === "songs" && it.clip.cat === "Чи") { chiSeen++; assert.equal(it.who, "chi"); assert.ok(it.pan > 0, `Чи pan ${it.pan}`); }
  }
  assert.ok(kimSeen > 20 && chiSeen > 5);
});

test("normalizeGain: тихий клип усиливается до предела, громкий ослабляется, пик не выше 0,9", () => {
  assert.equal(normalizeGain(0.01, 0.05), 4);
  assert.ok(Math.abs(normalizeGain(0.5, 0.9) - 0.3) < 1e-9);
  const g = normalizeGain(0.05, 0.8);
  assert.ok(g * 0.8 <= 0.9 + 1e-9, `пик после усиления ${g * 0.8}`);
  assert.ok(g >= 0.25);
});

test("normalizeGain: «пустой» клип даёт конечное число", () => {
  assert.ok(Number.isFinite(normalizeGain(0, 0)));
  assert.ok(Number.isFinite(normalizeGain(0, 0.5)));
});

test("volumeToGain: 0 → 0, 100 → 1, растёт, без NaN", () => {
  assert.equal(volumeToGain(0), 0);
  assert.equal(volumeToGain(100), 1);
  assert.ok(Number.isFinite(volumeToGain(40)));
  let prev = -1;
  for (let v = 0; v <= 100; v += 5) { const g = volumeToGain(v); assert.ok(g > prev || v === 0); prev = g; }
  assert.equal(volumeToGain(-5), 0);
  assert.equal(volumeToGain(250), 1);
});

test("impulseResponse: нужной длины, затухает, повторяется при том же rng", () => {
  const sr = 8000, a = impulseResponse(sr, 0.7, mulberry32(1)), b = impulseResponse(sr, 0.7, mulberry32(1));
  assert.equal(a.length, Math.round(sr * 0.7));
  const energy = (x, i, j) => { let s = 0; for (let k = i; k < j; k++) s += x[k] * x[k]; return s; };
  const q = a.length >> 2;
  assert.ok(energy(a, a.length - q, a.length) < 0.05 * energy(a, 0, q));
  assert.deepEqual(a, b);
});

/* ---------- крайние случаи (Review Focus) ---------- */

const clip = (id, cat = "без подписи", dur = 0.3) => ({ id, file: `clips/calls/${id}.m4a`, dur, cat });

test("библиотека без песен: играют только крики, без исключений", () => {
  const p = createPlanner({ library: { calls: LIB.calls, songs: [] }, rng: mulberry32(14) });
  for (const e of episodes(p, 500)) for (const it of e.items) assert.equal(it.group, "calls");
});

test("библиотека только из песен: выходы всё равно строятся", () => {
  const p = createPlanner({ library: { calls: [], songs: LIB.songs }, rng: mulberry32(15) });
  for (const e of episodes(p, 300)) { assert.ok(e.items.length >= 1); for (const it of e.items) assert.equal(it.group, "songs"); }
});

test("клипов меньше окна повторов (3 крика): клип всегда возвращается", () => {
  const library = { calls: [clip("a"), clip("b"), clip("c")], songs: [] };
  const p = createPlanner({ library, rng: mulberry32(16) });
  for (const e of episodes(p, 100)) for (const it of e.items) assert.ok(["a", "b", "c"].includes(it.clip.id));
});

test("незнакомая категория звучит", () => {
  const library = { calls: [clip("n1", "новая"), clip("n2", "новая")], songs: [] };
  const p = createPlanner({ library, rng: mulberry32(17) });
  const seen = new Set();
  for (const e of episodes(p, 50)) for (const it of e.items) seen.add(it.clip.cat);
  assert.deepEqual([...seen], ["новая"]);
});

test("пустая библиотека: выход без чириков, но с паузой, без исключений", () => {
  const p = createPlanner({ library: { calls: [], songs: [] }, rng: mulberry32(18) });
  const e = p.nextEpisode();
  assert.deepEqual(e.items, []);
  assert.ok(isRest(e.restAfterS));
});

/* ---------- таймер сна и вид ---------- */

test("таймер сна: варианты — выкл, 15, 30, 60, 90 минут, затухание 30 с", () => {
  assert.deepEqual(SLEEP_OPTIONS, [0, 15, 30, 60, 90]);
  assert.equal(FADE_OUT_S, 30);
});

test("formatRemaining: М:СС и Ч:ММ:СС, секунды округляются вверх, мусор → 0:00", () => {
  assert.equal(formatRemaining(0), "0:00");
  assert.equal(formatRemaining(65), "1:05");
  assert.equal(formatRemaining(59.2), "1:00");
  assert.equal(formatRemaining(3600), "1:00:00");
  assert.equal(formatRemaining(3725), "1:02:05");
  assert.equal(formatRemaining(-5), "0:00");
  assert.equal(formatRemaining(NaN), "0:00");
});

test("lookFor: день всегда светлый, вечер темнеет пока активно, ночь всегда тёмная и тусклая", () => {
  assert.deepEqual(lookFor("day", true), { dusk: false, deep: false });
  assert.deepEqual(lookFor("evening", false), { dusk: false, deep: false });
  assert.deepEqual(lookFor("evening", true), { dusk: true, deep: false });
  assert.deepEqual(lookFor("night", false), { dusk: true, deep: true });
  assert.deepEqual(lookFor("night", true), { dusk: true, deep: true });
});

test("lookFor: незнакомый вид считается вечерним", () => {
  assert.deepEqual(lookFor("что-то", false), { dusk: false, deep: false });
  assert.deepEqual(lookFor(undefined, true), { dusk: true, deep: false });
});
