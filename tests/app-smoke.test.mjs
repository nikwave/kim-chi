// app.js загружается целиком (с заглушками DOM) и не падает при старте.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

test("app.js стартует без ошибок", () => {
  const out = execFileSync(process.execPath, ["tests/app-smoke.mjs", resolve("app/js/app.js")]).toString();
  assert.match(out, /import ok/);
});
