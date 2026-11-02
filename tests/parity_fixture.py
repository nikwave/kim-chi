"""Готовит данные для tests/parity.test.mjs: декодирует клипы библиотеки,
считает признаки Python-версией и пишет сырые сэмплы + эталон в outdir."""
import json, subprocess, sys
from pathlib import Path
import numpy as np
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "prep"))
import features  # noqa: E402

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
lib = json.loads((ROOT / "app/library.json").read_text())
clips = lib["calls"][::25] + lib["songs"][::20]
ref = []
for sr in (44100, 48000):
    for c in clips:
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(ROOT / "app" / c["file"]), "-ac", "1",
                              "-ar", str(sr), "-f", "f32le", "-"], capture_output=True, check=True).stdout
        x = np.frombuffer(raw, np.float32)
        name = f"{c['id']}_{sr}.f32"
        (out / name).write_bytes(x.tobytes())
        ref.append({"file": name, "sr": sr, "lib": c, "py": features.compute(x.astype(np.float64), sr)})
(out / "ref.json").write_text(json.dumps(ref, ensure_ascii=False))
print(len(ref))
