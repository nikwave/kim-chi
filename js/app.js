import { AudioEngine } from "./audio.js?v=8";
import { computeFeatures } from "./features.js?v=8";
import { Session, DEFAULT_SETTINGS, computeMetrics, pickFromCategory, ruleFor, UNLABELED, SIMILAR, NONE, BY_WEIGHT, NOISE } from "./logic.js?v=8";
import { saveSession, listSessions, storageError } from "./storage.js?v=8";
import { sessionsToCsv, summaryCsv, shareOrDownload } from "./csv.js?v=8";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const DAY_FROM = 8, DAY_TO = 21;
const SETTINGS_VERSION = 2;

/* ---------------- состояние ---------------- */
const engine = new AudioEngine();
let LIB = null;
let settings = loadSettings();
let mode = "respond";
let testFile = null;
let run = null;            // текущая сессия
let calib = null;          // калибровка без сессии
let lastSummary = null;

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem("finch-settings") || "{}"); } catch { /* приватный режим */ }
  if ((s.version || 1) < 2) {
    // версия 2: программа активнее — берём более активное из сохранённого и нового значения
    const D = DEFAULT_SETTINGS;
    if (s.probability != null) s.probability = Math.max(s.probability, D.probability);
    if (s.maxPerMinute != null) s.maxPerMinute = Math.max(s.maxPerMinute, D.maxPerMinute);
    if (s.songIntervalS != null) s.songIntervalS = Math.min(s.songIntervalS, D.songIntervalS);
  }
  s.version = SETTINGS_VERSION;
  const out = { ...DEFAULT_SETTINGS, ...s,
    weights: { calls: {}, songs: {}, ...(s.weights || {}) }, rules: { calls: {}, songs: {}, ...(s.rules || {}) } };
  return out;
}
function saveSettings() {
  try { localStorage.setItem("finch-settings", JSON.stringify(settings)); } catch { /* */ }
}

/* ---------------- экраны ---------------- */
function go(name) {
  $$(".screen").forEach(s => s.classList.toggle("on", s.id === "screen-" + name));
  window.scrollTo(0, 0);
  if (name === "history") renderHistory();
  if (name === "settings") renderSettings();
}
$$("[data-go]").forEach(b => b.addEventListener("click", () => go(b.dataset.go)));

function confirmModal(text, yes) {
  return new Promise(resolve => {
    $("#modalText").textContent = text;
    $("#modalYes").textContent = yes;
    $("#modal").hidden = false;
    const done = v => { $("#modal").hidden = true; resolve(v); };
    $("#modalYes").onclick = () => done(true);
    $("#modalNo").onclick = () => done(false);
  });
}

/* ---------------- библиотека ---------------- */
async function loadLibrary() {
  try {
    const r = await fetch("library.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    LIB = await r.json();
    const all = [...LIB.calls, ...LIB.songs];
    $("#loadBanner").textContent = `Загружаю звуки: 0 из ${all.length}`;
    engine.prefetch(all, (d, n) => {
      $("#loadBanner").textContent = d < n ? `Загружаю звуки: ${d} из ${n}` : "";
    });
    renderCategories();
  } catch (e) {
    $("#loadBanner").textContent = "Не удалось загрузить библиотеку звуков. Проверьте интернет и обновите страницу.";
    $("#loadBanner").classList.add("err");
    $("#startBtn").disabled = true;
  }
}

/* ---------------- главный экран ---------------- */
$$("#mode button").forEach(b => b.addEventListener("click", () => {
  if (run) return;
  mode = b.dataset.mode;
  $$("#mode button").forEach(x => x.classList.toggle("on", x === b));
  renderAltHint();
}));

$("#songsToggle").addEventListener("change", e => {
  settings.songsEnabled = e.target.checked;
  saveSettings();
  if (run) run.session.s.songsEnabled = settings.songsEnabled;
});

$("#silenceToggle").addEventListener("change", e => {
  settings.silenceEnabled = e.target.checked;
  saveSettings();
  if (run) run.session.s.silenceEnabled = settings.silenceEnabled;
});

$$(".note").forEach(b => b.addEventListener("click", () => {
  if (!run) { $("#noteAck").textContent = "Заметки ставятся во время сессии."; return; }
  run.session.note(engine.ctx.currentTime, b.dataset.note);
  b.classList.add("ack"); setTimeout(() => b.classList.remove("ack"), 400);
  const m = Math.floor((engine.ctx.currentTime - run.audioStart) / 60), s = Math.floor((engine.ctx.currentTime - run.audioStart) % 60);
  $("#noteAck").textContent = `Записано: «${b.dataset.note}» на ${m}:${String(s).padStart(2, "0")}`;
}));

async function renderAltHint() {
  const list = await listSessions();
  const last = list[0];
  let text = "Чередуйте сессии: одна с ответами, следующая — «Только слушать». Так видно, отвечают ли птицы именно программе.";
  if (last) {
    const lastMode = last.mode === "listen" ? "«Только слушать»" : "«Отвечать»";
    const next = last.mode === "listen" ? "«Отвечать»" : "«Только слушать»";
    text = `Прошлая сессия была в режиме ${lastMode}. В этот раз лучше ${next}.`;
  }
  $("#altHint").textContent = text;
  $("#songIntLabel").textContent = settings.songIntervalS > 0
    ? `Не чаще раза в ${fmtInterval(settings.songIntervalS)}`
    : "Без ограничения по времени (общий лимит в минуту действует)";
  $("#silenceLabel").textContent = `${settings.silenceMinS}–${settings.silenceMaxS} с`;
}

function fmtInterval(s) { return s <= 0 ? "без ограничения" : s % 60 === 0 ? `${s / 60} мин` : `${s} с`; }
function fmtClock(s) { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

/* ---------------- старт / стоп ---------------- */
$("#startBtn").addEventListener("click", startSession);
$("#stopBar").addEventListener("click", () => stopSession("нажата кнопка «Стоп»"));

async function startSession() {
  if (run || !LIB) return;
  const h = new Date().getHours();
  if (h < DAY_FROM || h >= DAY_TO) {
    const ok = await confirmModal(
      `Сейчас ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} — вне дневного времени (${DAY_FROM}:00–${DAY_TO}:00). ` +
      "Вечером и ночью птицам нужен покой. Точно начать?", "Всё равно начать");
    if (!ok) return;
  }
  await stopCalibration();
  $("#startBtn").disabled = true;
  try {
    engine.onInterrupt = reason => stopSession(reason);
    engine.onDetector = onDetector;
    const info = await engine.startInput({ file: testFile, monitorFile: $("#monitorFile").checked, onDb: settings.onDb });
    const ctx = engine.ctx;
    const audioStart = ctx.currentTime;
    const sr = ctx.sampleRate;
    const session = new Session({
      library: LIB, settings: { ...settings, weights: structuredClone(settings.weights), rules: structuredClone(settings.rules) },
      mode, startTime: audioStart,
      clipDuration: c => (engine.decoded.get(c.id)?.duration ?? c.dur + 0.05),
      featurize: samples => computeFeatures(samples, sr),
    });
    run = {
      id: new Date().toISOString(), startedAt: new Date().toISOString(), audioStart, session, mode,
      info, sounds: new Map(), detections: 0, wake: null, timer: null, saveTimer: null,
      testFile: testFile ? testFile.name : null,
    };
    session.push("start", audioStart, { mode, test: !!testFile, mic: info });
    run.wake = await requestWakeLock();
    run.timer = setInterval(tick, 25);
    run.saveTimer = setInterval(() => persist(false), 15000);
    $("#startBtn").hidden = true;
    $("#live").hidden = false;
    $("#heardCard").hidden = false;
    document.body.classList.add("running");
    $("#heard").textContent = "—";
    $("#stopBar").hidden = false;
    $("#mode").classList.add("locked");
    renderMicStatus();
  } catch (e) {
    console.error(e);
    await engine.stopInput();
    run = null;
    const msg = e && e.name === "NotAllowedError"
      ? "Нет доступа к микрофону. Разрешите микрофон для этого сайта в настройках Safari и попробуйте снова."
      : `Не удалось запустить: ${e && e.message ? e.message : e}`;
    await confirmModal(msg, "Понятно");
  } finally {
    $("#startBtn").disabled = false;
  }
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return { error: "не поддерживается этим браузером" };
  try {
    const lock = await navigator.wakeLock.request("screen");
    lock.addEventListener("release", () => { if (run && run.wake === lock && !document.hidden) requestWakeLock().then(w => { if (run) run.wake = w; }); });
    return lock;
  } catch (e) { return { error: e.message || String(e) }; }
}

function onDetector(m) {
  if (m.type === "level") { drawMeter(m); return; }
  if (!run) { if (calib) onCalibMessage(m); return; }
  const s = run.session;
  if (m.type === "onset") {
    flashDetection();
    for (const p of s.onOnset(m.t)) cancelSound(p);
  } else if (m.type === "aborted") {
    s.onAborted();
  } else if (m.type === "syllable") {
    run.detections++;
    let features = null;
    try { features = computeFeatures(m.samples, engine.ctx.sampleRate); } catch (e) { console.warn(e); }
    handleActions(s.onSyllable({ t0: m.t0, t1: m.t1, features, samples: m.samples }));
  }
}

function tick() {
  if (!run) return;
  const now = engine.ctx.currentTime;
  const s = run.session;
  handleActions(s.tick(now));
  s.started(now);
  const left = settings.sessionMinutes * 60 - (now - run.audioStart);
  $("#timer").textContent = fmtClock(left);
  let status = "Слушаю…";
  const playing = [...run.sounds.values()].find(p => now >= p.at && now < p.end);
  if (playing) {
    const what = playing.initiative ? "Завожу разговор" : playing.kind === "song" ? "Пою песню" : "Отвечаю";
    status = playing.virtual ? `${what} (виртуально, без звука)` : what;
  }
  else if (s.birdSinging) status = "Птица поёт — жду конца песни";
  $("#status").textContent = status;
  document.body.classList.toggle("prog-singing", !!playing);
  const calls = s.log.filter(e => e.type === "bird_call").length;
  const resp = s.log.filter(e => /^response/.test(e.type)).length - s.log.filter(e => e.type === "cancelled").length;
  $("#counts").textContent = `Криков птиц: ${calls} · ответов${mode === "listen" ? " (виртуальных)" : ""}: ${resp}`;
  if (left <= 0) stopSession("время сессии истекло");
}

function handleActions(actions) {
  for (const a of actions) {
    if (a.type === "respond") scheduleSound(a);
    showHeard(a);
  }
}

// «Услышал: забота → отвечаю: забота» — чтобы было видно, что программа поняла.
function showHeard(a) {
  if (!run) return;
  if (a.initiative || a.kind === "initiative") {
    if (a.type === "respond") $("#heard").innerHTML = `Тишина → завожу разговор: <b>${escapeHtml(soundName(a.kind, a.clip.cat))}</b>${a.virtual ? " (виртуально)" : ""}`;
    return;
  }
  const h = run.session.lastHeard;
  if (!h) return;
  const heardTxt = h.cat === UNLABELED ? (h.kind === "song" ? "песня (не узнал чья)" : "крик")
    : h.cat === NOISE ? "шум или посторонний звук" : soundName(h.kind, h.cat);
  const ans = a.type === "respond"
    ? `${a.virtual ? "ответ (виртуально)" : "отвечаю"}: <b>${escapeHtml(soundName(a.kind, a.clip.cat))}</b>`
    : `не отвечаю (${escapeHtml(a.reason)})`;
  $("#heard").innerHTML = `Услышал: <b>${escapeHtml(heardTxt)}</b> → ${ans}`;
}
const soundName = (kind, cat) => kind === "song"
  ? (cat === UNLABELED ? "песня" : `песня ${cat === "Ким" ? "Кима" : cat}`)
  : (cat === UNLABELED ? "похожий крик" : cat);

async function scheduleSound(a) {
  const r = run;
  r.sounds.set(a.rid, a);
  engine.detector({ type: "mute", from: a.mute.from, to: a.mute.to });
  if (a.virtual) return;
  try {
    const buf = await engine.buffer(a.clip);
    if (run !== r || !r.sounds.has(a.rid)) return;            // отменён, пока декодировали
    const now = engine.ctx.currentTime;
    if (now > a.at + 0.15) {                                   // не успели вовремя — не играем невпопад
      r.session.push("late", now, { rid: a.rid, clip: a.clip.id });
      r.session.cancelPending(now - 1, "не успели декодировать", p => p.rid === a.rid);
      r.sounds.delete(a.rid);
      return;
    }
    const p = engine.play(buf, a.at);
    a.source = p.source;
    // уточняем глушение по реальной длине файла
    const realTo = p.startAt + p.duration + r.session.s.muteTailS;
    if (realTo > a.mute.to) {
      engine.detector({ type: "mute", from: a.mute.from, to: realTo });
      a.mute.to = realTo;
      a.end = p.startAt + p.duration;
    }
  } catch (e) {
    console.warn("не удалось сыграть", a.clip.id, e);
  }
}

function cancelSound(p) {
  const a = run.sounds.get(p.rid);
  if (a && a.source) engine.cancel(a.source);
  engine.detector({ type: "unmute", from: p.mute.from, to: p.mute.to });
  run.sounds.delete(p.rid);
}

async function stopSession(reason) {
  if (!run) return;
  const r = run;
  run = null;
  engine.stopAllSound();
  const now = engine.ctx ? engine.ctx.currentTime : r.audioStart;
  r.session.stop(now);
  r.session.push("stop", now, { reason });
  clearInterval(r.timer); clearInterval(r.saveTimer);
  try { if (r.wake && r.wake.release) await r.wake.release(); } catch { /* */ }
  r.endAudio = now;
  r.reason = reason;
  await engine.stopInput();
  $("#stopBar").hidden = true;
  $("#startBtn").hidden = false;
  $("#live").hidden = true;
  $("#heardCard").hidden = true;
  document.body.classList.remove("prog-singing", "running");
  $("#mode").classList.remove("locked");
  const rec = await persist(true, r);
  showSummary(rec);
}

function sessionRecord(r, final) {
  const end = final ? r.endAudio : (engine.ctx ? engine.ctx.currentTime : r.audioStart);
  const s = r.session;
  const metrics = computeMetrics(s.log, { start: r.audioStart, end, mutes: s.mutes, windowS: s.s.replyWindowS });
  return {
    id: r.id, startedAt: r.startedAt, mode: r.mode, audioStart: r.audioStart, testFile: r.testFile,
    reason: final ? r.reason : "сессия не завершена (приложение закрылось?)",
    settings: { ...s.s }, mic: r.info, log: s.log,
    mutes: s.mutes.map(m => ({ from: m.from, to: m.to, virtual: m.virtual })), metrics,
  };
}

async function persist(final, r = run) {
  if (!r) return null;
  const rec = sessionRecord(r, final);
  const ok = await saveSession(rec);
  rec.saved = ok;
  return rec;
}

/* ---------------- итоги ---------------- */
function showSummary(rec) {
  lastSummary = rec;
  const m = rec.metrics;
  const pct = v => v == null ? "—" : `${Math.round(v * 100)}%`;
  const virt = rec.mode === "listen";
  const rows = [
    ["Длительность", fmtClock(m.durationS)],
    ["Режим", virt ? "Только слушать" : "Отвечать"],
    ["Остановка", rec.reason],
    ["Крики птиц", `${m.birdCalls}${m.birdSongs ? ` · песен: ${m.birdSongs}` : ""}`],
    ["Узнано", Object.entries(m.recognized || {}).map(([k, v]) => `${k}: ${v}`).join(", ") || "—"],
    [virt ? "Виртуальные ответы" : "Ответы программы", `${m.responses}${m.manual ? ` · вручную: ${m.manual}` : ""}${m.cancelled ? ` · отменено: ${m.cancelled}` : ""}`],
    ["Птицы откликнулись на ответ в течение 1 с", `${pct(m.replyShare)}${m.replyShare05 != null ? ` (за 0,5 с — ${pct(m.replyShare05)})` : ""}`],
    ["Медианная задержка отклика", m.medianLatencyS == null ? "—" : `${Math.round(m.medianLatencyS * 1000)} мс`],
    [virt ? "Виртуальные звуки в тишине" : "Звуки в тишине", `${m.initiatives ?? 0}${m.initiatives ? ` · птицы откликнулись за 1 с: ${pct(m.initiativeReplyShare)}` : ""}`],
    ["Время глушения", `${m.mutedS.toFixed(1)} с — в это время программа не слышала птиц`],
    ["Заметок", String(m.notes)],
  ];
  if (rec.testFile) rows.unshift(["Тестовый режим", rec.testFile]);
  $("#summary").innerHTML = rows.map(([k, v]) => `<div class="k">${k}</div><div>${escapeHtml(v)}</div>`).join("");
  $("#sumAlt").textContent = virt
    ? "Следующую сессию проведите в режиме «Отвечать», чтобы было с чем сравнить."
    : "Следующую сессию проведите в режиме «Только слушать» — это контроль.";
  $("#sumSaveMsg").textContent = rec.saved ? "Сессия сохранена на iPad. Всё равно сохраните CSV: хранилище может очиститься."
    : `Сессию не удалось сохранить в памяти iPad (${storageError || "ошибка"}). Обязательно сохраните CSV сейчас.`;
  go("summary");
  renderAltHint();
}

$("#sumShare").addEventListener("click", async () => {
  if (!lastSummary) return;
  const res = await shareOrDownload(`amadiny-${lastSummary.id.slice(0, 16).replace(/[:T]/g, "-")}.csv`, sessionsToCsv([lastSummary]));
  $("#sumSaveMsg").textContent = res === "cancelled" ? "Отменено." : "Готово.";
});

const escapeHtml = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------------- история ---------------- */
async function renderHistory() {
  const list = await listSessions();
  $("#storageWarn").hidden = !storageError;
  $("#storageWarn").textContent = storageError ? `Память iPad недоступна (${storageError}). Сессии хранятся только до закрытия страницы — сохраняйте CSV.` : "";
  const pct = v => v == null ? "—" : `${Math.round(v * 100)}%`;
  $("#historyList").innerHTML = list.length ? "" : `<div class="card hint">Сессий пока нет.</div>`;
  for (const s of list) {
    const m = s.metrics || {};
    const d = document.createElement("div");
    d.className = "hist";
    d.innerHTML = `<div class="head"><span>${new Date(s.startedAt).toLocaleString("ru-RU")}</span>
      <span>${s.mode === "listen" ? "Только слушать" : "Отвечать"}${s.testFile ? " · тест" : ""}</span></div>
      <div class="meta">${fmtClock(m.durationS || 0)} · криков ${m.birdCalls ?? "—"} · ответов ${m.responses ?? "—"} ·
      отклик ≤1 с ${pct(m.replyShare)} · ${escapeHtml(s.reason || "")}</div>
      <button class="btn">CSV</button>`;
    d.querySelector("button").onclick = () => shareOrDownload(`amadiny-${s.id.slice(0, 16).replace(/[:T]/g, "-")}.csv`, sessionsToCsv([s]));
    $("#historyList").appendChild(d);
  }
}
$("#exportAll").addEventListener("click", async () => shareOrDownload("amadiny-vse-sessii.csv", sessionsToCsv(await listSessions())));
$("#exportSummary").addEventListener("click", async () => shareOrDownload("amadiny-itogi.csv", summaryCsv(await listSessions())));

/* ---------------- фон, блокировка, прерывания ---------------- */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (run) stopSession("вкладка ушла в фон или экран заблокирован");
    stopCalibration();
  }
});
window.addEventListener("pagehide", () => { if (run) stopSession("страница закрыта"); });

/* ---------------- настройка ---------------- */
const SLIDERS = {
  onDb: v => `${v} дБ`,
  probability: v => `${Math.round(v * 100)}%`, probabilityKnown: v => `${Math.round(v * 100)}%`,
  silenceMinS: v => `${v} с`, silenceMaxS: v => `${v} с`, delayS: v => `${Math.round(v * 1000)} мс`,
  maxPerMinute: v => `${v}`, songIntervalS: v => fmtInterval(+v), sessionMinutes: v => `${v} мин`,
};
const VAL_ID = { onDb: "onDbVal", probability: "probVal", delayS: "delayVal",
  probabilityKnown: "probKnownVal", silenceMinS: "silMinVal", silenceMaxS: "silMaxVal",
  maxPerMinute: "limitVal", songIntervalS: "songIntVal", sessionMinutes: "sessVal" };

for (const key of Object.keys(SLIDERS)) {
  const el = $("#" + key);
  el.addEventListener("input", () => {
    let v = +el.value;
    settings[key] = v;
    if (key === "onDb") engine.detector({ type: "config", cfg: { onDb: v } });
    if (key === "silenceMinS" && settings.silenceMaxS < v) settings.silenceMaxS = v;
    if (key === "silenceMaxS" && settings.silenceMinS > v) settings.silenceMinS = v;
    if (run) for (const k of ["silenceMinS", "silenceMaxS", key]) if (k in run.session.s) run.session.s[k] = settings[k];
    saveSettings();
    renderSettingsValues();
    renderAltHint();
  });
}

function renderSettingsValues() {
  for (const [key, f] of Object.entries(SLIDERS)) {
    $("#" + key).value = settings[key];
    $("#" + VAL_ID[key]).textContent = f(settings[key]);
  }
  $("#songsToggle").checked = settings.songsEnabled;
  $("#silenceToggle").checked = settings.silenceEnabled;
}

function renderSettings() { renderSettingsValues(); renderMicStatus(); renderCategories(); renderRules(); }

function renderRules() {
  if (!LIB) return;
  for (const [group, el] of [["calls", "#rulesCalls"], ["songs", "#rulesSongs"]]) {
    const box = $(el);
    box.innerHTML = "";
    const cats = LIB.categories[group].map(c => c.name);
    const label = c => group === "songs" && c !== UNLABELED ? `песня ${c === "Ким" ? "Кима" : c}` : c;
    const options = [
      ...(group === "calls" ? [[SIMILAR, "похожим криком"]] : [[BY_WEIGHT, "любой песней (по весам)"]]),
      [NONE, "не отвечать"],
      ...cats.map(c => [c, label(c)]),
    ];
    if (group === "calls") cats.push(NOISE);
    for (const heard of cats) {
      const cur = ruleFor(settings.rules, group, heard);
      const row = document.createElement("div");
      row.className = "rule";
      const heardName = heard === NOISE ? "шум, шорох, щелчок" : group === "songs" && heard === UNLABELED ? "песня (не узнал чья)" : heard === UNLABELED ? "крик без подписи" : label(heard);
      row.innerHTML = `<span>${escapeHtml(heardName)}</span><span>→</span>
        <select>${options.map(([v, t]) => `<option value="${escapeHtml(v)}"${v === cur ? " selected" : ""}>${escapeHtml(t)}</option>`).join("")}</select>`;
      row.querySelector("select").addEventListener("change", e => {
        settings.rules[group][heard] = e.target.value;
        if (run) run.session.s.rules[group][heard] = e.target.value;
        saveSettings();
      });
      box.appendChild(row);
    }
  }
}

function renderMicStatus() {
  const info = (run && run.info) || (calib && calib.info) || engine.micInfo;
  const flag = (v) => v === false ? `<span class="ok">выключено ✓</span>` : v === true ? `<span class="bad">ВКЛЮЧЕНО — Safari не дал выключить</span>` : `<span>не сообщается браузером</span>`;
  const wake = run ? (run.wake && run.wake.error ? `<span class="bad">не включён: ${escapeHtml(run.wake.error)}</span>` : `<span class="ok">включён</span>`)
    : ("wakeLock" in navigator ? "включится при старте" : `<span class="bad">не поддерживается — экран может погаснуть</span>`);
  const sess = engine.audioSessionType;
  const rows = [];
  if (!info) rows.push(["Микрофон", "проверится при калибровке или старте"]);
  else if (info.test) rows.push(["Вход", `тестовый файл: ${escapeHtml(info.name)}`]);
  else {
    rows.push(["Эхоподавление", flag(info.echoCancellation)]);
    rows.push(["Шумоподавление", flag(info.noiseSuppression)]);
    rows.push(["Автоусиление", flag(info.autoGainControl)]);
    rows.push(["Частота", `${info.sampleRate || "—"} Гц`]);
  }
  rows.push(["Аудиосессия iOS", sess ? escapeHtml(sess) : "API нет (не Safari или старая версия)"]);
  rows.push(["Запрет гашения экрана", wake]);
  $("#micStatus").innerHTML = rows.map(([k, v]) => `<div class="k">${k}</div><div>${v}</div>`).join("");
}

function renderCategories() {
  if (!LIB) return;
  for (const [group, el, kind] of [["calls", "#catCalls", "call"], ["songs", "#catSongs", "song"]]) {
    const box = $(el);
    box.innerHTML = "";
    for (const c of LIB.categories[group]) {
      const w = settings.weights[group][c.name] ?? c.weight;
      const row = document.createElement("div");
      row.className = "cat";
      row.innerHTML = `<span class="name">${escapeHtml(c.name)} <small>${c.count}</small></span>
        <input type="range" min="0" max="5" step="0.5" value="${w}"><span class="w">${w}</span><button title="Сыграть вручную">▶</button>`;
      const [inp] = row.getElementsByTagName("input");
      inp.addEventListener("input", () => {
        settings.weights[group][c.name] = +inp.value;
        row.querySelector(".w").textContent = inp.value;
        if (run) run.session.s.weights[group][c.name] = +inp.value;
        saveSettings();
      });
      row.querySelector("button").addEventListener("click", () => manualPlay(kind, c.name));
      box.appendChild(row);
    }
  }
}

function manualPlay(kind, cat) {
  const msg = $("#manualMsg");
  if (!run) { msg.textContent = "Ручной запуск работает только во время сессии."; return; }
  const r = run.session.manual(kind, engine.ctx.currentTime, cat);
  if (!r.ok) { msg.textContent = `Не сыграно: ${r.reason}.`; return; }
  msg.textContent = `Играет: ${r.action.clip.cat} (${r.action.clip.id})`;
  scheduleSound(r.action);
}
$("#singBtn").addEventListener("click", () => manualPlay("song", null));

$("#testSound").addEventListener("click", async () => {
  if (!LIB) return;
  const clip = pickFromCategory(LIB.calls, LIB.categories.calls.find(c => c.weight > 0)?.name || LIB.calls[0].cat, null);
  try {
    await engine.testSound(clip);
  } catch (e) { $("#manualMsg").textContent = `Тестовый звук не сыграл: ${e.message || e}`; }
});

$("#testFile").addEventListener("change", e => {
  testFile = e.target.files[0] || null;
  updateTestBanner();
});
$("#clearTest").addEventListener("click", () => { testFile = null; $("#testFile").value = ""; updateTestBanner(); });
function updateTestBanner() {
  $("#testBanner").hidden = !testFile;
  $("#testBanner").textContent = testFile ? `Тестовый режим: вместо микрофона — файл «${testFile.name}»` : "";
}

$("#resetSettings").addEventListener("click", async () => {
  if (!(await confirmModal("Вернуть все настройки к исходным?", "Сбросить"))) return;
  settings = { ...DEFAULT_SETTINGS, version: SETTINGS_VERSION, weights: { calls: {}, songs: {} }, rules: { calls: {}, songs: {} } };
  saveSettings();
  renderSettings();
});

/* ---------------- калибровка ---------------- */
$("#calibBtn").addEventListener("click", async () => {
  if (run) { $("#calibBtn").textContent = "Идёт сессия — индикатор уже работает"; return; }
  if (calib) { await stopCalibration(); return; }
  try {
    engine.onDetector = onDetector;
    engine.onInterrupt = () => stopCalibration();
    const info = await engine.startInput({ file: testFile, monitorFile: $("#monitorFile").checked, onDb: settings.onDb });
    calib = { info, count: 0 };
    $("#calibBtn").textContent = "Выключить микрофон";
    renderMicStatus();
  } catch (e) {
    await engine.stopInput();
    $("#calibBtn").textContent = e && e.name === "NotAllowedError" ? "Нет доступа к микрофону — разрешите в Safari" : `Ошибка: ${e.message || e}`;
  }
});
async function stopCalibration() {
  if (!calib) return;
  calib = null;
  await engine.stopInput();
  $("#calibBtn").textContent = "Включить микрофон для калибровки";
}
function onCalibMessage(m) {
  if (m.type === "onset") flashDetection();
  if (m.type === "syllable") { calib.count++; $("#detCount").textContent = `Срабатываний: ${calib.count}`; }
}
function flashDetection() {
  const sc = document.body;
  sc.classList.add("bird-heard");
  clearTimeout(flashDetection.h);
  flashDetection.h = setTimeout(() => sc.classList.remove("bird-heard"), 700);
  const f = $("#detFlash");
  f.classList.add("on");
  clearTimeout(flashDetection.t);
  flashDetection.t = setTimeout(() => f.classList.remove("on"), 250);
  if (run) $("#detCount").textContent = `Срабатываний: ${run.detections + 1}`;
}

function drawMeter(m) {
  const cv = $("#meter");
  if (!cv.offsetParent) return;
  const g = cv.getContext("2d"), W = cv.width, H = cv.height;
  const lo = -100, hi = -10, x = db => Math.max(0, Math.min(W, (db - lo) / (hi - lo) * W));
  g.clearRect(0, 0, W, H);
  g.fillStyle = m.muted ? "#c9bfe0" : m.active ? "#ff7eb6" : "#a98bff";
  g.fillRect(0, 18, x(m.db), H - 36);
  g.fillStyle = "#ffffff"; g.fillRect(x(m.floor) - 1, 6, 2, H - 12);
  g.fillStyle = "#ff4f8b"; g.fillRect(x(m.floor + m.onDb) - 2, 0, 4, H);
  g.fillStyle = "#5b3f8f"; g.font = "bold 22px ui-rounded, -apple-system, sans-serif";
  g.fillText(m.muted ? "глушение (играет ответ)" : m.warm ? "учу тишину…" : `${Math.round(m.db)} дБ`, 10, H - 4);
}

/* ---------------- запуск ---------------- */
renderSettingsValues();
renderAltHint();
updateTestBanner();
loadLibrary();
