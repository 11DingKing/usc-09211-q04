import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { App } from "../src/app.mjs";
import { seedWorld, seedMoEvent, planMoRoute } from "./helpers.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "expo-route-"));
}

test("重启后继续执行已批准路线：状态、锁与幂等记录完整恢复", () => {
  const dir = tempDir();
  const app1 = App.open(dir);
  seedWorld(app1);
  seedMoEvent(app1);
  planMoRoute(app1);
  const approved = app1.approveRoute("route-1", {}, "approve-r1");

  // 模拟重启：从同一数据目录重新打开
  const app2 = App.open(dir);
  const route = app2.getRoute("route-1");
  assert.equal(route.status, "APPROVED");
  const state = app2.getState();
  assert.ok(state.locks["core-1"], "锁应在重启后保留");
  assert.ok(state.locks["docent-1"], "讲解员锁应在重启后保留");

  // 幂等记录在重启后仍然有效
  const replayed = app2.approveRoute("route-1", {}, "approve-r1");
  assert.equal(replayed.replay, true);
  assert.deepEqual(replayed.locks, approved.locks);

  // 恢复扫描：到达出发时间后提示可执行首航段
  const recovery = app2.recover("2026-10-04T00:30:00.000Z");
  assert.deepEqual(recovery.pendingActions, [{ type: "start_leg", routeId: "route-1", legIndex: 0 }]);

  // 重启后可直接继续执行
  app2.startLeg("route-1", 0, { occurredAt: "2026-10-04T00:30:00.000Z" }, "start-r1");
  app2.completeLeg("route-1", 0, { occurredAt: "2026-10-04T08:00:00.000Z" }, "complete-r1");
  const done = app2.getRoute("route-1");
  assert.equal(done.status, "COMPLETED");
  const finalState = app2.getState();
  assert.equal(finalState.eventRequests["evt-mo-1"].status, "fulfilled");
  assert.equal(finalState.exhibits["core-1"].locationVenueId, "mo-venue");
  assert.equal(finalState.locks["core-1"], undefined, "路线完成后锁应释放");

  // 再次重启仍能看到完整时间线
  const app3 = App.open(dir);
  const types = app3.timeline({ entity: "route-1" }).map((e) => e.type);
  for (const expected of ["RoutePlanned", "RouteApproved", "RouteLegStarted", "RouteLegCompleted", "RouteCompleted"]) {
    assert.ok(types.includes(expected), `时间线缺少 ${expected}`);
  }
});

test("恢复时过期锁转为 LockExpired 事件", () => {
  const dir = tempDir();
  const app1 = App.open(dir);
  seedWorld(app1);
  seedMoEvent(app1);
  planMoRoute(app1);
  app1.approveRoute("route-1", {}, "approve-r1");

  const app2 = App.open(dir);
  // 锁过期时间为活动结束（10-05 07:00Z）+ 24h 余量
  const recovery = app2.recover("2026-10-08T00:00:00.000Z");
  assert.ok(recovery.expiredLocks >= 2);
  const state = app2.getState();
  assert.equal(state.locks["core-1"], undefined);
  const expired = app2.timeline({ entity: "core-1" }).filter((e) => e.type === "LockExpired");
  assert.ok(expired.length >= 1);
});
