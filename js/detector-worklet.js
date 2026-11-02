// Детектор птичьих звуков. Работает внутри AudioWorklet.
// DetectorCore — чистая логика без Web Audio (её же гоняют тесты в Node).
//
// Как работает:
//  1. Вход фильтруется в полосу птичьих звуков (ФВЧ 500 Гц + ФНЧ 8000 Гц).
//  2. Каждые 10 мс считается энергия в дБ.
//  3. Шумовой пол отслеживается адаптивно: быстро опускается, медленно поднимается,
//     не обновляется во время звука и во время глушения.
//  4. Звук начинается, когда энергия выше пола на onDb, и заканчивается,
//     когда она держится ниже пол+offDb дольше hangMs (гистерезис).
//  5. Пока идёт глушение (играет ответ + 150 мс), вход игнорируется целиком.

class Biquad {
  constructor(type, fc, sr, q = Math.SQRT1_2) {
    const w0 = 2 * Math.PI * fc / sr, alpha = Math.sin(w0) / (2 * q), cw = Math.cos(w0), a0 = 1 + alpha;
    if (type === "hp") { this.b0 = (1 + cw) / 2 / a0; this.b1 = -(1 + cw) / a0; this.b2 = this.b0; }
    else { this.b0 = (1 - cw) / 2 / a0; this.b1 = (1 - cw) / a0; this.b2 = this.b0; }
    this.a1 = -2 * cw / a0; this.a2 = (1 - alpha) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  step(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const DEFAULTS = {
  onDb: 12,          // порог начала звука над шумовым полом
  offDb: 6,          // порог продолжения звука
  hangMs: 30,        // паузы короче — внутри одного слога
  minDurMs: 30,      // короче — игнорируем
  maxDurS: 5,        // слог длиннее — это не птица, а долгий шум: отбрасываем и переучиваем пол
  warmupS: 1.0,      // первые секунды только учим шумовой пол
  floorDownS: 0.5,   // постоянная времени опускания пола
  floorUpS: 8,       // постоянная времени подъёма пола
  minFloorDb: -100,
  bandLo: 500, bandHi: 8000,
  frameMs: 10,
  captureMaxS: 3,    // сколько сэмплов события храним для признаков
};

class DetectorCore {
  constructor(sampleRate, cfg = {}) {
    this.sr = sampleRate;
    this.cfg = { ...DEFAULTS, ...cfg };
    this.frameLen = Math.round(this.sr * this.cfg.frameMs / 1000);
    this.hp = new Biquad("hp", this.cfg.bandLo, this.sr);
    this.lp = new Biquad("lp", this.cfg.bandHi, this.sr);
    this.acc = 0; this.n = 0; this.frameStart = null;
    this.floor = null;
    this.started = null;
    this.active = null;          // текущий звук
    this.mutes = [];             // [{from, to}] в секундах аудио-часов
    this.capture = new Float32Array(Math.round(this.sr * this.cfg.captureMaxS));
    this.capLen = 0;
    this.curFrame = new Float32Array(this.frameLen);
    this.lastLevel = { db: -120, floor: -120 };
    this.mutedFrames = 0;
  }
  setConfig(c) { Object.assign(this.cfg, c); }
  addMute(from, to) {
    this.mutes.push({ from, to });
    if (this.mutes.length > 64) this.mutes.shift();
  }
  removeMute(from, to) { this.mutes = this.mutes.filter(m => !(m.from === from && m.to === to)); }
  clearMutes() { this.mutes = []; }
  isMuted(t0, t1) { return this.mutes.some(m => t1 > m.from && t0 < m.to); }

  // samples — блок входа, t — время первого сэмпла (с). Возвращает массив сообщений.
  process(samples, t) {
    const out = [];
    for (let i = 0; i < samples.length; i++) {
      if (this.n === 0) this.frameStart = t + i / this.sr;
      const x = samples[i];
      this.curFrame[this.n] = x;
      const y = this.lp.step(this.hp.step(x));
      this.acc += y * y;
      this.n++;
      if (this.active && this.capLen < this.capture.length) this.capture[this.capLen++] = x;
      if (this.n === this.frameLen) {
        const db = 10 * Math.log10(this.acc / this.n + 1e-12);
        this.frame(db, this.frameStart, this.frameStart + this.n / this.sr, out);
        this.acc = 0; this.n = 0;
      }
    }
    return out;
  }

  frame(db, t0, t1, out) {
    const c = this.cfg;
    if (this.started === null) this.started = t0;
    const dt = t1 - t0;
    if (this.isMuted(t0, t1)) {
      this.mutedFrames++;
      if (this.active) { out.push({ type: "aborted", t0: this.active.t0, t: t0, reason: "mute" }); this.active = null; }
      this.lastLevel = { db, floor: this.floor ?? db, muted: true };
      return;
    }
    if (this.floor === null) this.floor = db;
    const warm = t0 - this.started < c.warmupS;
    if (!this.active) {
      const tau = db < this.floor ? c.floorDownS : c.floorUpS;
      this.floor += (db - this.floor) * (1 - Math.exp(-dt / tau));
      this.floor = Math.max(this.floor, c.minFloorDb);
    }
    this.lastLevel = { db, floor: this.floor, muted: false, warm };
    if (warm) return;

    if (!this.active) {
      if (db > this.floor + c.onDb) {
        this.active = { t0, lastAbove: t1, peak: db, floorAt: this.floor };
        // в захват попадает и текущий кадр
        this.capture.set(this.curFrame);
        this.capLen = this.frameLen;
        out.push({ type: "onset", t: t0 });
      }
      return;
    }
    const a = this.active;
    if (db > a.floorAt + c.offDb) { a.lastAbove = t1; a.peak = Math.max(a.peak, db); }
    const ended = t1 - a.lastAbove > c.hangMs / 1000;
    if (!ended && t1 - a.t0 > c.maxDurS) {
      out.push({ type: "aborted", t0: a.t0, t: t1, reason: "долгий шум" });
      this.floor = db;
      this.active = null;
      return;
    }
    if (ended) {
      const end = a.lastAbove;
      const dur = end - a.t0;
      if (dur * 1000 >= c.minDurMs) {
        const n = Math.min(this.capLen, Math.round(dur * this.sr));
        out.push({ type: "syllable", t0: a.t0, t1: end, peakDb: a.peak, snr: a.peak - a.floorAt,
                   samples: this.capture.slice(0, n) });
      } else {
        out.push({ type: "aborted", t0: a.t0, t: end, reason: "short" });
      }
      this.active = null;
    }
  }
}

globalThis.DetectorCore = DetectorCore;

if (typeof AudioWorkletProcessor !== "undefined") {
  class BirdDetector extends AudioWorkletProcessor {
    constructor(opts) {
      super();
      this.core = new DetectorCore(sampleRate, (opts && opts.processorOptions) || {});
      this.lastLevelPost = 0;
      this.port.onmessage = e => {
        const m = e.data;
        if (m.type === "config") this.core.setConfig(m.cfg);
        else if (m.type === "mute") this.core.addMute(m.from, m.to);
        else if (m.type === "unmute") this.core.removeMute(m.from, m.to);
        else if (m.type === "clearMutes") this.core.clearMutes();
      };
    }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) {
        const msgs = this.core.process(ch, currentTime);
        for (const m of msgs) {
          if (m.samples) this.port.postMessage(m, [m.samples.buffer]);
          else this.port.postMessage(m);
        }
        if (currentTime - this.lastLevelPost > 0.05) {
          this.lastLevelPost = currentTime;
          this.port.postMessage({ type: "level", t: currentTime, ...this.core.lastLevel,
                                  active: !!this.core.active, onDb: this.core.cfg.onDb });
        }
      }
      return true;
    }
  }
  registerProcessor("bird-detector", BirdDetector);
}
