"""Этап 1: нарезка записи на крики и песни.

Запуск:  .venv/bin/python prep/slice.py [prep/config.yaml]
Результат: data/clips/{calls,songs,rejected}/*.m4a, data/clips/index.json,
           data/clips/durations.png (распределение длительностей).
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import yaml
from scipy import ndimage, signal

sys.path.insert(0, str(Path(__file__).parent))
import features  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def load(path, sr):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
        capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).astype(np.float64)


def detect_syllables(x, cfg):
    a, d = cfg["analysis"], cfg["detect"]
    sr, hop = a["sr"], a["hop"]
    f, _, S = signal.stft(x, sr, nperseg=a["frame"], noverlap=a["frame"] - hop, boundary=None, padded=False)
    P = np.abs(S) ** 2
    band = (f >= a["band_hz"][0]) & (f <= a["band_hz"][1])
    eb = 10 * np.log10(P[band].sum(0) + 1e-12)
    fr = sr / hop
    floor = ndimage.percentile_filter(eb, d["floor_percentile"], size=int(fr * d["floor_window_s"]))
    on = eb > floor + d["on_db"]
    low = eb > floor + d["off_db"]
    gap = int(round(d["merge_gap_ms"] / 1000 * fr))
    low = ndimage.binary_closing(low, structure=np.ones(gap * 2 + 1)) | low
    lab, _ = ndimage.label(low)
    keep = np.unique(lab[on])
    act = np.isin(lab, keep[keep > 0])
    lab, _ = ndimage.label(act)
    out = []
    for s in ndimage.find_objects(lab):
        i0, i1 = s[0].start, s[0].stop
        t0 = i0 * hop / sr
        t1 = (i1 * hop + a["frame"]) / sr
        snr = float((eb[i0:i1] - floor[i0:i1]).max())
        out.append({"t0": t0, "t1": t1, "snr": snr})
    return out, (eb, floor, fr)


def group_bouts(syl, gap_s):
    bouts, cur = [], [syl[0]]
    for s in syl[1:]:
        if s["t0"] - cur[-1]["t1"] < gap_s:
            cur.append(s)
        else:
            bouts.append(cur)
            cur = [s]
    bouts.append(cur)
    return bouts


def split_long(bout, max_s):
    parts, cur = [], [bout[0]]
    for s in bout[1:]:
        if s["t1"] - cur[0]["t0"] > max_s:
            parts.append(cur)
            cur = [s]
        else:
            cur.append(s)
    parts.append(cur)
    return parts


def render_clip(x44, t0, t1, cfg):
    e = cfg["export"]
    sr = e["sr"]
    pad = e["pad_ms"] / 1000
    a = max(0, int((t0 - pad) * sr))
    b = min(len(x44), int((t1 + pad) * sr))
    y = x44[a:b].copy()
    sos = signal.butter(4, e["highpass_hz"], "highpass", fs=sr, output="sos")
    y = signal.sosfiltfilt(sos, y)
    core = y[int(pad * sr): len(y) - int(pad * sr)] if len(y) > 2 * pad * sr else y
    rms = np.sqrt(np.mean(core ** 2)) + 1e-12
    g = 10 ** (e["target_rms_dbfs"] / 20) / rms
    peak_lim = 10 ** (e["peak_ceiling_dbfs"] / 20)
    g = min(g, peak_lim / (np.abs(y).max() + 1e-12))
    y *= g
    n = int(e["fade_ms"] / 1000 * sr)
    ramp = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, n))
    y[:n] *= ramp
    y[-n:] *= ramp[::-1]
    return y, core * g


def encode(y, sr, path, cfg):
    e = cfg["export"]
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "f64le", "-ar", str(sr), "-ac", "1", "-i", "-",
         "-c:a", e["codec"], "-b:a", e["bitrate"], "-movflags", "+faststart", str(path)],
        input=y.astype(np.float64).tobytes(), check=True)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    cfg_path = Path(args[0]) if args else ROOT / "prep/config.yaml"
    cfg = yaml.safe_load(cfg_path.read_text())
    src = ROOT / cfg["source"]
    out = ROOT / cfg["out_dir"]
    if (out / "decisions.json").exists() and "--force" not in sys.argv:
        sys.exit(f"В {out} уже есть ваши решения проверки (decisions.json). Повторная нарезка их обесценит.\n"
                 "Если точно нужно — сохраните копию и запустите с --force.")
    if out.exists():
        shutil.rmtree(out)
    for sub in ("calls", "songs", "rejected"):
        (out / sub).mkdir(parents=True)

    print("Чтение", src)
    x = load(src, cfg["analysis"]["sr"])
    x44 = load(src, cfg["export"]["sr"])
    syl, _ = detect_syllables(x, cfg)
    syl = [s for s in syl if (s["t1"] - s["t0"]) * 1000 >= cfg["detect"]["min_dur_ms"]]
    print("Слогов:", len(syl))

    c, nz = cfg["classify"], cfg["noise"]
    bouts = group_bouts(syl, c["bout_gap_ms"] / 1000)
    items = []  # (kind, t0, t1, n_syl)
    for b in bouts:
        dur = b[-1]["t1"] - b[0]["t0"]
        longest = max(s["t1"] - s["t0"] for s in b)
        if dur >= c["song_min_s"] and (len(b) >= c["song_min_syllables"] or longest >= c["motif_min_s"]):
            for p in split_long(b, c["song_max_s"]):
                items.append(("song", p[0]["t0"], p[-1]["t1"], len(p), max(s["snr"] for s in p)))
        else:
            for s in b:
                items.append(("call", s["t0"], s["t1"], 1, s["snr"]))

    esr = cfg["export"]["sr"]
    index = []
    counts = {"call": 0, "song": 0, "rejected": 0}
    for kind, t0, t1, nsyl, snr in items:
        y, core = render_clip(x44, t0, t1, cfg)
        ft = features.compute(core, esr)
        reason = None
        if snr < nz["min_snr_db"]:
            reason = "тихий"
        elif kind == "call" and (t1 - t0) > c["call_max_s"]:
            reason = "длинный неясный звук"
        elif (ft["flatness"] > nz["max_flatness"] and ft["harmonicity"] < nz["min_harmonicity"]) \
                or ft["harmonicity"] < nz["hard_min_harmonicity"]:
            reason = "шум/щелчок"
        sub = "rejected" if reason else ("calls" if kind == "call" else "songs")
        key = "rejected" if reason else kind
        counts[key] += 1
        cid = f"{'c' if kind == 'call' else 's'}{counts[key]:04d}" if not reason else f"r{counts[key]:04d}"
        path = out / sub / f"{cid}.m4a"
        encode(y, esr, path, cfg)
        index.append({"id": cid, "kind": kind, "file": f"{sub}/{cid}.m4a", "t0": round(t0, 3),
                      "t1": round(t1, 3), "syllables": nsyl, "snr": round(snr, 1),
                      "rejected": reason, **ft})
    (out / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1))
    print("Криков:", counts["call"], "Песен:", counts["song"], "Отброшено:", counts["rejected"])
    plot_durations(syl, bouts, index, cfg, out / "durations.png")


def plot_durations(syl, bouts, index, cfg, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    c = cfg["classify"]
    fig, ax = plt.subplots(1, 3, figsize=(16, 4))
    sd = np.array([(s["t1"] - s["t0"]) * 1000 for s in syl])
    gaps = np.array([(syl[i + 1]["t0"] - syl[i]["t1"]) * 1000 for i in range(len(syl) - 1)])
    bd = np.array([b[-1]["t1"] - b[0]["t0"] for b in bouts])
    bins = np.logspace(1, 4, 50)
    ax[0].hist(sd, bins=bins, color="#4a7")
    ax[0].axvline(c["call_max_s"] * 1000, color="r", ls="--", label=f"крик ≤ {c['call_max_s']} с")
    ax[0].set_xscale("log"); ax[0].set_title("Длительность слогов, мс"); ax[0].legend()
    ax[1].hist(gaps[gaps > 0], bins=np.logspace(0.8, 4.3, 50), color="#47a")
    ax[1].axvline(c["bout_gap_ms"], color="r", ls="--", label=f"пауза серии {c['bout_gap_ms']} мс")
    ax[1].set_xscale("log"); ax[1].set_title("Паузы между слогами, мс"); ax[1].legend()
    ax[2].hist(bd, bins=np.logspace(-1.5, 1.3, 50), color="#a74")
    ax[2].axvline(c["song_min_s"], color="r", ls="--", label=f"песня ≥ {c['song_min_s']} с")
    ax[2].set_xscale("log"); ax[2].set_title("Длительность серий, с"); ax[2].legend()
    plt.tight_layout()
    plt.savefig(path, dpi=80)


if __name__ == "__main__":
    main()
