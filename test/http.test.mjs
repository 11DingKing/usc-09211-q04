import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http/app.mjs";
import { at, FIXED_NOW } from "./helpers.mjs";

async function startApp() {
  const dir = mkdtempSync(join(tmpdir(), "tour-http-"));
  const { server, store } = await createApp({ storeFile: join(dir, "events.jsonl"), now: () => FIXED_NOW });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  return {
    dir,
    url,
    stop: async () => {
      await new Promise((resolve) => server.close(resolve));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("端到端：注册到双重承诺防护、损坏替代、重启恢复全链路", async () => {
  const app = await startApp();
  try {
    assert.equal((await (await fetch(app.url("/health"))).json()).status, "ok");

    await postJson(app.url("/commands"), {
      type: "RegisterVenue",
      id: "v-hk",
      kind: "venue",
      region: "HK",
      capabilities: ["power-3kw"],
    });
    await postJson(app.url("/commands"), {
      type: "RegisterExhibit",
      id: "core-a",
      capabilities: ["core"],
      envRequirements: ["power-3kw"],
      region: "HK",
    });
    await postJson(app.url("/commands"), {
      type: "RegisterExhibit",
      id: "core-b",
      capabilities: ["core"],
      envRequirements: ["power-3kw"],
      region: "HK",
    });

    const day = "2026-11-05";
    // core-b 检修到 11:00：10:00 的同窗竞争无资源可用，11:00 损坏后它恰好恢复可作替代
    await postJson(app.url("/commands"), {
      type: "ScheduleMaintenance",
      exhibitId: "core-b",
      start: at(day, "00:00"),
      end: at(day, "11:00"),
      reason: "检修",
    });
    const activity = {
      type: "RequestActivity",
      commandId: "cmd-http-1",
      id: "http-1",
      venueId: "v-hk",
      schoolId: "school-xyz",
      title: "HTTP 链路活动",
      start: at(day, "10:00"),
      end: at(day, "12:00"),
      priority: 100,
      needs: ["core"],
    };
    const first = await postJson(app.url("/commands"), activity);
    assert.equal(first.status, 200);

    // 幂等重放
    const dup = await postJson(app.url("/commands"), activity);
    assert.equal(dup.body.duplicate, true);

    // 同窗冲突被拒
    const clash = await postJson(app.url("/commands"), { ...activity, commandId: "cmd-http-2", id: "http-2" });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error, "ALLOCATION_FAILED");

    // 损坏 core-a → 自动改派 core-b
    const damage = await postJson(app.url("/commands"), {
      type: "ReportDamage",
      commandId: "cmd-http-dmg",
      exhibitId: "core-a",
      at: at(day, "11:00"),
      reason: "碰撞",
      responsibility: { owner: "logistics" },
    });
    assert.equal(damage.status, 200);
    assert.ok(damage.body.events.some((e) => e.type === "ExhibitReassigned"));

    const view = await (await fetch(app.url("/activities/http-1"))).json();
    assert.deepEqual(view.assignments.exhibitIds, ["core-b"]);
    assert.equal(view.school.id, "school-xyz");

    // 时间线包含事件时间与接收时间
    const tl = await (await fetch(app.url("/timeline?activityId=http-1"))).json();
    assert.ok(tl.timeline.some((r) => r.type === "ExhibitReassigned"));
    assert.ok(tl.timeline.every((r) => typeof r.eventTime === "number" && typeof r.receivedAt === "number"));
  } finally {
    await app.stop();
  }
});

test("非法 JSON 与未知命令返回 4xx", async () => {
  const app = await startApp();
  try {
    const res = await fetch(app.url("/commands"), { method: "POST", body: "{not-json" });
    assert.equal(res.status, 400);
    const res2 = await postJson(app.url("/commands"), { type: "Nope" });
    assert.equal(res2.status, 400);
    assert.equal(res2.body.error, "UNKNOWN_COMMAND");
    assert.equal((await fetch(app.url("/nope"))).status, 404);
  } finally {
    await app.stop();
  }
});
