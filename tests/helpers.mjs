export function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Синтетика: шум + «крики» — гармонические стопки с f0.
export function synth(sr, durS, calls, { noiseDb = -60, seed = 1 } = {}) {
  const rng = mulberry32(seed);
  const x = new Float32Array(Math.round(sr * durS));
  const na = Math.pow(10, noiseDb / 20) * Math.sqrt(3);
  for (let i = 0; i < x.length; i++) x[i] = (rng() * 2 - 1) * na;
  for (const c of calls) {
    const a = Math.pow(10, (c.db ?? -20) / 20);
    const i0 = Math.round(c.t * sr), n = Math.round(c.dur * sr);
    for (let i = 0; i < n && i0 + i < x.length; i++) {
      const env = Math.min(1, i / (0.005 * sr), (n - i) / (0.005 * sr));
      let v = 0;
      for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * (c.f0 ?? 600) * h * i / sr) / h;
      x[i0 + i] += a * env * v / 2;
    }
  }
  return x;
}
export async function loadDetector() {
  globalThis.DetectorCore || (await import("../app/js/detector-worklet.js"));
  return globalThis.DetectorCore;
}
export function runDetector(Core, x, sr, cfg = {}, block = 128, mutes = []) {
  const d = new Core(sr, cfg);
  for (const m of mutes) d.addMute(m.from, m.to);
  const out = [];
  for (let i = 0; i < x.length; i += block) out.push(...d.process(x.subarray(i, i + block), i / sr));
  return out;
}
