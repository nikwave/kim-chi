"""Этап 2: локальная страница ручной проверки клипов.

Запуск:  .venv/bin/python prep/review.py      → откройте http://localhost:8765
Решения сохраняются в data/clips/decisions.json сразу при каждом изменении:
  deleted  — удалённые, approved — прослушанные и одобренные, kind — исправленный тип (call/song),
  notes — ваши заметки к клипам (остаются только локально, в library.json не попадают).
Кнопка «Сохранить одобренные» копирует в app/clips/ ТОЛЬКО одобренные клипы и пишет app/library.json.
"""
import json
import shutil
import subprocess
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import yaml

sys.path.insert(0, str(Path(__file__).parent))
import features  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CFG = yaml.safe_load((ROOT / "prep/config.yaml").read_text())
CLIPS = ROOT / CFG["out_dir"]
APP = ROOT / CFG["app_dir"]
PAGE = Path(__file__).parent / "review.html"
DECISIONS = CLIPS / "decisions.json"
FEATURES = ("dur", "f0", "centroid")
CATS = Path(__file__).parent / "categories.yaml"
UNLABELED = "без подписи"
NOISE = "шум"


def category(note, kind_cfg):
    """Заметка → категория по prep/categories.yaml. В приложение уходит только категория."""
    n = (note or "").strip().lower()
    if not n:
        return UNLABELED
    aliases = {k.lower(): v for k, v in kind_cfg.get("aliases", {}).items()}
    return aliases.get(n, n)


def load_decisions():
    if DECISIONS.exists():
        return json.loads(DECISIONS.read_text())
    return {"deleted": [], "approved": [], "kind": {}, "notes": {}}


def normalize(dec):
    deleted = set(dec.get("deleted", []))
    approved = set(dec.get("approved", [])) - deleted
    kind = {k: v for k, v in dec.get("kind", {}).items() if v in ("call", "song") and k in approved}
    notes = {k: str(v).strip()[:500] for k, v in dec.get("notes", {}).items() if str(v).strip()}
    return {"deleted": sorted(deleted), "approved": sorted(approved), "kind": kind, "notes": notes}


def clip_spec(path, pad_s):
    """Форма спектра клипа (как её посчитает приложение для услышанного звука)."""
    sr = 44100
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32).astype(np.float64)
    n = int(pad_s * sr)
    core = x[n:len(x) - n] if len(x) > 4 * n else x
    return features.compute(core, sr)["spec"]


def export(dec):
    dec = normalize(dec)
    idx = json.loads((CLIPS / "index.json").read_text())
    approved = set(dec["approved"])
    # одобренные, включая спасённые из автоматически отброшенных; заметки НЕ публикуются
    keep = [dict(it, kind=dec["kind"].get(it["id"], it["kind"])) for it in idx if it["id"] in approved]
    dst = APP / "clips"
    if dst.exists():
        shutil.rmtree(dst)
    (dst / "calls").mkdir(parents=True)
    (dst / "songs").mkdir(parents=True)
    cats_cfg = yaml.safe_load(CATS.read_text())
    lib = {"version": 2, "calls": [], "songs": [], "stats": {}, "categories": {"calls": [], "songs": []}}
    for it in keep:
        group = "calls" if it["kind"] == "call" else "songs"
        rel = f"{group}/{it['id']}.m4a"
        shutil.copy2(CLIPS / it["file"], dst / rel)
        rec = {"id": it["id"], "file": "clips/" + rel, **{k: it[k] for k in FEATURES},
               "cat": category(dec["notes"].get(it["id"]), cats_cfg[group]),
               "spec": clip_spec(dst / rel, CFG["export"]["pad_ms"] / 1000)}
        lib[group].append(rec)
    for group in ("calls", "songs"):
        cfg = cats_cfg[group]
        counts = {}
        for r in lib[group]:
            counts[r["cat"]] = counts.get(r["cat"], 0) + 1
        lib["categories"][group] = [
            {"name": c, "count": n, "weight": cfg.get("weights", {}).get(c, cfg.get("default_weight", 1))}
            for c, n in sorted(counts.items(), key=lambda kv: (kv[0] == UNLABELED, -kv[1]))]
    # статистика лог-признаков для нормализации в приложении
    for kind in ("calls", "songs"):
        if lib[kind]:
            lib["stats"][kind] = {
                k: {"mean": float(np.mean(np.log([max(r[k], 1e-3) for r in lib[kind]]))),
                    "std": float(np.std(np.log([max(r[k], 1e-3) for r in lib[kind]])) or 1.0)}
                for k in FEATURES}
            S = np.array([r["spec"] for r in lib[kind]])
            lib["stats"][kind]["spec"] = {"mean": [round(float(v), 4) for v in S.mean(0)],
                                          "std": [round(float(v), 4) for v in (S.std(0) + 1e-6)]}
    # Образцы для распознавания без аудио (только числа-признаки):
    #  - неодобренные клипы с подписью — образцы своей категории;
    #  - остальные удалённые и отброшенные крики — образцы «шум», чтобы шорохи и щелчки
    #    не принимались за «заботу».
    lib["refs"] = []
    for it in idx:
        if it["id"] in approved or dec["kind"].get(it["id"], it["kind"]) != "call":
            continue
        note = dec["notes"].get(it["id"])
        cat = category(note, cats_cfg["calls"]) if note else NOISE
        try:
            sp = clip_spec(CLIPS / it["file"], CFG["export"]["pad_ms"] / 1000)
        except Exception:
            continue
        lib["refs"].append({"id": "x" + it["id"], "cat": cat, **{k: it[k] for k in FEATURES}, "spec": sp})
    (APP / "library.json").write_text(json.dumps(lib, ensure_ascii=False, indent=1))
    return len(lib["calls"]), len(lib["songs"])


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(CLIPS), **kw)

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            body = PAGE.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/state":
            self._json({"index": json.loads((CLIPS / "index.json").read_text()),
                        "decisions": normalize(load_decisions())})
        else:
            super().do_GET()

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        data = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/decisions":
            DECISIONS.write_text(json.dumps(normalize(data), ensure_ascii=False))
            self._json({"ok": True})
        elif self.path == "/api/export":
            c, s = export(load_decisions())
            self._json({"ok": True, "calls": c, "songs": s})
        else:
            self._json({"error": "not found"}, 404)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"Страница проверки: http://localhost:{port}   (остановить — Ctrl+C)")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
