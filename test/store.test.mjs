import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/domain/store.mjs";
import { Router } from "../src/domain/router.mjs";
import { seedBaseline, at } from "./helpers.mjs";

test("日志尾部残缺行（崩溃写一半）在重放时被截断，完整记录照常生效", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tour-torn-"));
  const file = join(dir, "events.jsonl");
  try {
    const store1 = new EventStore(file);
    const router1 = await new Router(store1).init();
    await seedBaseline(router1);
    const held = await router1.submit({
      type: "RequestActivity",
      commandId: "cmd-before-crash",
      id: "before-crash",
      venueId: "v-hk",
      start: at("2026-12-10", "10:00"),
      end: at("2026-12-10", "12:00"),
      priority: 100,
      needs: ["core"],
    });
    assert.ok(held.events.length >= 2);
    store1.close();

    // 模拟崩溃：追加一行写坏的 JSON（无换行结尾）
    appendFileSync(file, '{"seq":999,"type":"DamageReported","data":{');

    const store2 = new EventStore(file);
    const router2 = await new Router(store2).init();
    assert.equal(store2.torn, true);
    assert.equal(router2.activityView("before-crash").status, "held");
    // 截断后序号连续，新命令可正常追加
    const ok = await router2.submit({ type: "ReleaseAllocation", activityId: "before-crash", reason: "x" });
    assert.equal(ok.duplicate, false);
    assert.equal(router2.activityView("before-crash").status, "released");
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("高并发争抢唯一展具：N 个同窗请求恰好一个成功，其余被拒", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tour-race-"));
  try {
    const store = new EventStore(join(dir, "events.jsonl"));
    const router = await new Router(store).init();
    await seedBaseline(router);
    // core-b 全天检修，只剩 core-a
    const day = "2026-12-11";
    await router.submit({
      type: "ScheduleMaintenance",
      exhibitId: "core-b",
      start: at(day, "00:00"),
      end: at(day, "23:59"),
    });

    const N = 20;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        router.submit({
          type: "RequestActivity",
          commandId: `cmd-race-${i}`,
          id: `race-${i}`,
          venueId: "v-hk",
          start: at(day, "10:00"),
          end: at(day, "12:00"),
          priority: 100,
          needs: ["core"],
        }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, N - 1);
    assert.ok(rejected.every((r) => r.reason.code === "ALLOCATION_FAILED"));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
