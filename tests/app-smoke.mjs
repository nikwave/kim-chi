// Минимальная проверка: модуль app.js импортируется и не падает на верхнем уровне.
const el = () => new Proxy(function(){}, { get: (t,k) => k === "classList" ? { add(){}, remove(){}, toggle(){} } : k === "getContext" ? () => null : k==="dataset"?{}:k==="files"?[]:(typeof k==="string" && /^(on|add|remove|query|get|append|set|focus|blur|click|scroll)/.test(k)) ? () => el() : undefined, set: () => true, apply: () => el() });
globalThis.document = { querySelector: () => el(), querySelectorAll: () => [], addEventListener(){}, createElement: () => el(), body: el(), hidden: false };
globalThis.window = globalThis; globalThis.addEventListener = () => {}; globalThis.localStorage = { getItem: () => null, setItem(){} };
globalThis.fetch = async () => ({ ok: false });
globalThis.indexedDB = { open: () => { const r = {}; setTimeout(() => r.onerror && r.onerror()); return r; } };
try { await import(process.argv[2]); console.log("import ok"); } catch (e) { console.log("ERR", e.stack); process.exitCode = 1; }
