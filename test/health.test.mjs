import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http/app.mjs";
import { FIXED_NOW } from "./helpers.mjs";

test("健康检查返回可用状态", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tour-health-"));
  const { server, store } = await createApp({
    storeFile: join(dir, "events.jsonl"),
    now: () => FIXED_NOW,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
