// Логика сессии без Web Audio: распознавание, правила ответа, подбор клипов, лимиты,
// песня/крик, инициатива в тишине, метрики.
// Время везде — секунды аудио-часов (AudioContext.currentTime).

export const UNLABELED = "без подписи";
export const SIMILAR = "similar";   // ответить похожим звуком
export const NONE = "none";         // не отвечать
export const BY_WEIGHT = "weights"; // песня по весам категорий
export const NOISE = "шум";         // похоже на удалённые/отброшенные звуки

export const DEFAULT_RULES = {
  calls: {
    "забота": "забота", "эй": "эй", "посмотрите на меня": "посмотрите на меня",
    "позывной Кима": "позывной Чи", "позывной Чи": "позывной Кима",
    "злость": NONE, [NOISE]: NONE, [UNLABELED]: SIMILAR,
  },
  songs: { "Ким": "Чи", "Чи": "Ким", [UNLABELED]: BY_WEIGHT },
};

export const DEFAULT_SETTINGS = {
  probability: 0.6,        // вероятность ответа на неузнанный крик
  probabilityKnown: 0.9,   // вероятность ответа на узнанный звук (забота, эй, позывной…)
  delayS: 0.30,            // ответ начинается через столько после конца крика
  maxPerMinute: 12,        // лимит звуков программы в минуту (ответы, песни, инициатива, ручные)
  songsEnabled: false,     // отвечать песней на песню
  songIntervalS: 60,       // не чаще одной песни за столько секунд
  silenceEnabled: true,    // в тишине самой заводить разговор
  silenceMinS: 8,          // через сколько секунд тишины (случайно между min и max)
  silenceMaxS: 20,
  silenceSongChance: 0.2,  // доля инициатив песней (если песни включены и лимит позволяет)
  sessionMinutes: 15,
  muteTailS: 0.15,         // глушение детектора после конца звука программы
  boutGapS: 0.12,          // паузы короче — одна серия
  songGapS: 0.5,           // внутри песни паузы могут быть длиннее
  songMinS: 0.7,           // серия от этой длины — кандидат в песню...
  songMinSyllables: 4,     // ...если в ней от 4 слогов
  motifMinS: 0.35,         // ...или есть слитный кусок длиннее этого
  nearestK: 8,             // из скольких ближайших клипов выбирать похожий
  classifyK: 7,            // распознавание: соседей
  classifyMinVotes: 2,     // ...и сколько из них должны быть одной подписанной категории
  replyWindowS: 1.0,       // окно отклика птиц для метрики
  onDb: 12,
  weights: { calls: {}, songs: {} },  // вес категорий: имя → 0..5
  rules: { calls: {}, songs: {} },    // услышанная категория → чем отвечать (поверх DEFAULT_RULES)
};

/* ---------------- признаки и распознавание ---------------- */

const FEATS = ["dur", "f0", "centroid"];

export function normFeatures(f, stats) {
  return FEATS.map(k => (Math.log(Math.max(f[k], 1e-3)) - stats[k].mean) / (stats[k].std || 1));
}

// Вектор для распознавания: длительность (для криков), f0, яркость, форма спектра.
function classVector(f, stats, useDur) {
  const [d, f0, c] = normFeatures(f, stats);
  // веса подобраны проверкой «без одного» на подписанных клипах (tests/logic.test.mjs)
  const v = useDur ? [d * 2, f0, c] : [f0 * 2, c * 2];
  const sp = stats.spec;
  if (f.spec && sp) for (let i = 0; i < f.spec.length; i++) v.push((f.spec[i] - sp.mean[i]) / sp.std[i] * 0.5);
  return v;
}

// Какую категорию напоминает звук: k ближайших образцов голосуют.
// Подписанная категория побеждает, если у неё ≥ minVotes голосов и не меньше, чем у «шума».
// «Шум» — если за него ≥ 70% голосов. Иначе — «без подписи».
export function classify(features, clips, stats, { k = 7, minVotes = 2, useDur = true, exclude = null } = {}) {
  if (!features) return { cat: UNLABELED, votes: 0 };
  const h = classVector(features, stats, useDur);
  const ds = [];
  for (const c of clips) {
    if (c.id === exclude) continue;
    const key = useDur ? "_cv1" : "_cv0";
    const v = c[key] || (c[key] = classVector(c, stats, useDur));
    let d2 = 0;
    for (let i = 0; i < h.length; i++) d2 += (v[i] - h[i]) ** 2;
    ds.push([d2, c.cat]);
  }
  ds.sort((a, b) => a[0] - b[0]);
  const votes = {};
  for (const [, cat] of ds.slice(0, k)) if (cat !== UNLABELED) votes[cat] = (votes[cat] || 0) + 1;
  const nv = votes[NOISE] || 0;
  delete votes[NOISE];
  let best = UNLABELED, n = 0;
  for (const [cat, v] of Object.entries(votes)) if (v > n) { best = cat; n = v; }
  if (n >= minVotes && n >= nv) return { cat: best, votes: n };
  if (nv >= Math.ceil(k * 0.7)) return { cat: NOISE, votes: nv };
  return { cat: UNLABELED, votes: n };
}

export function weightOf(weights, cat, categories) {
  if (weights && cat in weights) return weights[cat];
  const c = categories && categories.find(x => x.name === cat);
  return c ? c.weight : 1;
}

export function ruleFor(rules, group, cat) {
  const r = rules && rules[group] && rules[group][cat];
  if (r !== undefined) return r;
  const d = DEFAULT_RULES[group][cat];
  if (d !== undefined) return d;
  return group === "calls" ? SIMILAR : BY_WEIGHT;
}

/* ---------------- подбор клипов ---------------- */

// Похожий крик: из ближайших по признакам — случайно, с учётом веса категорий.
export function pickCall(heard, library, weights, lastId, rng = Math.random, k = 8) {
  const stats = library.stats.calls;
  const h = normFeatures(heard, stats);
  const cand = [];
  for (const c of library.calls) {
    if (c.id === lastId) continue;
    const w = weightOf(weights, c.cat, library.categories && library.categories.calls);
    if (!(w > 0)) continue;
    const v = c._norm || (c._norm = normFeatures(c, stats));
    let d2 = 0;
    for (let i = 0; i < 3; i++) d2 += (v[i] - h[i]) ** 2;
    cand.push({ clip: c, score: w * Math.exp(-d2 / 2) });
  }
  if (!cand.length) return null;
  cand.sort((a, b) => b.score - a.score);
  return weightedChoice(cand.slice(0, k), x => x.score, rng).clip;
}

// Случайный звук по весам категорий: сначала категория, потом клип в ней.
export function pickByCategoryWeight(clips, categories, weights, lastId, rng = Math.random) {
  const cats = categoryPool(clips, categories, weights, lastId);
  if (!cats.length) return null;
  return randomChoice(weightedChoice(cats, x => x.w, rng).clips, rng);
}

export function pickSong(library, weights, lastId, rng = Math.random) {
  return pickByCategoryWeight(library.songs, library.categories && library.categories.songs, weights, lastId, rng);
}

export function pickFromCategory(clips, cat, lastId, rng = Math.random) {
  let pool = clips.filter(c => c.cat === cat && c.id !== lastId);
  if (!pool.length) pool = clips.filter(c => c.cat === cat);
  return pool.length ? randomChoice(pool, rng) : null;
}

function categoryPool(clips, categories, weights, lastId) {
  const by = new Map();
  for (const c of clips) {
    if (c.id === lastId) continue;
    if (!by.has(c.cat)) by.set(c.cat, []);
    by.get(c.cat).push(c);
  }
  const out = [];
  for (const [name, list] of by) {
    const w = weightOf(weights, name, categories);
    if (w > 0) out.push({ name, w, clips: list });
  }
  return out;
}

export function weightedChoice(items, wf, rng) {
  const total = items.reduce((s, x) => s + wf(x), 0);
  let r = rng() * total;
  for (const x of items) { r -= wf(x); if (r < 0) return x; }
  return items[items.length - 1];
}
const randomChoice = (a, rng) => a[Math.min(a.length - 1, Math.floor(rng() * a.length))];

/* ---------------- лимиты ---------------- */

export class RateLimiter {
  constructor() { this.times = []; this.lastSong = -Infinity; }
  canRespond(now, maxPerMinute) {
    this.times = this.times.filter(t => now - t < 60);
    return this.times.length < maxPerMinute;
  }
  canSing(now, intervalS) { return now - this.lastSong >= intervalS; }
  record(now, kind) {
    this.times.push(now);
    const prevSong = this.lastSong;
    if (kind === "song") this.lastSong = now;
    return prevSong;
  }
  // отменённый звук не должен занимать место в лимите
  unrecord(at, kind, prevSong) {
    const i = this.times.lastIndexOf(at);
    if (i >= 0) this.times.splice(i, 1);
    if (kind === "song" && this.lastSong === at) this.lastSong = prevSong;
  }
}

/* ---------------- сессия ---------------- */
// Сессия получает события детектора (onOnset/onSyllable/onAborted) и такт времени (tick).
// Возвращает действия {type:"respond", ...} и пишет журнал.
// В режиме "listen" логика та же, но звуки виртуальные (без звука) — глушение детектора
// тоже применяется, чтобы метрика считалась одинаково.

export class Session {
  constructor({ library, settings, mode, rng = Math.random, startTime = 0, clipDuration, featurize }) {
    this.lib = library;
    this.s = { ...DEFAULT_SETTINGS, ...settings };
    this.s.weights = { calls: {}, songs: {}, ...(this.s.weights || {}) };
    this.s.rules = { calls: {}, songs: {}, ...(this.s.rules || {}) };
    this.mode = mode;                       // "respond" | "listen"
    this.rng = rng;
    this.t0 = startTime;
    this.clipDuration = clipDuration || (c => c.dur + 0.05);
    this.featurize = featurize || null;     // сэмплы → признаки (для песни целиком)
    this.limiter = new RateLimiter();
    this.log = [];
    this.bout = null;
    this.pending = [];
    this.lastCallId = null; this.lastSongId = null;
    this.mutes = [];
    this.seq = 0;
    this.soundOn = null;                    // птица сейчас издаёт звук
    this.lastActivity = startTime + 1;      // для инициативы в тишине
    this.nextSilence = null;
    this.lastHeard = null;                  // для экрана: что услышали последним
  }

  push(type, t, extra = {}) { const e = { type, t, ...extra }; this.log.push(e); return e; }
  activity(t) { this.lastActivity = Math.max(this.lastActivity, t); this.nextSilence = null; }

  onOnset(t) {
    this.soundOn = t;
    this.activity(t);
    return this.cancelPending(t, "птица снова заговорила", p => !p.manual);
  }
  onAborted() { this.soundOn = null; }
  stop(now) { return this.cancelPending(now, "стоп", () => true); }

  cancelPending(t, reason, filter) {
    const cancelled = [];
    this.pending = this.pending.filter(p => {
      if (p.at > t && filter(p)) {
        cancelled.push(p);
        this.push("cancelled", t, { rid: p.rid, clip: p.clip.id, kind: p.kind, virtual: p.virtual, reason });
        this.mutes = this.mutes.filter(m => m !== p.mute);
        this.limiter.unrecord(p.at, p.kind, p.prevSong);
        return false;
      }
      return true;
    });
    return cancelled;
  }

  onSyllable(ev) {
    this.soundOn = null;
    this.activity(ev.t1);
    const actions = [];
    const gap = this.bout ? ev.t0 - this.bout.t1 : Infinity;
    if (this.bout && gap >= (this.bout.isSong ? this.s.songGapS : this.s.boutGapS)) {
      actions.push(...this.finishBout(this.bout.t1 + gap));
    }
    if (!this.bout) this.bout = { t0: ev.t0, t1: ev.t1, syl: [], isSong: false };
    const b = this.bout;
    b.syl.push(ev);
    b.t1 = Math.max(b.t1, ev.t1);
    this.push("syllable", ev.t0, { t1: ev.t1, dur: +(ev.t1 - ev.t0).toFixed(3),
      f0: ev.features ? Math.round(ev.features.f0) : null,
      centroid: ev.features ? Math.round(ev.features.centroid) : null });
    if (!b.isSong && this.looksLikeSong(b)) {
      b.isSong = true;
      this.push("bird_song_start", b.t0);
    }
    return actions;
  }

  looksLikeSong(b) {
    const dur = b.t1 - b.t0;
    const longest = Math.max(...b.syl.map(s => s.t1 - s.t0));
    return dur >= this.s.songMinS && (b.syl.length >= this.s.songMinSyllables || longest >= this.s.motifMinS);
  }

  get birdSinging() { return !!(this.bout && this.bout.isSong); }

  tick(now) {
    if (this.soundOn !== null) return [];                // птица звучит — ждём конца
    if (this.bout) {
      const gap = now - this.bout.t1;
      if (gap >= (this.bout.isSong ? this.s.songGapS : this.s.boutGapS)) return this.finishBout(now);
      return [];
    }
    return this.maybeInitiate(now);
  }

  /* ----- тишина: программа сама заводит разговор ----- */
  maybeInitiate(now) {
    const s = this.s;
    if (!s.silenceEnabled) return [];
    if (this.pending.some(p => p.end > now)) return [];   // мы ещё звучим
    if (this.nextSilence === null) {
      const gap = s.silenceMinS + this.rng() * Math.max(0, s.silenceMaxS - s.silenceMinS);
      this.nextSilence = this.lastActivity + gap;
    }
    if (now < this.nextSilence) return [];
    this.nextSilence = null;
    this.activity(now);
    const at = now + 0.05;
    if (!this.limiter.canRespond(at, s.maxPerMinute)) return [this.skip(now, "initiative", "лимит в минуту")];
    const sing = s.songsEnabled && this.limiter.canSing(at, s.songIntervalS) && this.rng() < s.silenceSongChance;
    const clip = sing
      ? pickSong(this.lib, s.weights.songs, this.lastSongId, this.rng)
      : pickByCategoryWeight(this.lib.calls, this.lib.categories && this.lib.categories.calls, s.weights.calls, this.lastCallId, this.rng);
    if (!clip) return [this.skip(now, "initiative", "нет подходящих клипов")];
    return [this.schedule(sing ? "song" : "call", clip, at, { initiative: true })];
  }

  finishBout(now) {
    const b = this.bout;
    this.bout = null;
    if (b.isSong) {
      this.push("bird_song_end", b.t1, { dur: +(b.t1 - b.t0).toFixed(2), syllables: b.syl.length });
      return this.decideSong(b, now);
    }
    return this.decideCall(b, now);
  }

  decideCall(b, now) {
    const s = this.s;
    const target = b.syl.reduce((a, x) => (x.t1 - x.t0 > a.t1 - a.t0 ? x : a));
    this.callRefs ||= [...this.lib.calls, ...(this.lib.refs || [])];
    const heard = target.features
      ? classify(target.features, this.callRefs, this.lib.stats.calls, { k: s.classifyK, minVotes: s.classifyMinVotes })
      : { cat: UNLABELED };
    for (const x of b.syl) this.push("bird_call", x.t0, { t1: x.t1, cat: x === target ? heard.cat : undefined });
    this.lastHeard = { cat: heard.cat, kind: "call", t: b.t1 };
    const rule = ruleFor(s.rules, "calls", heard.cat);
    const at = Math.max(b.t1 + s.delayS, now + 0.02);
    const info = { heard: heard.cat, rule };
    if (rule === NONE) return [this.skip(now, "call", `узнан звук «${heard.cat}» — по правилу не отвечаем`, info)];
    const p = heard.cat === UNLABELED ? s.probability : s.probabilityKnown;
    if (this.rng() >= p) return [this.skip(now, "call", "вероятность", info)];
    if (!this.limiter.canRespond(at, s.maxPerMinute)) return [this.skip(now, "call", "лимит в минуту", info)];
    let clip = null;
    if (rule !== SIMILAR) clip = pickFromCategory(this.lib.calls, rule, this.lastCallId, this.rng);
    if (!clip && target.features) clip = pickCall(target.features, this.lib, s.weights.calls, this.lastCallId, this.rng, s.nearestK);
    if (!clip) return [this.skip(now, "call", "нет подходящих клипов", info)];
    return [this.schedule("call", clip, at, info)];
  }

  songFeatures(b) {
    const withSamples = b.syl.filter(x => x.samples && x.samples.length);
    if (this.featurize && withSamples.length) {
      const n = withSamples.reduce((a, x) => a + x.samples.length, 0);
      const all = new Float32Array(n);
      let o = 0;
      for (const x of withSamples) { all.set(x.samples, o); o += x.samples.length; }
      return this.featurize(all);
    }
    const fs = b.syl.map(x => x.features).filter(Boolean);
    if (!fs.length) return null;
    const med = k => median(fs.map(f => f[k]));
    const spec = fs[0].spec ? fs[0].spec.map((_, i) => median(fs.map(f => f.spec[i]))) : undefined;
    return { dur: b.t1 - b.t0, f0: med("f0"), centroid: med("centroid"), spec };
  }

  decideSong(b, now) {
    const s = this.s;
    const f = this.songFeatures(b);
    const heard = f ? classify(f, this.lib.songs, this.lib.stats.songs, { k: s.classifyK, minVotes: s.classifyMinVotes, useDur: false })
                    : { cat: UNLABELED };
    this.log[this.log.length - 1].cat = heard.cat;          // в запись bird_song_end
    this.lastHeard = { cat: heard.cat, kind: "song", t: b.t1 };
    const rule = ruleFor(s.rules, "songs", heard.cat);
    const info = { heard: heard.cat, rule };
    if (!s.songsEnabled) return [this.skip(now, "song", "песни выключены", info)];
    if (rule === NONE) return [this.skip(now, "song", `узнана песня «${heard.cat}» — по правилу не отвечаем`, info)];
    const at = Math.max(b.t1 + s.delayS, now + 0.02);
    if (!this.limiter.canSing(at, s.songIntervalS)) return [this.skip(now, "song", "лимит песен", info)];
    if (!this.limiter.canRespond(at, s.maxPerMinute)) return [this.skip(now, "song", "лимит в минуту", info)];
    let clip = null;
    if (rule !== BY_WEIGHT && rule !== SIMILAR) clip = pickFromCategory(this.lib.songs, rule, this.lastSongId, this.rng);
    if (!clip) clip = pickSong(this.lib, s.weights.songs, this.lastSongId, this.rng);
    if (!clip) return [this.skip(now, "song", "нет подходящих клипов", info)];
    return [this.schedule("song", clip, at, info)];
  }

  // Ручной запуск («Спеть», кнопки категорий). Подчиняется тем же лимитам.
  manual(kind, now, cat = null) {
    const s = this.s;
    if (this.mode !== "respond") return { ok: false, reason: "режим «Только слушать»" };
    if (kind === "song" && !this.limiter.canSing(now, s.songIntervalS)) {
      const wait = Math.ceil(s.songIntervalS - (now - this.limiter.lastSong));
      return { ok: false, reason: `лимит песен: ещё ${wait} с` };
    }
    if (!this.limiter.canRespond(now, s.maxPerMinute)) return { ok: false, reason: "лимит звуков в минуту" };
    const clips = kind === "song" ? this.lib.songs : this.lib.calls;
    const last = kind === "song" ? this.lastSongId : this.lastCallId;
    const clip = cat ? pickFromCategory(clips, cat, last, this.rng)
                     : (kind === "song" ? pickSong(this.lib, s.weights.songs, last, this.rng) : null);
    if (!clip) return { ok: false, reason: "нет клипов" };
    this.activity(now);
    return { ok: true, action: this.schedule(kind, clip, now + 0.05, { manual: true }) };
  }

  schedule(kind, clip, at, { manual = false, initiative = false, heard, rule } = {}) {
    const virtual = this.mode === "listen";
    const dur = this.clipDuration(clip);
    const mute = { from: at, to: at + dur + this.s.muteTailS, virtual };
    this.mutes.push(mute);
    const prevSong = this.limiter.record(at, kind);
    if (kind === "song") this.lastSongId = clip.id; else this.lastCallId = clip.id;
    this.activity(at + dur);
    const rid = ++this.seq;
    const a = { type: "respond", rid, kind, clip, at, end: at + dur, virtual, manual, initiative, mute, prevSong, heard, rule };
    this.pending.push(a);
    const base = initiative ? "initiative" : manual ? "response_manual" : "response";
    const type = virtual && !manual ? base + "_virtual" : base;
    this.push(type, at, { rid, kind, clip: clip.id, cat: clip.cat, heard, end: +(at + dur).toFixed(3), mute_to: +mute.to.toFixed(3) });
    return a;
  }

  started(now) { this.pending = this.pending.filter(p => p.end > now); }
  skip(t, kind, reason, extra = {}) { return this.push("skipped", t, { kind, reason, ...extra }); }
  note(t, text) { return this.push("note", t, { text }); }
}

/* ---------------- метрики ---------------- */

export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function unionLength(intervals, lo, hi) {
  const iv = intervals.map(m => [Math.max(lo, m.from), Math.min(hi, m.to)]).filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0, cur = null;
  for (const [a, b] of iv) {
    if (!cur || a > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [a, b]; }
    else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

function replyStats(events, onsets, windowS) {
  const lat = [];
  let replied = 0, replied05 = 0;
  for (const r of events) {
    const o = onsets.find(t => t > r.end);
    if (o !== undefined && o - r.end <= windowS) { replied++; lat.push(o - r.end); if (o - r.end <= 0.5) replied05++; }
  }
  const n = events.length;
  return { n, share: n ? replied / n : null, share05: n ? replied05 / n : null, lat };
}

// Одинаково для реальных и виртуальных звуков.
// Отклик: первый слог птицы, начавшийся после конца звука программы, не позже чем через windowS.
export function computeMetrics(log, { start, end, mutes = [], windowS = 1.0 }) {
  const onsets = log.filter(e => e.type === "syllable").map(e => e.t).sort((a, b) => a - b);
  const cancelled = new Set(log.filter(e => e.type === "cancelled").map(e => e.rid));
  const alive = types => log.filter(e => types.includes(e.type) && !cancelled.has(e.rid) && e.t < end);
  const resp = replyStats(alive(["response", "response_virtual"]), onsets, windowS);
  const init = replyStats(alive(["initiative", "initiative_virtual"]), onsets, windowS);
  const recognized = {};
  for (const e of log) if ((e.type === "bird_call" || e.type === "bird_song_end") && e.cat && e.cat !== UNLABELED) {
    recognized[e.cat] = (recognized[e.cat] || 0) + 1;
  }
  return {
    durationS: end - start,
    birdCalls: log.filter(e => e.type === "bird_call").length,
    birdSongs: log.filter(e => e.type === "bird_song_end").length,
    recognized,
    responses: resp.n,
    initiatives: init.n,
    manual: alive(["response_manual"]).length,
    cancelled: cancelled.size,
    replyShare: resp.share,
    replyShare05: resp.share05,
    medianLatencyS: median(resp.lat),
    initiativeReplyShare: init.share,
    mutedS: unionLength(mutes, start, end),
    notes: log.filter(e => e.type === "note").length,
  };
}
