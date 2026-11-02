"""Кластеризация клипов для страницы проверки + картинки-спектрограммы.

Запуск:  .venv/bin/python prep/cluster.py
Добавляет поле "group" в data/clips/index.json и рисует data/clips/png/<id>.png.
Группы упорядочены от наименее гармоничных (чаще шум) к наиболее.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import yaml
from scipy import signal
from sklearn.cluster import AgglomerativeClustering
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parent.parent
SR = 22050


def decode(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR),
                          "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).astype(np.float64)


def mel_fb(n_mels=32, n_fft=512, fmin=400, fmax=9000):
    mel = lambda f: 2595 * np.log10(1 + f / 700)
    imel = lambda m: 700 * (10 ** (m / 2595) - 1)
    pts = imel(np.linspace(mel(fmin), mel(fmax), n_mels + 2))
    freqs = np.arange(n_fft // 2 + 1) * SR / n_fft
    fb = np.zeros((n_mels, len(freqs)))
    for i in range(n_mels):
        l, c, r = pts[i], pts[i + 1], pts[i + 2]
        fb[i] = np.clip(np.minimum((freqs - l) / (c - l), (r - freqs) / (r - c)), 0, None)
    return fb


FB = mel_fb()


def descriptor(y):
    f, t, S = signal.spectrogram(y, SR, nperseg=512, noverlap=384)
    M = np.log(FB @ S + 1e-10)
    e = M.mean(0)
    loud = e > np.percentile(e, 50)
    Ml = M[:, loud] if loud.sum() > 2 else M
    Ml = Ml - Ml.mean()
    return np.concatenate([Ml.mean(1), Ml.std(1)]), (f, S)


def save_png(f, S, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    band = f <= 10000
    img = 10 * np.log10(S[band] + 1e-12)
    img = np.clip((img - (img.max() - 60)) / 60, 0, 1)
    plt.imsave(path, img[::-1], cmap="magma")


def main():
    cfg = yaml.safe_load((ROOT / "prep/config.yaml").read_text())
    out = ROOT / cfg["out_dir"]
    idx = json.loads((out / "index.json").read_text())
    (out / "png").mkdir(exist_ok=True)
    descs = {}
    for it in idx:
        y = decode(out / it["file"])
        d, (f, S) = descriptor(y)
        descs[it["id"]] = d
        save_png(f, S, out / "png" / f"{it['id']}.png")
    for kind, per in (("call", cfg["cluster"]["calls_per_group"]), ("song", cfg["cluster"]["songs_per_group"])):
        items = [it for it in idx if it["kind"] == kind and not it["rejected"]]
        X = np.array([np.concatenate([descs[it["id"]],
                                      [np.log(it["dur"]) * 3, np.log(max(it["f0"], 1)) * 3,
                                       np.log(max(it["centroid"], 1)) * 3, it["harmonicity"] * 3]])
                      for it in items])
        X = StandardScaler().fit_transform(X)
        X = PCA(n_components=min(12, X.shape[1], len(X) - 1), random_state=0).fit_transform(X)
        k = max(2, round(len(items) / per))
        lab = AgglomerativeClustering(n_clusters=k, linkage="ward").fit_predict(X)
        order = sorted(range(k), key=lambda g: np.mean([items[i]["harmonicity"] for i in np.where(lab == g)[0]]))
        rank = {g: r + 1 for r, g in enumerate(order)}
        for it, g in zip(items, lab):
            it["group"] = rank[g]
        sizes = np.bincount(lab)
        print(f"{kind}: {len(items)} клипов, {k} групп, размер {sizes.min()}–{sizes.max()}")
    (out / "index.json").write_text(json.dumps(idx, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
