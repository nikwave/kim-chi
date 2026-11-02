// Аудиодвижок: AudioContext, микрофон или тестовый файл → детектор (AudioWorklet),
// воспроизведение клипов через общий регулятор громкости, мгновенный стоп с fade.

const FADE_S = 0.03;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.compressed = new Map();   // id → ArrayBuffer (скачано)
    this.decoded = new Map();      // id → AudioBuffer (для текущего ctx)
    this.sources = new Set();
    this.volume = 1;               // всегда полная громкость файла; громкость — кнопками iPad
    this.onDetector = null;        // обработчик сообщений детектора
    this.onInterrupt = null;       // (причина) => void
    this.micInfo = null;
  }

  async ensureContext(sessionType = "playback") {
    // Аудиосессия iOS (Safari 16.4+): play-and-record при работе с микрофоном.
    try { if (navigator.audioSession) navigator.audioSession.type = sessionType; } catch { /* нет API */ }
    if (!this.ctx || this.ctx.state === "closed") {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: "interactive" });
      this.decoded = new Map();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.workletReady = null;
      this.ctx.onstatechange = () => {
        if (this.running && this.ctx.state !== "running") this.onInterrupt?.(`аудио прервано системой (${this.ctx.state})`);
      };
    }
    if (this.ctx.state !== "running") await this.ctx.resume();
    return this.ctx;
  }

  get audioSessionType() { try { return navigator.audioSession ? navigator.audioSession.type : null; } catch { return null; } }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /* ---------- клипы ---------- */
  async prefetch(clips, onProgress) {
    let done = 0;
    const queue = clips.filter(c => !this.compressed.has(c.id));
    const worker = async () => {
      while (queue.length) {
        const c = queue.shift();
        try {
          const r = await fetch(c.file);
          if (!r.ok) throw new Error(r.status);
          this.compressed.set(c.id, await r.arrayBuffer());
        } catch (e) { console.warn("не скачан", c.id, e); }
        onProgress?.(++done, clips.length);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  async buffer(clip) {
    if (this.decoded.has(clip.id)) return this.decoded.get(clip.id);
    let ab = this.compressed.get(clip.id);
    if (!ab) {
      const r = await fetch(clip.file);
      ab = await r.arrayBuffer();
      this.compressed.set(clip.id, ab);
    }
    const buf = await this.ctx.decodeAudioData(ab.slice(0));
    if (this.decoded.size > 80) this.decoded.delete(this.decoded.keys().next().value);
    this.decoded.set(clip.id, buf);
    return buf;
  }

  // Запустить клип в момент `at` (часы ctx). Возвращает {source, startAt, duration}.
  play(buf, at) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.master);
    const lat = (this.ctx.outputLatency || 0);
    const startAt = Math.max(this.ctx.currentTime + 0.005, at - lat);
    src.start(startAt);
    this.sources.add(src);
    src.onended = () => { this.sources.delete(src); try { src.disconnect(); } catch { /* уже */ } };
    return { source: src, startAt, duration: buf.duration };
  }

  cancel(src) {
    try { src.stop(); } catch { /* не запущен */ }
    this.sources.delete(src);
  }

  // Мгновенно оборвать весь звук: короткий fade без щелчка.
  stopAllSound() {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime, g = this.master.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + FADE_S);
    for (const s of this.sources) { try { s.stop(now + FADE_S + 0.01); } catch { /* */ } }
    this.sources.clear();
    g.setValueAtTime(this.volume, now + FADE_S + 0.05);
  }

  async testSound(clip) {
    await this.ensureContext(this.running ? "play-and-record" : "playback");
    const buf = await this.buffer(clip);
    return this.play(buf, this.ctx.currentTime + 0.05);
  }

  /* ---------- вход ---------- */
  async startInput({ file = null, monitorFile = false, onDb = 12 } = {}) {
    await this.ensureContext(file ? "playback" : "play-and-record");
    if (!this.workletReady) this.workletReady = this.ctx.audioWorklet.addModule("js/detector-worklet.js?v=8");
    await this.workletReady;

    this.node = new AudioWorkletNode(this.ctx, "bird-detector", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers",
      processorOptions: { onDb },
    });
    this.node.port.onmessage = e => this.onDetector?.(e.data);
    this.silent = this.ctx.createGain();
    this.silent.gain.value = 0;
    this.node.connect(this.silent).connect(this.ctx.destination);

    if (file) {
      const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
      this.fileSrc = this.ctx.createBufferSource();
      this.fileSrc.buffer = buf;
      this.fileSrc.connect(this.node);
      if (monitorFile) this.fileSrc.connect(this.master);
      this.fileSrc.onended = () => { if (this.running) this.onInterrupt?.("тестовый файл закончился"); };
      this.fileSrc.start();
      this.micInfo = { test: true, name: file.name, duration: buf.duration };
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      const track = this.stream.getAudioTracks()[0];
      const st = track.getSettings ? track.getSettings() : {};
      this.micInfo = {
        test: false, label: track.label,
        echoCancellation: st.echoCancellation, noiseSuppression: st.noiseSuppression,
        autoGainControl: st.autoGainControl, sampleRate: st.sampleRate || this.ctx.sampleRate,
      };
      track.onended = () => { if (this.running) this.onInterrupt?.("микрофон отключился"); };
      track.onmute = () => { if (this.running) this.onInterrupt?.("система отключила микрофон (звонок, Siri или другое приложение)"); };
      this.micSrc = this.ctx.createMediaStreamSource(this.stream);
      this.micSrc.connect(this.node);
    }
    this.running = true;
    return this.micInfo;
  }

  detector(msg) { this.node?.port.postMessage(msg); }

  async stopInput({ close = true } = {}) {
    this.running = false;
    try { this.fileSrc?.stop(); } catch { /* */ }
    this.fileSrc = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    try { this.micSrc?.disconnect(); this.node?.disconnect(); } catch { /* */ }
    this.micSrc = this.node = null;
    if (close && this.ctx) {
      const ctx = this.ctx;
      setTimeout(() => { if (!this.running && ctx.state !== "closed") ctx.close().catch(() => {}); }, 150);
      this.ctx = null;
      try { if (navigator.audioSession) navigator.audioSession.type = "auto"; } catch { /* */ }
    }
  }
}
