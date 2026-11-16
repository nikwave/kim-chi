// Успокаивающий режим: планировщик «выходов» птиц и звуковые формулы, без Web Audio.
// Выход — одиночный чирик, пара (второй через 3–5 с) или трель (4–6 коротких подряд);
// после выхода тишина 10–20 с. Все случайные параметры выбираются здесь, чтобы их можно было тестировать.

import { weightedChoice, UNLABELED } from "./logic.js";

export const CALM = {
  restMinS: 10, restMaxS: 20,
  longSilenceChance: 0.05, longSilenceMinS: 40, longSilenceMaxS: 90,
  mix: { single: 0.55, pair: 0.25, trill: 0.20 },
  pairGapMinS: 3, pairGapMaxS: 5,
  trillMin: 4, trillMax: 6, trillGapMinS: 0.25, trillGapMaxS: 0.9, trillPanJitter: 0.05,
  songShare: 0.25,
  firstDelayMinS: 2, firstDelayMaxS: 6,
  recentWindow: 8,
  gainJitterDb: 3, rateJitter: 0.03,
  panKim: -0.35, panChi: 0.35, panJitter: 0.1, panUnknown: 0.4,
};

// множитель паузы между выходами
export const FREQUENCY = { rare: 1.6, normal: 1, lively: 0.6 };

// Вес клипа-крика по категории (по умолчанию 1). Призывы «эй» и «посмотрите на меня» и «злость» не звучат.
const CALL_WEIGHTS = { "эй": 0, "посмотрите на меня": 0, "злость": 0, "забота": 3 };
// Вес категории песен (по умолчанию 1): сначала категория, потом клип в ней — так Ким и Чи звучат поровну.
const SONG_WEIGHTS = { "Ким": 1, "Чи": 1, "Ким и Чи": 0.5, "забота": 0.5, [UNLABELED]: 0.5 };

const WHO = {
  songs: { "Ким": "kim", "Чи": "chi" },
  calls: { "позывной Кима": "kim", "позывной Чи": "chi" },
};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function createPlanner({ library, rng = Math.random, frequency = "normal" }) {
  let mult = FREQUENCY[frequency] ?? 1;
  const lists = { calls: library.calls || [], songs: library.songs || [] };
  const recent = { calls: [], songs: [] };
  const uni = (a, b) => a + rng() * (b - a);

  function pickClip(group) {
    const weightOf = group === "calls"
      ? c => CALL_WEIGHTS[c.cat] ?? 1
      : c => SONG_WEIGHTS[c.cat] ?? 1;
    const allowed = lists[group].filter(c => weightOf(c) > 0);
    if (!allowed.length) return null;
    const fresh = allowed.filter(c => !recent[group].includes(c.id));
    const pool = fresh.length ? fresh : allowed;
    let clip;
    if (group === "calls") {
      clip = weightedChoice(pool, weightOf, rng);
    } else {
      const byCat = new Map();
      for (const c of pool) { if (!byCat.has(c.cat)) byCat.set(c.cat, []); byCat.get(c.cat).push(c); }
      const cats = [...byCat].map(([cat, clips]) => ({ w: weightOf(clips[0]), clips }));
      const list = weightedChoice(cats, x => x.w, rng).clips;
      clip = list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
    }
    recent[group].push(clip.id);
    if (recent[group].length > CALM.recentWindow) recent[group].shift();
    return clip;
  }

  function panFor(who) {
    if (who === "kim") return CALM.panKim + uni(-CALM.panJitter, CALM.panJitter);
    if (who === "chi") return CALM.panChi + uni(-CALM.panJitter, CALM.panJitter);
    return uni(-CALM.panUnknown, CALM.panUnknown);
  }

  // trillPan: если задан — панорама трели (одна точка ± небольшое дрожание)
  function makeItem(group, gapBeforeS, trillPan = null) {
    const clip = pickClip(group);
    if (!clip) return null;
    const who = WHO[group][clip.cat] || null;
    const pan = trillPan === null ? panFor(who)
      : clamp(trillPan + uni(-CALM.trillPanJitter, CALM.trillPanJitter), -1, 1);
    return {
      clip, group, who, gapBeforeS, pan,
      gainDb: uni(-CALM.gainJitterDb, CALM.gainJitterDb),
      rate: 1 + uni(-CALM.rateJitter, CALM.rateJitter),
    };
  }

  const other = g => (g === "calls" ? "songs" : "calls");
  const anyItem = (group, gap) => makeItem(group, gap) || makeItem(other(group), gap);
  const chooseGroup = () => (rng() < CALM.songShare ? "songs" : "calls");

  function trill() {
    const first = makeItem("calls", 0) || makeItem("songs", 0);
    if (!first) return [];
    const items = [first];
    const n = CALM.trillMin + Math.floor(rng() * (CALM.trillMax - CALM.trillMin + 1));
    while (items.length < n) {
      const it = makeItem(first.group, uni(CALM.trillGapMinS, CALM.trillGapMaxS), first.pan);
      if (!it) break;
      items.push(it);
    }
    return items;
  }

  return {
    firstDelayS: () => uni(CALM.firstDelayMinS, CALM.firstDelayMaxS),
    setFrequency(name) { mult = FREQUENCY[name] ?? 1; },
    nextEpisode() {
      const r = rng();
      const kind = r < CALM.mix.single ? "single" : r < CALM.mix.single + CALM.mix.pair ? "pair" : "trill";
      let items;
      if (kind === "single") items = [anyItem(chooseGroup(), 0)];
      else if (kind === "pair") items = [anyItem(chooseGroup(), 0), anyItem(chooseGroup(), uni(CALM.pairGapMinS, CALM.pairGapMaxS))];
      else items = trill();
      const restAfterS = rng() < CALM.longSilenceChance
        ? uni(CALM.longSilenceMinS, CALM.longSilenceMaxS)
        : uni(CALM.restMinS, CALM.restMaxS) * mult;
      return { kind, items: items.filter(Boolean), restAfterS };
    },
  };
}

// Усиление клипа до общего уровня; пик после усиления не выше peakCeil.
export function normalizeGain(rms, peak, { targetRms = 0.15, minGain = 0.25, maxGain = 4, peakCeil = 0.9 } = {}) {
  let g = rms > 0 ? clamp(targetRms / rms, minGain, maxGain) : maxGain;
  if (peak > 0) g = Math.min(g, peakCeil / peak);
  return g;
}

// Положение ползунка 0–100 → усиление мастера.
export function volumeToGain(v) {
  const x = clamp(Number.isFinite(v) ? v : 0, 0, 100) / 100;
  return Math.pow(x, 1.5);
}

// Шум с экспоненциальным затуханием (−60 дБ к концу) для «комнатной» реверберации.
export function impulseResponse(sampleRate, seconds, rng = Math.random) {
  const n = Math.round(sampleRate * seconds), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rng() * 2 - 1) * Math.exp(-6.9 * i / n);
  return out;
}

/* ---------- таймер сна и вид страницы ---------- */

// Варианты таймера в минутах (0 — выключен); последние FADE_OUT_S секунд звук плавно затухает.
export const SLEEP_OPTIONS = [0, 15, 30, 60, 90];
export const FADE_OUT_S = 30;

// «28:41» или «1:02:05»; секунды округляются вверх, чтобы 0:00 показывалось только в самом конце.
export function formatRemaining(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// Вид страницы: день — всегда светлая; вечер (по умолчанию) — сумерки, пока звучит или только что закончился таймер;
// ночь — всегда тёмная и тусклая (dusk — сумерки, deep — ещё темнее).
export function lookFor(theme, active) {
  if (theme === "day") return { dusk: false, deep: false };
  if (theme === "night") return { dusk: true, deep: true };
  return { dusk: !!active, deep: false };
}
