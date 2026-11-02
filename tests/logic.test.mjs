import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pickCall, pickSong, pickFromCategory, RateLimiter, Session, computeMetrics, median, classify, UNLABELED, NOISE } from "../app/js/logic.js";
import { mulberry32 } from "./helpers.mjs";

const LIB = JSON.parse(readFileSync("app/library.json", "utf8"));
const fresh = () => JSON.parse(JSON.stringify(LIB));
const feat = c => ({ dur: c.dur, f0: c.f0, centroid: c.centroid, spec: c.spec });

/* ---------- подбор ---------- */

test("крик: выбирается клип, близкий к услышанному", () => {
  const lib = fresh(), rng = mulberry32(1);
  const target = lib.calls.find(c => c.cat === "эй");
  let near = 0;
  for (let i = 0; i < 200; i++) {
    const c = pickCall(feat(target), lib, {}, null, rng);
    const rel = k => Math.abs(Math.log(c[k] / target[k]));
    if (rel("dur") < 0.4 && rel("f0") < 0.25 && rel("centroid") < 0.25) near++;
  }
  assert.ok(near > 180, `близких ${near} из 200`);
});

test("крик: выбор случайный среди нескольких ближайших, а не всегда один и тот же", () => {
  const lib = fresh(), rng = mulberry32(2), seen = new Set();
  const t = lib.calls[10];
  for (let i = 0; i < 100; i++) seen.add(pickCall(feat(t), lib, {}, null, rng).id);
  assert.ok(seen.size >= 3 && seen.size <= 8, `разных клипов: ${seen.size}`);
});

test("один и тот же клип не повторяется подряд", () => {
  const lib = fresh(), rng = mulberry32(3);
  let last = null;
  for (let i = 0; i < 300; i++) {
    const c = pickCall(feat(lib.calls[i % lib.calls.length]), lib, {}, last, rng);
    assert.notEqual(c.id, last);
    last = c.id;
  }
  last = null;
  for (let i = 0; i < 300; i++) {
    const s = pickSong(lib, {}, last, rng);
    assert.notEqual(s.id, last);
    last = s.id;
  }
});

test("категория с весом 0 не звучит в автоответах", () => {
  const lib = fresh(), rng = mulberry32(4);
  const angry = lib.calls.find(c => c.cat === "злость");
  for (let i = 0; i < 300; i++) assert.notEqual(pickCall(feat(angry), lib, { "злость": 0 }, null, rng).cat, "злость");
});

test("больший вес категории — чаще звучит", () => {
  const lib = fresh();
  const count = w => {
    const rng = mulberry32(5); let n = 0;
    for (const c of lib.calls) if (pickCall(feat(c), lib, { "забота": w }, null, rng).cat === "забота") n++;
    return n;
  };
  assert.ok(count(5) > count(1) * 1.5, `вес 5: ${count(5)}, вес 1: ${count(1)}`);
});

test("песни: Ким и Чи звучат примерно поровну, хотя песен Кима в 6 раз больше", () => {
  const lib = fresh(), rng = mulberry32(6);
  const w = { "без подписи": 0, "забота": 0, "Ким и Чи": 0 };
  const n = { "Ким": 0, "Чи": 0 };
  for (let i = 0; i < 4000; i++) n[pickSong(lib, w, null, rng).cat]++;
  const share = n["Чи"] / (n["Ким"] + n["Чи"]);
  assert.ok(share > 0.45 && share < 0.55, `доля Чи ${share.toFixed(2)}`);
});

test("ручной выбор категории берёт клип только из неё", () => {
  const lib = fresh(), rng = mulberry32(7);
  for (let i = 0; i < 50; i++) assert.equal(pickFromCategory(lib.calls, "эй", null, rng).cat, "эй");
  assert.equal(pickFromCategory(lib.calls, "нет такой", null, rng), null);
});

/* ---------- лимиты ---------- */

test("лимит ответов в минуту — скользящее окно 60 с", () => {
  const l = new RateLimiter();
  for (let i = 0; i < 3; i++) { assert.ok(l.canRespond(i, 3)); l.record(i, "call"); }
  assert.ok(!l.canRespond(30, 3));
  assert.ok(l.canRespond(60.5, 3));
});

test("лимит песен — не чаще одной за интервал", () => {
  const l = new RateLimiter();
  assert.ok(l.canSing(0, 120)); l.record(0, "song");
  assert.ok(!l.canSing(119, 120));
  assert.ok(l.canSing(120, 120));
});

/* ---------- сессия ---------- */

const mk = (opts = {}) => new Session({ library: fresh(), mode: "respond", rng: mulberry32(11),
  ...opts, settings: { probability: 1, probabilityKnown: 1, silenceEnabled: false, ...opts.settings } });
// признаки берутся у настоящего клипа «эй» (узнаётся надёжно), длительность события — для таймингов
const call = (t0, dur = 0.2, src = LIB.calls.find(c => c.cat === "эй")) => ({ t0, t1: t0 + dur, features: feat(src) });

test("ответ на крик начинается через заданную задержку после конца крика", () => {
  const s = mk();
  s.onSyllable(call(10));
  assert.deepEqual(s.tick(10.25), []);                 // серия ещё может продолжиться
  const [a] = s.tick(10.33);
  assert.equal(a.type, "respond");
  assert.equal(a.kind, "call");
  assert.ok(Math.abs(a.at - 10.5) < 1e-9, `начало ${a.at}`);
  assert.ok(a.mute.from === a.at && Math.abs(a.mute.to - (a.end + 0.15)) < 1e-9, "глушение = ответ + 150 мс");
});

test("вероятность ответа соблюдается (около 45%)", () => {
  const s = mk({ settings: { probability: 0.45, probabilityKnown: 0.45, maxPerMinute: 1e9 } });
  let n = 0;
  for (let i = 0; i < 2000; i++) {
    s.onSyllable(call(i * 3));
    n += s.tick(i * 3 + 0.5).filter(a => a.type === "respond").length;
  }
  assert.ok(n / 2000 > 0.41 && n / 2000 < 0.49, `доля ${n / 2000}`);
});

test("лимит в минуту ограничивает ответы и пишется в журнал", () => {
  const s = mk({ settings: { maxPerMinute: 3 } });
  let n = 0;
  for (let i = 0; i < 10; i++) { s.onSyllable(call(i * 4)); n += s.tick(i * 4 + 0.5).filter(a => a.type === "respond").length; }
  assert.equal(n, 3);
  assert.ok(s.log.some(e => e.type === "skipped" && e.reason === "лимит в минуту"));
});

test("если птица снова заговорила до начала ответа — ответ отменяется", () => {
  const s = mk();
  s.onSyllable(call(10));
  const [a] = s.tick(10.33);
  const cancelled = s.onOnset(10.4);
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].rid, a.rid);
  const m = computeMetrics(s.log, { start: 0, end: 20, mutes: s.mutes });
  assert.equal(m.responses, 0);
  assert.equal(m.mutedS, 0, "глушение отменённого ответа не считается");
});

test("пока птица издаёт следующий звук, ответ не назначается (не говорим поверх птицы)", () => {
  const s = mk();
  s.onSyllable(call(10));          // крик 10.0–10.2
  s.onOnset(10.25);                 // следующий звук начался через 50 мс
  assert.deepEqual(s.tick(10.33), [], "серия не закрыта, пока звук идёт");
  assert.deepEqual(s.tick(10.4), []);
  s.onSyllable(call(10.25, 0.15)); // закончился в 10.4
  const [a] = s.tick(10.53);
  assert.equal(a.type, "respond");
  assert.ok(Math.abs(a.at - 10.7) < 1e-9, "ответ через 300 мс после конца последнего звука");
  // отброшенный детектором звук не блокирует серию навсегда
  const q = mk();
  q.onSyllable(call(20)); q.onOnset(20.21); q.onAborted();
  assert.equal(q.tick(20.33).length, 1);
});

test("отменённый ответ не занимает место в лимите в минуту", () => {
  const s = mk({ settings: { maxPerMinute: 1 } });
  s.onSyllable(call(10)); s.tick(10.33);
  s.onOnset(10.4);                                      // отменили
  s.onSyllable(call(10.4, 0.1));
  const acts = s.tick(10.63);
  assert.equal(acts.filter(a => a.type === "respond").length, 1);
});

const songSyllables = (t0, n = 8) => Array.from({ length: n }, (_, i) => call(t0 + i * 0.25, 0.18, LIB.calls[3]));

test("песня птицы распознаётся; крики внутри песни не вызывают ответов", () => {
  const s = mk({ settings: { songsEnabled: false } });
  const acts = [];
  for (const sy of songSyllables(5)) { acts.push(...s.onSyllable(sy)); acts.push(...s.tick(sy.t1 + 0.05)); }
  assert.ok(s.birdSinging);
  assert.equal(acts.filter(a => a.type === "respond").length, 0);
  acts.push(...s.tick(5 + 8 * 0.25 + 1));
  assert.equal(acts.filter(a => a.type === "respond").length, 0, "песни выключены — ответа нет");
  assert.ok(s.log.some(e => e.type === "bird_song_end"));
  assert.ok(s.log.some(e => e.type === "skipped" && e.reason === "песни выключены"));
  assert.equal(s.log.filter(e => e.type === "bird_call").length, 0);
});

test("с включёнными песнями — ответ песней после конца песни, не чаще раза в интервал", () => {
  const s = mk({ settings: { songsEnabled: true, songIntervalS: 120 } });
  const sing = t0 => {
    const out = [];
    for (const sy of songSyllables(t0)) { out.push(...s.onSyllable(sy)); out.push(...s.tick(sy.t1 + 0.05)); }
    out.push(...s.tick(t0 + 3));
    return out.filter(a => a.type === "respond");
  };
  const r1 = sing(10);
  assert.equal(r1.length, 1);
  assert.equal(r1[0].kind, "song");
  assert.ok(r1[0].at >= 10 + 7 * 0.25 + 0.18 + 0.3 - 1e-9, "после конца песни + задержка");
  assert.equal(sing(60).length, 0, "через 50 с — лимит песен");
  assert.equal(sing(200).length, 1, "через 190 с — можно");
});

test("«Только слушать»: та же логика, ответы виртуальные; метрика одинаковая", () => {
  const run = mode => {
    const s = new Session({ library: fresh(), mode, rng: mulberry32(21), settings: { probability: 0.45, silenceEnabled: false } });
    const acts = [];
    for (let i = 0; i < 40; i++) {
      acts.push(...s.onSyllable(call(i * 2)));
      acts.push(...s.tick(i * 2 + 0.4));
      if (i % 3 === 0) s.onSyllable(call(i * 2 + 1.1));   // «отклик» птицы
    }
    return { s, acts: acts.filter(a => a.type === "respond") };
  };
  const a = run("respond"), b = run("listen");
  assert.ok(a.acts.length > 0);
  assert.deepEqual(a.acts.map(x => [x.at, x.clip.id]), b.acts.map(x => [x.at, x.clip.id]));
  assert.ok(b.acts.every(x => x.virtual) && a.acts.every(x => !x.virtual));
  const ma = computeMetrics(a.s.log, { start: 0, end: 90, mutes: a.s.mutes });
  const mb = computeMetrics(b.s.log, { start: 0, end: 90, mutes: b.s.mutes });
  assert.deepEqual({ ...ma, manual: 0 }, { ...mb, manual: 0 });
});

test("ручная кнопка «Спеть» подчиняется лимиту песен и не работает в режиме тишины", () => {
  const s = mk();
  assert.ok(s.manual("song", 10).ok);
  const r = s.manual("song", 50);
  assert.ok(!r.ok && r.reason.startsWith("лимит песен"));
  const q = new Session({ library: fresh(), mode: "listen", settings: {} });
  assert.ok(!q.manual("song", 10).ok);
});

test("ручной запуск категории подчиняется лимиту в минуту", () => {
  const s = mk({ settings: { maxPerMinute: 2 } });
  assert.ok(s.manual("call", 1, "эй").ok);
  assert.ok(s.manual("call", 2, "эй").ok);
  assert.ok(!s.manual("call", 3, "эй").ok);
});

test("стоп отменяет запланированные ответы", () => {
  const s = mk();
  s.onSyllable(call(10));
  s.tick(10.33);
  assert.equal(s.stop(10.35).length, 1);
  assert.equal(computeMetrics(s.log, { start: 0, end: 10.35, mutes: s.mutes }).responses, 0);
});

/* ---------- метрики ---------- */

test("метрики: доля откликов за 1 с, медиана задержки, время глушения", () => {
  const log = [
    { type: "response", rid: 1, t: 10, end: 10.3 },
    { type: "syllable", t: 10.7 },                 // отклик через 0.4
    { type: "response_virtual", rid: 2, t: 20, end: 20.3 },
    { type: "syllable", t: 21.6 },                 // поздно (1.3 с) — не считается
    { type: "response", rid: 3, t: 30, end: 30.3 },
    { type: "syllable", t: 30.5 },                 // отклик через 0.2
    { type: "response", rid: 4, t: 40, end: 40.3 },
    { type: "cancelled", rid: 4 },                 // отменён — не считается
    { type: "bird_call", t: 1 }, { type: "bird_call", t: 2 },
  ];
  const m = computeMetrics(log, { start: 0, end: 60, mutes: [{ from: 10, to: 10.45 }, { from: 10.3, to: 10.6 }, { from: 59.9, to: 61 }] });
  assert.equal(m.responses, 3);
  assert.ok(Math.abs(m.replyShare - 2 / 3) < 1e-9);
  assert.ok(Math.abs(m.replyShare05 - 2 / 3) < 1e-9);
  assert.ok(Math.abs(m.medianLatencyS - 0.3) < 1e-9);
  assert.ok(Math.abs(m.mutedS - 0.7) < 1e-9, `глушение ${m.mutedS}`);
  assert.equal(m.birdCalls, 2);
});

test("медиана", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

/* ---------- распознавание ---------- */

function looAccuracy(clips, stats, useDur) {
  let ok = 0, n = 0, fp = 0, un = 0;
  for (const c of clips) {
    const got = classify(c, clips, stats, { exclude: c.id, useDur }).cat;
    if (c.cat === UNLABELED) { un++; if (got !== UNLABELED) fp++; }
    else { n++; if (got === c.cat) ok++; }
  }
  return { ok, n, fp, un };
}

test("распознавание песен: Ким или Чи (проверка «без одного» на вашей библиотеке)", () => {
  const lib = fresh();
  const songs = lib.songs.filter(c => c.cat === "Ким" || c.cat === "Чи");
  const r = looAccuracy(songs, lib.stats.songs, false);
  console.log(`    песни Ким/Чи: верно ${r.ok} из ${r.n}`);
  assert.ok(r.ok / r.n >= 0.9, `${r.ok}/${r.n}`);
});

test("распознавание криков: «эй» узнаётся; шум не принимается за категорию; птицы редко принимаются за шум", () => {
  const lib = fresh();
  const refs = [...lib.calls, ...lib.refs];
  const by = {}; let noiseToCat = 0, noise = 0, birdToNoise = 0, bird = 0;
  for (const c of refs) {
    const got = classify(c, refs, lib.stats.calls, { exclude: c.id }).cat;
    if (c.cat === NOISE) { noise++; if (got !== NOISE && got !== UNLABELED) noiseToCat++; }
    else if (c.cat === UNLABELED) { bird++; if (got === NOISE) birdToNoise++; }
    else { (by[c.cat] ||= [0, 0])[1]++; if (got === c.cat) by[c.cat][0]++; }
  }
  console.log("    крики:", Object.entries(by).map(([k, [a, b]]) => `${k} ${a}/${b}`).join(", "),
    `· шум→категория ${noiseToCat}/${noise} · крик без подписи→шум ${birdToNoise}/${bird}`);
  assert.ok(by["эй"][0] / by["эй"][1] >= 0.85);
  assert.ok(noiseToCat / noise <= 0.02, "шум почти никогда не принимается за подписанную категорию");
  assert.ok(birdToNoise / bird <= 0.03, "настоящие крики почти никогда не принимаются за шум");
});

/* ---------- правила ответа ---------- */

// маленькая библиотека, где позывных достаточно для распознавания
function toyLib() {
  const mk = (id, cat, f0, centroid) => ({ id, cat, dur: 0.3, f0, centroid, file: id });
  const calls = [];
  for (let i = 0; i < 5; i++) calls.push(mk("k" + i, "позывной Кима", 500 + i, 3000 + i * 5));
  for (let i = 0; i < 5; i++) calls.push(mk("c" + i, "позывной Чи", 1100 + i, 3600 + i * 5));
  for (let i = 0; i < 5; i++) calls.push(mk("z" + i, "злость", 800 + i, 5000 + i * 5));
  for (let i = 0; i < 5; i++) calls.push(mk("u" + i, UNLABELED, 650 + i * 20, 2000 + i * 50));
  const lg = k => calls.map(c => Math.log(c[k]));
  const st = a => { const m = a.reduce((x, y) => x + y) / a.length; return { mean: m, std: Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length) || 1 }; };
  return { calls, songs: LIB.songs, stats: { calls: { dur: { mean: Math.log(0.3), std: 1 }, f0: st(lg("f0")), centroid: st(lg("centroid")) }, songs: LIB.stats.songs },
    categories: { calls: [], songs: LIB.categories.songs } };
}
const heardLike = (c, t0) => ({ t0, t1: t0 + 0.3, features: { dur: 0.3, f0: c.f0 + 1, centroid: c.centroid + 2 } });

test("услышал позывной Кима — отвечает позывным Чи, и наоборот", () => {
  const lib = toyLib();
  const s = new Session({ library: lib, mode: "respond", rng: mulberry32(1), settings: { probabilityKnown: 1, silenceEnabled: false } });
  s.onSyllable(heardLike(lib.calls[2], 10));
  const [a] = s.tick(10.5);
  assert.equal(a.heard, "позывной Кима");
  assert.equal(a.clip.cat, "позывной Чи");
  s.onSyllable(heardLike(lib.calls[7], 20));
  const [b] = s.tick(20.5);
  assert.equal(b.clip.cat, "позывной Кима");
});

test("услышал «злость» — по правилу не отвечает; правило можно поменять в настройках", () => {
  const lib = toyLib();
  const s = new Session({ library: lib, mode: "respond", rng: mulberry32(1), settings: { probabilityKnown: 1, silenceEnabled: false } });
  s.onSyllable(heardLike(lib.calls[12], 10));
  const [a] = s.tick(10.5);
  assert.equal(a.type, "skipped");
  assert.match(a.reason, /злость/);
  const q = new Session({ library: lib, mode: "respond", rng: mulberry32(1),
    settings: { probabilityKnown: 1, silenceEnabled: false, rules: { calls: { "злость": "позывной Чи" }, songs: {} } } });
  q.onSyllable(heardLike(lib.calls[12], 10));
  assert.equal(q.tick(10.5)[0].clip.cat, "позывной Чи");
});

test("услышанный шум — по правилу без ответа", () => {
  const lib = toyLib();
  lib.refs = Array.from({ length: 8 }, (_, i) => ({ id: "n" + i, cat: NOISE, dur: 0.3, f0: 380 + i, centroid: 1200 + i * 5 }));
  const s = new Session({ library: lib, mode: "respond", rng: mulberry32(1), settings: { probability: 1, silenceEnabled: false } });
  s.onSyllable(heardLike(lib.refs[3], 10));
  const [a] = s.tick(10.5);
  assert.equal(a.type, "skipped");
  assert.equal(a.heard, NOISE);
});

test("песня Чи — в ответ песня Кима, песня Кима — песня Чи", () => {
  const lib = fresh();
  const s = new Session({ library: lib, mode: "respond", rng: mulberry32(4),
    settings: { songsEnabled: true, songIntervalS: 0, silenceEnabled: false, maxPerMinute: 1e9 } });
  const tally = { "Чи": [0, 0], "Ким": [0, 0] };
  let t = 0;
  for (const c of lib.songs.filter(x => x.cat === "Ким" || x.cat === "Чи").slice(0, 60)) {
    s.featurize = () => ({ ...c });          // признаки всей песни
    for (let i = 0; i < 6; i++) s.onSyllable({ t0: t + i * 0.2, t1: t + i * 0.2 + 0.15, samples: new Float32Array(10) });
    const acts = s.tick(t + 2).filter(a => a.type === "respond");
    const want = c.cat === "Чи" ? "Ким" : "Чи";
    tally[c.cat][1]++;
    if (acts[0] && acts[0].clip.cat === want) tally[c.cat][0]++;
    t += 30;
  }
  for (const [k, [a, b]] of Object.entries(tally)) assert.ok(b === 0 || a / b >= 0.8, `${k}: ${a}/${b}`);
});

/* ---------- инициатива в тишине ---------- */

test("в тишине программа сама издаёт звук через 8–20 с, а пока птица звучит — нет", () => {
  const s = mk({ settings: { silenceEnabled: true, silenceMinS: 8, silenceMaxS: 20, maxPerMinute: 100 } });
  const times = [];
  for (let t = 0; t < 600; t += 0.05) for (const a of s.tick(t)) if (a.initiative) { times.push(a.at); s.started(a.end + 0.01); }
  assert.ok(times.length >= 600 / 21 && times.length <= 600 / 8 + 1, `инициатив ${times.length}`);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 8, "интервал ≥ 8 с");
  const q = mk({ settings: { silenceEnabled: true } });
  q.onOnset(5);                                   // птица начала звук и тянет его
  for (let t = 5; t < 40; t += 0.1) assert.equal(q.tick(t).length, 0);
});

test("инициатива выключается тумблером и подчиняется лимиту; в режиме тишины — виртуальная", () => {
  const off = mk({ settings: { silenceEnabled: false } });
  for (let t = 0; t < 120; t += 0.1) assert.equal(off.tick(t).length, 0);
  const lim = mk({ settings: { silenceEnabled: true, silenceMinS: 1, silenceMaxS: 1, maxPerMinute: 2 } });
  let n = 0;
  for (let t = 0; t < 59; t += 0.05) for (const a of lim.tick(t)) if (a.type === "respond") { n++; lim.started(a.end + 0.01); }
  assert.equal(n, 2);
  const v = new Session({ library: fresh(), mode: "listen", rng: mulberry32(9), settings: { silenceEnabled: true } });
  let act = null;
  for (let t = 0; t < 30 && !act; t += 0.1) act = v.tick(t).find(a => a.type === "respond");
  assert.ok(act && act.virtual && act.initiative);
  assert.ok(v.log.some(e => e.type === "initiative_virtual"));
});

test("метрики считают ответы и инициативы отдельно", () => {
  const log = [
    { type: "response", rid: 1, t: 10, end: 10.3 }, { type: "syllable", t: 10.6 },
    { type: "initiative", rid: 2, t: 20, end: 20.3 }, { type: "syllable", t: 21.0 },
    { type: "initiative_virtual", rid: 3, t: 30, end: 30.3 },
    { type: "bird_call", t: 10.6, cat: "забота" },
  ];
  const m = computeMetrics(log, { start: 0, end: 60 });
  assert.equal(m.responses, 1);
  assert.equal(m.initiatives, 2);
  assert.equal(m.replyShare, 1);
  assert.equal(m.initiativeReplyShare, 0.5);
  assert.deepEqual(m.recognized, { "забота": 1 });
});

test("лимит песен 0 — без ограничения по времени, но общий лимит в минуту действует", () => {
  const s = mk({ settings: { songsEnabled: true, songIntervalS: 0, maxPerMinute: 3 } });
  let n = 0, t = 0;
  for (let k = 0; k < 6; k++) {
    for (const sy of songSyllables(t)) { s.onSyllable(sy); s.tick(sy.t1 + 0.05); }
    n += s.tick(t + 3).filter(a => a.type === "respond" && a.kind === "song").length;
    t += 5;
  }
  assert.equal(n, 3, "песни подряд, пока не упёрлись в общий лимит");
  assert.ok(s.manual("song", 100).ok, "ручная «Спеть» без лимита песен тоже работает");
});
