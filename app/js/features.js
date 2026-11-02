// Признаки звука: длительность, основная частота (YIN), спектральный центроид.
// Точная копия prep/features.py — библиотека клипов посчитана тем же алгоритмом.
// Совпадение проверяет tests/parity.test.mjs.

export const HP_HZ = 400;
export const CENTROID_BAND = [500, 8000];
export const FFT_SIZE = 1024;
export const F0_MIN = 350, F0_MAX = 1500, YIN_THR = 0.25;
const F0_WIN_S = 0.020, F0_HOP_S = 0.010;

export function biquadHighpass(x, sr, fc = HP_HZ, q = Math.SQRT1_2) {
  const w0 = 2 * Math.PI * fc / sr;
  const alpha = Math.sin(w0) / (2 * q), cw = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 + cw) / 2 / a0, b1 = -(1 + cw) / a0, b2 = (1 + cw) / 2 / a0;
  const a1 = -2 * cw / a0, a2 = (1 - alpha) / a0;
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function yinFrames(xIn, sr) {
  const win = Math.round(F0_WIN_S * sr);
  const hop = Math.round(F0_HOP_S * sr);
  const tauMin = Math.floor(sr / F0_MAX);
  const tauMax = Math.ceil(sr / F0_MIN);
  let x = xIn;
  if (x.length < win + tauMax) {
    x = new Float64Array(win + tauMax);
    x.set(xIn);
  }
  const f0s = [], mins = [], rmss = [];
  const d = new Float64Array(tauMax + 1);
  const cm = new Float64Array(tauMax + 1);
  for (let start = 0; start <= x.length - win - tauMax; start += hop) {
    let e = 0;
    for (let i = 0; i < win; i++) e += x[start + i] * x[start + i];
    rmss.push(Math.sqrt(e / win));
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let i = 0; i < win; i++) {
        const df = x[start + i] - x[start + i + tau];
        s += df * df;
      }
      d[tau] = s;
    }
    cm[0] = 1;
    let cs = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      cs += d[tau];
      cm[tau] = cs > 0 ? d[tau] * tau / cs : 1;
    }
    let sel = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (cm[tau] < YIN_THR) {
        while (tau + 1 < tauMax && cm[tau + 1] < cm[tau]) tau++;
        sel = tau;
        break;
      }
    }
    if (sel < 0) {
      sel = tauMin;
      for (let tau = tauMin; tau < tauMax; tau++) if (cm[tau] < cm[sel]) sel = tau;
    }
    let shift = 0;
    if (sel >= 1 && sel < tauMax) {
      const a = cm[sel - 1], b = cm[sel], c = cm[sel + 1];
      const den = a - 2 * b + c;
      shift = den !== 0 ? 0.5 * (a - c) / den : 0;
      shift = Math.max(-1, Math.min(1, shift));
    }
    f0s.push(sr / (sel + shift));
    mins.push(cm[sel]);
  }
  return { f0s, mins, rmss };
}

// Комплексное БПФ на месте, размер — степень двойки.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

export function avgPowerSpectrum(xIn, sr) {
  const N = FFT_SIZE, hop = N / 2;
  let x = xIn;
  if (x.length < N) { x = new Float64Array(N); x.set(xIn); }
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const acc = new Float64Array(N / 2 + 1);
  const re = new Float64Array(N), im = new Float64Array(N);
  let n = 0;
  for (let s = 0; s <= x.length - N; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    n++;
  }
  const freqs = new Float64Array(N / 2 + 1);
  for (let k = 0; k <= N / 2; k++) { freqs[k] = k * sr / N; acc[k] /= Math.max(n, 1); }
  return { freqs, power: acc };
}

export const MEL_BANDS = 24, MEL_LO = 400, MEL_HI = 9000;
const mel = f => 2595 * Math.log10(1 + f / 700);
const imel = m => 700 * (Math.pow(10, m / 2595) - 1);

// Форма спектра: 24 мел-полосы 400–9000 Гц, лог, минус среднее. Копия mel_spec из Python.
export function melSpec(freqs, P) {
  const pts = [];
  for (let i = 0; i < MEL_BANDS + 2; i++) pts.push(imel(mel(MEL_LO) + (mel(MEL_HI) - mel(MEL_LO)) * i / (MEL_BANDS + 1)));
  const out = new Array(MEL_BANDS);
  for (let i = 0; i < MEL_BANDS; i++) {
    const l = pts[i], c = pts[i + 1], r = pts[i + 2];
    let s = 0;
    for (let k = 0; k < freqs.length; k++) {
      const w = Math.max(0, Math.min((freqs[k] - l) / (c - l), (r - freqs[k]) / (r - c)));
      if (w > 0) s += w * P[k];
    }
    out[i] = Math.log(s + 1e-12);
  }
  const mean = out.reduce((a, b) => a + b, 0) / MEL_BANDS;
  return out.map(v => v - mean);
}

// x — моно-сэмплы самого события (Float32Array/Float64Array), sr — частота.
export function computeFeatures(x, sr) {
  const y = biquadHighpass(x, sr);
  const dur = x.length / sr;
  const { f0s, mins, rmss } = yinFrames(y, sr);
  const maxR = rmss.length ? Math.max(...rmss) : 0;
  const loud = rmss.map(r => r >= 0.3 * maxR);
  const voicedF0 = f0s.filter((_, i) => loud[i] && mins[i] < YIN_THR);
  const loudF0 = f0s.filter((_, i) => loud[i]);
  const f0 = voicedF0.length ? median(voicedF0) : loudF0.length ? median(loudF0) : 0;
  const loudMins = mins.filter((_, i) => loud[i]);
  const harmonicity = loudMins.length ? 1 - median(loudMins) : 0;
  const { freqs, power } = avgPowerSpectrum(y, sr);
  let num = 0, den = 0;
  for (let k = 0; k < freqs.length; k++) {
    if (freqs[k] >= CENTROID_BAND[0] && freqs[k] <= CENTROID_BAND[1]) { num += freqs[k] * power[k]; den += power[k]; }
  }
  const centroid = den > 0 ? num / den : 0;
  return { dur, f0, centroid, harmonicity, spec: melSpec(freqs, power) };
}
