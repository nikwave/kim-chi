"""Признаки клипа: длительность, основная частота (YIN), спектральный центроид.

Этот алгоритм повторён один-в-один в app/js/features.js — приложение считает те же
признаки для услышанного крика. Совпадение проверяет tests/test_parity.py.
"""
import numpy as np

HP_HZ = 400.0          # фильтр верхних частот перед анализом
CENTROID_BAND = (500.0, 8000.0)
FFT_SIZE = 1024
F0_MIN, F0_MAX, YIN_THR = 350.0, 1500.0, 0.25
F0_WIN_S = 0.020       # окно YIN 20 мс
F0_HOP_S = 0.010


def biquad_highpass(x, sr, fc=HP_HZ, q=0.7071):
    """RBJ biquad HPF, прямая форма I — так же реализован в JS."""
    w0 = 2 * np.pi * fc / sr
    alpha = np.sin(w0) / (2 * q)
    cw = np.cos(w0)
    b0, b1, b2 = (1 + cw) / 2, -(1 + cw), (1 + cw) / 2
    a0, a1, a2 = 1 + alpha, -2 * cw, 1 - alpha
    b = np.array([b0, b1, b2]) / a0
    a = np.array([1.0, a1 / a0, a2 / a0])
    from scipy.signal import lfilter
    return lfilter(b, a, x).astype(np.float64)


def yin_frames(x, sr):
    """Возвращает (f0 по кадрам, минимум CMNDF по кадрам, rms кадров)."""
    win = int(round(F0_WIN_S * sr))
    hop = int(round(F0_HOP_S * sr))
    tau_min = int(np.floor(sr / F0_MAX))
    tau_max = int(np.ceil(sr / F0_MIN))
    f0s, mins, rmss = [], [], []
    if len(x) < win + tau_max:
        x = np.pad(x, (0, win + tau_max - len(x)))
    for start in range(0, len(x) - win - tau_max + 1, hop):
        seg = x[start:start + win + tau_max]
        frame = seg[:win]
        rmss.append(np.sqrt(np.mean(frame ** 2)))
        d = np.empty(tau_max + 1)
        d[0] = 0.0
        for tau in range(1, tau_max + 1):
            diff = frame - seg[tau:tau + win]
            d[tau] = np.dot(diff, diff)
        cm = np.ones(tau_max + 1)
        cs = np.cumsum(d[1:])
        taus = np.arange(1, tau_max + 1)
        with np.errstate(divide="ignore", invalid="ignore"):
            cm[1:] = np.where(cs > 0, d[1:] * taus / cs, 1.0)
        # первый минимум ниже порога, иначе глобальный минимум в диапазоне
        tau_sel = -1
        for tau in range(tau_min, tau_max):
            if cm[tau] < YIN_THR:
                while tau + 1 < tau_max and cm[tau + 1] < cm[tau]:
                    tau += 1
                tau_sel = tau
                break
        if tau_sel < 0:
            tau_sel = tau_min + int(np.argmin(cm[tau_min:tau_max]))
        # параболическая интерполяция
        t = tau_sel
        if 1 <= t < tau_max:
            a, b_, c = cm[t - 1], cm[t], cm[t + 1]
            den = a - 2 * b_ + c
            shift = 0.5 * (a - c) / den if den != 0 else 0.0
            shift = max(-1.0, min(1.0, shift))
        else:
            shift = 0.0
        f0s.append(sr / (t + shift))
        mins.append(cm[t])
    return np.array(f0s), np.array(mins), np.array(rmss)


def avg_power_spectrum(x, sr):
    win = np.hanning(FFT_SIZE + 1)[:-1]  # периодическое окно Ханна, как в JS
    hop = FFT_SIZE // 2
    if len(x) < FFT_SIZE:
        x = np.pad(x, (0, FFT_SIZE - len(x)))
    acc = np.zeros(FFT_SIZE // 2 + 1)
    n = 0
    for s in range(0, len(x) - FFT_SIZE + 1, hop):
        X = np.fft.rfft(x[s:s + FFT_SIZE] * win)
        acc += np.abs(X) ** 2
        n += 1
    freqs = np.arange(FFT_SIZE // 2 + 1) * sr / FFT_SIZE
    return freqs, acc / max(n, 1)


MEL_BANDS, MEL_LO, MEL_HI = 24, 400.0, 9000.0


def mel_spec(freqs, P):
    """Форма спектра: 24 треугольные мел-полосы 400–9000 Гц, лог, минус среднее.
    Не зависит от громкости и частоты дискретизации. Копия — melSpec в app/js/features.js."""
    mel = lambda f: 2595 * np.log10(1 + f / 700)
    imel = lambda m: 700 * (10 ** (m / 2595) - 1)
    pts = imel(np.linspace(mel(MEL_LO), mel(MEL_HI), MEL_BANDS + 2))
    out = np.empty(MEL_BANDS)
    for i in range(MEL_BANDS):
        l, c, r = pts[i], pts[i + 1], pts[i + 2]
        w = np.clip(np.minimum((freqs - l) / (c - l), (r - freqs) / (r - c)), 0, None)
        out[i] = np.log(np.dot(w, P) + 1e-12)
    return out - out.mean()


def compute(x, sr):
    """x — моно float, только само событие (без запаса). Возвращает dict признаков."""
    x = np.asarray(x, dtype=np.float64)
    y = biquad_highpass(x, sr)
    dur = len(x) / sr
    f0s, mins, rmss = yin_frames(y, sr)
    loud = rmss >= 0.3 * rmss.max() if len(rmss) else np.array([], bool)
    voiced = loud & (mins < YIN_THR)
    if voiced.sum() >= 1:
        f0 = float(np.median(f0s[voiced]))
    elif loud.sum() >= 1:
        f0 = float(np.median(f0s[loud]))
    else:
        f0 = 0.0
    harmonicity = float(1 - np.median(mins[loud])) if loud.sum() else 0.0
    freqs, P = avg_power_spectrum(y, sr)
    band = (freqs >= CENTROID_BAND[0]) & (freqs <= CENTROID_BAND[1])
    pb = P[band]
    centroid = float((freqs[band] * pb).sum() / pb.sum()) if pb.sum() > 0 else 0.0
    flatness = float(np.exp(np.mean(np.log(pb + 1e-20))) / (np.mean(pb) + 1e-20))
    spec = [round(float(v), 3) for v in mel_spec(freqs, P)]
    return {
        "dur": round(dur, 4),
        "f0": round(f0, 1),
        "centroid": round(centroid, 1),
        "harmonicity": round(harmonicity, 3),
        "flatness": round(flatness, 4),
        "spec": spec,
    }
