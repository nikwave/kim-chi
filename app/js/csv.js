// CSV журнала сессий и выгрузка через «Поделиться» или скачивание.
const EVENT_RU = {
  syllable: "звук птицы", bird_call: "крик птицы", bird_song_start: "птица начала петь", bird_song_end: "птица закончила петь",
  response: "ответ", response_virtual: "виртуальный ответ", response_manual: "ручной ответ",
  initiative: "звук в тишине", initiative_virtual: "виртуальный звук в тишине",
  cancelled: "ответ отменён", skipped: "ответ пропущен", note: "заметка", mute: "глушение",
  late: "ответ не успел", start: "старт", stop: "стоп",
};

const esc = v => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function sessionRows(s) {
  const t0 = s.audioStart;
  const start = new Date(s.startedAt).getTime();
  return s.log.map(e => {
    const rel = e.t - t0;
    const { type, t, kind, clip, cat, reason, text, heard, ...rest } = e;
    if (heard) rest.услышано = heard;
    return [
      s.id, s.mode === "listen" ? "только слушать" : "отвечать",
      new Date(start + rel * 1000).toISOString(), rel.toFixed(3), type, EVENT_RU[type] || type,
      kind || "", clip || "", cat || "", reason || text || "",
      Object.keys(rest).length ? JSON.stringify(rest) : "",
    ];
  });
}

const HEADER = ["session_id", "режим", "время", "t_с", "событие", "событие_ру", "тип", "клип", "категория", "причина_или_текст", "подробности"];

export function sessionsToCsv(sessions) {
  const lines = [HEADER.join(",")];
  for (const s of sessions) for (const r of sessionRows(s)) lines.push(r.map(esc).join(","));
  return "﻿" + lines.join("\n") + "\n";
}

export function summaryCsv(sessions) {
  const head = ["session_id", "режим", "начало", "длительность_с", "причина_остановки", "крики_птиц", "песни_птиц",
    "ответы", "звуки_в_тишине", "отклик_на_звуки_в_тишине_1с", "ручные", "отменены", "доля_откликов_1с", "доля_откликов_05с", "медиана_задержки_мс", "глушение_с", "заметки"];
  const lines = [head.join(",")];
  for (const s of sessions) {
    const m = s.metrics || {};
    lines.push([s.id, s.mode === "listen" ? "только слушать" : "отвечать", s.startedAt, m.durationS?.toFixed(1),
      s.reason, m.birdCalls, m.birdSongs, m.responses, m.initiatives, m.initiativeReplyShare?.toFixed(3), m.manual, m.cancelled,
      m.replyShare?.toFixed(3), m.replyShare05?.toFixed(3),
      m.medianLatencyS != null ? Math.round(m.medianLatencyS * 1000) : "", m.mutedS?.toFixed(1), m.notes].map(esc).join(","));
  }
  return "﻿" + lines.join("\n") + "\n";
}

// Сначала системное меню «Поделиться» (на iPad — «Сохранить в Файлы», AirDrop, почта),
// иначе — обычное скачивание.
export async function shareOrDownload(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const file = new File([blob], filename, { type: "text/csv" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return "shared"; }
    catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return "downloaded";
}
