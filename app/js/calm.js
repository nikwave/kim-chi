// Страница «Ким и Чи для меня»: тихие живые чирики для человека.
// Планирование — calm-logic.js; здесь Web Audio, страница и настройки.
// Эпизоды ставятся в расписание аудио-часов заранее (на LOOKAHEAD_S), чтобы звук не зависел
// от таймеров страницы: у фоновых вкладок они притормаживаются.

import { createPlanner, normalizeGain, volumeToGain, impulseResponse, formatRemaining, lookFor, SLEEP_OPTIONS, FADE_OUT_S, FREQUENCY } from "./calm-logic.js?v=1";

const LOOKAHEAD_S = 75;     // на сколько секунд вперёд расписан звук
const TICK_MS = 2000;       // как часто проверяем, не пора ли расписать дальше
const FADE_S = 0.015;       // плавное начало и конец каждого чирика
const START_FADE_S = 2;     // нарастание громкости при старте
const STOP_FADE_S = 0.3;    // затухание при паузе
const REVERB_S = 0.7, REVERB_WET = 0.15;
const SETTINGS_KEY = "calm-settings";

const $ = s => document.querySelector(s);

/* ---------- настройки ---------- */
const THEMES = {
  day: "Всегда светло.",
  evening: "Светло, а когда звучит — вечерние сумерки.",
  night: "Очень тёмная и тусклая — для сна.",
};
const state = { volume: 40, freq: "normal", wake: false, sleep: 0, theme: "evening" };
try {
  const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  if (Number.isFinite(s.volume)) state.volume = Math.min(100, Math.max(0, s.volume));
  if (s.freq in FREQUENCY) state.freq = s.freq;
  if (typeof s.wake === "boolean") state.wake = s.wake;
  if (SLEEP_OPTIONS.includes(s.sleep)) state.sleep = s.sleep;
  if (s.theme in THEMES) state.theme = s.theme;
} catch { /* нет хранилища — работаем со значениями по умолчанию */ }
// Только для проверки: ?sleepSec=40 ставит таймер на 40 секунд вместо выбранных минут.
let sleepTestSec = 0;
try { sleepTestSec = Number(new URLSearchParams(location.search).get("sleepSec")) || 0; } catch { /* не браузер */ }
function save() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state)); } catch { /* */ } }

/* ---------- звук ---------- */
let LIB = null, planner = null;
let ctx = null, master = null, fadeNode = null, dryBus = null, convolver = null;
const compressed = new Map();     // id → ArrayBuffer
const decoded = new Map();        // id → AudioBuffer (для текущего ctx)
const levels = new WeakMap();     // AudioBuffer → усиление выравнивания
let playing = false, epoch = 0, pumping = false, tick = null, nextStart = 0;
let voices = [];                  // { src, when, end }
let cueTimers = [];

function ensureContext() {
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* нет API */ }
  if (ctx && ctx.state !== "closed") return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  decoded.clear();
  const comp = ctx.createDynamicsCompressor();     // страховка от неожиданно громких мест
  comp.threshold.value = -10; comp.knee.value = 12; comp.ratio.value = 6;
  comp.attack.value = 0.003; comp.release.value = 0.2;
  comp.connect(ctx.destination);
  fadeNode = ctx.createGain();                      // затухание таймера сна, отдельно от громкости
  fadeNode.connect(comp);
  master = ctx.createGain();
  master.gain.value = 0;
  master.connect(fadeNode);
  dryBus = ctx.createGain();
  dryBus.connect(master);
  convolver = ctx.createConvolver();                // «комнатная» реверберация
  const ir = ctx.createBuffer(2, Math.round(ctx.sampleRate * REVERB_S), ctx.sampleRate);
  ir.copyToChannel(impulseResponse(ctx.sampleRate, REVERB_S), 0);
  ir.copyToChannel(impulseResponse(ctx.sampleRate, REVERB_S), 1);
  convolver.buffer = ir;
  const wet = ctx.createGain();
  wet.gain.value = REVERB_WET;
  convolver.connect(wet).connect(master);
  ctx.onstatechange = () => {
    if (playing && ctx.state !== "running") stop("Звук остановлен системой — нажмите «Играть».");
  };
  return ctx;
}

async function prefetch(clips, onProgress) {
  let done = 0;
  const queue = clips.filter(c => !compressed.has(c.id));
  const worker = async () => {
    while (queue.length) {
      const c = queue.shift();
      try {
        const r = await fetch(c.file);
        if (!r.ok) throw new Error(r.status);
        compressed.set(c.id, await r.arrayBuffer());
      } catch (e) { console.warn("не скачан", c.id, e); }
      onProgress?.(++done, clips.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

async function buffer(clip) {
  if (decoded.has(clip.id)) return decoded.get(clip.id);
  let ab = compressed.get(clip.id);
  if (!ab) {
    const r = await fetch(clip.file);
    if (!r.ok) throw new Error(r.status);
    ab = await r.arrayBuffer();
    compressed.set(clip.id, ab);
  }
  const buf = await ctx.decodeAudioData(ab.slice(0));
  if (decoded.size > 60) decoded.delete(decoded.keys().next().value);
  decoded.set(clip.id, buf);
  return buf;
}

function levelOf(buf) {
  if (levels.has(buf)) return levels.get(buf);
  const x = buf.getChannelData(0);
  let sum = 0, peak = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); sum += a * a; if (a > peak) peak = a; }
  const g = normalizeGain(Math.sqrt(sum / Math.max(1, x.length)), peak);
  levels.set(buf, g);
  return g;
}

// Поставить один чирик на момент `when` (часы ctx); возвращает момент конца.
function voice(buf, item, when) {
  const dur = buf.duration / item.rate;
  const level = levelOf(buf) * Math.pow(10, item.gainDb / 20);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = item.rate;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(level, when + FADE_S);
  env.gain.setValueAtTime(level, Math.max(when + FADE_S, when + dur - FADE_S));
  env.gain.linearRampToValueAtTime(0, when + dur);
  src.connect(env);
  let out = env;
  if (ctx.createStereoPanner) {
    const pan = ctx.createStereoPanner();
    pan.pan.value = item.pan;
    env.connect(pan);
    out = pan;
  }
  out.connect(dryBus);
  out.connect(convolver);
  const v = { src, when, end: when + dur };
  voices.push(v);
  src.onended = () => {
    voices = voices.filter(x => x !== v);
    try { src.disconnect(); env.disconnect(); out.disconnect(); } catch { /* уже */ }
  };
  src.start(when);
  src.stop(when + dur + 0.02);
  cue(item, when, dur);
  return when + dur;
}

// Лёгкая подсказка на экране: Ким подпрыгивает, Чи «поёт».
function cue(item, when, dur) {
  const ms = Math.max(0, (when - ctx.currentTime) * 1000);
  const cls = item.who === "kim" ? "bird-heard" : "prog-singing";
  const hold = item.who === "kim" ? 600 : Math.max(400, dur * 1000);
  cueTimers.push(setTimeout(() => document.body.classList.add(cls), ms));
  cueTimers.push(setTimeout(() => document.body.classList.remove(cls), ms + hold));
}
function clearCues() {
  cueTimers.forEach(clearTimeout);
  cueTimers = [];
  document.body.classList.remove("bird-heard", "prog-singing");
}

/* ---------- расписание ---------- */
async function pump(myEpoch) {
  if (pumping || !playing) return;
  pumping = true;
  try {
    while (playing && myEpoch === epoch && nextStart < ctx.currentTime + LOOKAHEAD_S && (!timerEndAt || nextStart < timerEndAt)) {
      const ep = planner.nextEpisode();
      console.info(`[calm] ${ep.kind}: ${ep.items.length} клипов, пауза ${ep.restAfterS.toFixed(1)} с`);
      const bufs = await Promise.all(ep.items.map(it => buffer(it.clip).catch(e => { console.warn("не декодирован", it.clip.id, e); return null; })));
      if (!playing || myEpoch !== epoch) return;
      let t = Math.max(nextStart, ctx.currentTime + 0.05);
      ep.items.forEach((it, i) => {
        t += it.gapBeforeS;
        if (bufs[i]) t = voice(bufs[i], it, t);
      });
      nextStart = t + ep.restAfterS;
    }
  } finally { pumping = false; }
}

// Убрать всё, что ещё не зазвучало (смена «как часто»), и начать заново через 2–6 с.
function replan() {
  const now = ctx.currentTime;
  let busyUntil = now;
  for (const v of [...voices]) {
    if (v.when > now + 0.05) { try { v.src.stop(); } catch { /* */ } voices = voices.filter(x => x !== v); }
    else busyUntil = Math.max(busyUntil, v.end);
  }
  clearCues();
  epoch++;
  nextStart = busyUntil + planner.firstDelayS();
  pump(epoch);
}

/* ---------- старт и пауза ---------- */
let wake = null;
async function holdWake() {
  if (!state.wake || !playing || wake) return;
  if (!("wakeLock" in navigator)) { $("#wakeHint").textContent = "Этот браузер не умеет удерживать экран включённым."; return; }
  try {
    wake = await navigator.wakeLock.request("screen");
    wake.addEventListener("release", () => { wake = null; });
  } catch { /* отказ — не страшно */ }
}
function releaseWake() { try { wake?.release(); } catch { /* */ } wake = null; }

/* ---------- таймер сна ---------- */
let timerEnded = false;           // таймер только что выключил звук: остаёмся в сумерках, чтобы экран не вспыхнул
let timerEndMs = 0, timerTotalS = 0, timerEndAt = 0, timerTick = null;   // конец: часы страницы, всего секунд, часы ctx

function armTimer() {
  disarmTimer();
  const totalS = sleepTestSec || state.sleep * 60;
  if (!playing || !totalS) return;
  timerTotalS = totalS;
  timerEndMs = Date.now() + totalS * 1000;
  const now = ctx.currentTime, fadeS = Math.min(FADE_OUT_S, totalS / 2);
  timerEndAt = now + totalS;
  const g = fadeNode.gain;                 // затухание расписано по аудио-часам: работает и в фоновой вкладке
  g.cancelScheduledValues(now);
  g.setValueAtTime(1, now);
  g.setValueAtTime(1, timerEndAt - fadeS);
  g.linearRampToValueAtTime(0, timerEndAt);
  timerTick = setInterval(timerStep, 1000);
  timerStep();
}

function disarmTimer() {
  clearInterval(timerTick); timerTick = null;
  timerEndMs = 0; timerEndAt = 0;
  if (ctx && fadeNode && ctx.state !== "closed") {
    const g = fadeNode.gain, now = ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(1, now + 0.5);
  }
  showTimer(0);
}

function timerStep() {
  const left = (timerEndMs - Date.now()) / 1000;
  if (left <= 0) { timerEnded = true; stop("Таймер сна вышел — спокойной ночи ♡"); return; }
  showTimer(left);
}

function showTimer(left) {
  $("#sleepLeft").textContent = left > 0 ? `осталось ${formatRemaining(left)}` : "";
  $(".player").classList.toggle("timed", left > 0);
  if (left > 0) $("#ringFg").style.strokeDashoffset = String(502.65 * (1 - left / timerTotalS));
}

/* ---------- вид и кнопка ---------- */
function applyLook() {
  const look = lookFor(state.theme, playing || timerEnded);
  document.body.classList.toggle("dusk", look.dusk);
  document.body.classList.toggle("deep", look.deep);
  try { $("meta[name=theme-color]").setAttribute("content", look.deep ? "#0b0828" : look.dusk ? "#2b2361" : "#efe3ff"); } catch { /* */ }
  $("#themeHint").textContent = THEMES[state.theme];
  document.querySelectorAll("#theme button").forEach(b => b.classList.toggle("on", b.dataset.theme === state.theme));
}

function setUi(isPlaying, status) {
  $("#playLabel").textContent = isPlaying ? "Пауза" : "Играть";
  $("#playBtn").classList.toggle("playing", isPlaying);
  $("#playBtn").setAttribute("aria-label", isPlaying ? "Пауза" : "Играть");
  document.body.classList.toggle("playing", isPlaying);
  if (status !== undefined) $("#status").textContent = status;
  applyLook();
}

async function start() {
  if (!LIB || playing) return;
  try {
    ensureContext();
    await ctx.resume();
  } catch (e) {
    setUi(false, `Не удалось включить звук: ${e && e.message ? e.message : e}`);
    return;
  }
  playing = true;
  epoch++;
  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(volumeToGain(state.volume), now + START_FADE_S);
  nextStart = now + planner.firstDelayS();
  timerEnded = false;
  setUi(true, "Ким и Чи рядом ♡");
  armTimer();
  holdWake();
  tick = setInterval(() => pump(epoch), TICK_MS);
  pump(epoch);
}

function stop(message = "Пауза") {
  if (!playing) return;
  playing = false;
  epoch++;
  clearInterval(tick); tick = null;
  clearCues();
  releaseWake();
  disarmTimer();
  setUi(false, message);
  if (!ctx || ctx.state === "closed") return;
  const now = ctx.currentTime, g = master.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(0, now + STOP_FADE_S);
  const old = voices;
  voices = [];
  setTimeout(() => {
    for (const v of old) { try { v.src.stop(); } catch { /* */ } }
    if (!playing && ctx.state === "running") ctx.suspend().catch(() => {});
  }, STOP_FADE_S * 1000 + 50);
}

/* ---------- страница ---------- */
function applyFreqUi() {
  document.querySelectorAll("#freq button").forEach(b => b.classList.toggle("on", b.dataset.freq === state.freq));
}

async function loadLibrary() {
  try {
    const r = await fetch("library.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    LIB = await r.json();
    planner = createPlanner({ library: LIB, frequency: state.freq });
    $("#playBtn").disabled = false;
    $("#status").textContent = "Нажмите «Играть»";
    const all = [...LIB.calls, ...LIB.songs];
    $("#loadBanner").textContent = `Загружаю звуки: 0 из ${all.length}`;
    prefetch(all, (d, n) => { $("#loadBanner").textContent = d < n ? `Загружаю звуки: ${d} из ${n}` : ""; });
  } catch {
    $("#loadBanner").textContent = "Не удалось загрузить звуки. Проверьте интернет и обновите страницу.";
    $("#loadBanner").classList.add("err");
    $("#status").textContent = "";
  }
}

$("#playBtn").addEventListener("click", () => (playing ? stop() : start()));

$("#volume").value = state.volume;
$("#volumeVal").textContent = `${state.volume}%`;
$("#volume").addEventListener("input", e => {
  state.volume = Number(e.target.value);
  $("#volumeVal").textContent = `${state.volume}%`;
  save();
  if (playing) master.gain.setTargetAtTime(volumeToGain(state.volume), ctx.currentTime, 0.05);
});

applyFreqUi();
document.querySelectorAll("#freq button").forEach(b => b.addEventListener("click", () => {
  if (state.freq === b.dataset.freq) return;
  state.freq = b.dataset.freq;
  save();
  applyFreqUi();
  if (planner) planner.setFrequency(state.freq);
  if (playing) replan();
}));

function applySleepUi() {
  document.querySelectorAll("#sleep button").forEach(b => b.classList.toggle("on", Number(b.dataset.sleep) === state.sleep));
}
applySleepUi();
document.querySelectorAll("#sleep button").forEach(b => b.addEventListener("click", () => {
  state.sleep = Number(b.dataset.sleep);
  save();
  applySleepUi();
  if (playing) armTimer();
}));

applyLook();
document.querySelectorAll("#theme button").forEach(b => b.addEventListener("click", () => {
  state.theme = b.dataset.theme;
  save();
  applyLook();
}));

$("#wakeToggle").checked = state.wake;
$("#wakeToggle").addEventListener("change", e => {
  state.wake = e.target.checked;
  save();
  if (state.wake) holdWake(); else releaseWake();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden || !playing) return;
  if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
  holdWake();
});

loadLibrary();
