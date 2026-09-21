import assert from "node:assert/strict";
import test from "node:test";
import { makeApp, seedMoEvent, planMoRoute } from "./helpers.mjs";

function approvedAndStarted() {
  const app = makeApp();
  seedMoEvent(app);
  planMoRoute(app);
  app.approveRoute("route-1", {}, "approve-r1");
  app.startLeg("route-1", 0, { occurredAt: "2026-10-04T00:30:00.000Z" }, "start-r1");
  return app;
}

test("途中损坏触发可追溯的替代方案：替换展具并恢复活动", () => {
  const app = approvedAndStarted();
  const report = app.reportIncident({
    routeId: "route-1",
    legIndex: 0,
    exhibitId: "core-1",
    occurredAt: "2026-10-04T02:00:00.000Z",
    responsibility: "carrier",
    description: "运输途中包装受潮",
  }, "inc-1");

  assert.equal(report.affectedSchoolIds.includes("mo-school-1"), true);
  assert.equal(report.actions.length, 1);
  assert.equal(report.actions[0].type, "substitute");
  assert.equal(report.actions[0].withExhibitId, "core-2"); // 位于澳门馆的备份展品

  const state = app.getState();
  assert.equal(state.exhibits["core-1"].status, "damaged");
  assert.equal(state.locks["core-1"], undefined, "损坏展具的锁应被释放");
  assert.equal(state.eventRequests["evt-mo-1"].status, "disrupted");

  const accepted = app.acceptAlternative(report.alternativeId, {}, "accept-1");
  assert.equal(accepted.status, "accepted");
  const after = app.getState();
  assert.equal(after.eventRequests["evt-mo-1"].status, "scheduled", "活动应恢复而非静默改期");
  assert.equal(after.eventRequests["evt-mo-1"].startAt, "2026-10-05T01:00:00.000Z", "活动时间未被静默改动");
  assert.ok(after.locks["core-2"], "替代展具应被锁定");

  // 时间线能看清改派原因、责任边界与受影响学校
  const schoolTimeline = app.timeline({ entity: "school:mo-school-1" });
  const types = schoolTimeline.map((e) => e.type);
  for (const expected of ["IncidentReported", "AlternativeProposed", "EventDisrupted", "EventRestored", "AlternativeAccepted"]) {
    assert.ok(types.includes(expected), `时间线缺少 ${expected}`);
  }
  const incident = schoolTimeline.find((e) => e.type === "IncidentReported");
  assert.equal(incident.responsibility, "carrier");
  const proposed = schoolTimeline.find((e) => e.type === "AlternativeProposed");
  assert.deepEqual(proposed.affectedSchoolIds, ["mo-school-1"]);
  assert.match(proposed.reason, /受潮/);
});

test("无替代展具时必须显式改期，且改期留痕而非静默", () => {
  const app = makeApp();
  // 不注册 core-2 之外的备份，且 core-2 故意不满足条件：把 core-2 移走不可行，改为直接损坏时无候选
  app.getState(); // core-2 在澳门馆可用 —— 为制造无候选场景，先让 core-2 被另一条路线锁死
  seedMoEvent(app);
  planMoRoute(app);
  app.approveRoute("route-1", {}, "approve-r1");
  // core-2 被人工锁定，无法作为替代
  app.acquireLock({
    resourceId: "core-2",
    holderId: "ops-other",
    window: { startAt: "2026-10-04T00:00:00.000Z", endAt: "2026-10-08T00:00:00.000Z" },
    ttlMs: 45 * 24 * 3600 * 1000, // 覆盖场景时间（2026-10 上旬）
  }, "lock-core2");
  app.startLeg("route-1", 0, { occurredAt: "2026-10-04T00:30:00.000Z" }, "start-r1");

  const report = app.reportIncident({
    routeId: "route-1",
    legIndex: 0,
    exhibitId: "core-1",
    occurredAt: "2026-10-04T02:00:00.000Z",
    responsibility: "carrier",
    description: "运输车辆事故",
  }, "inc-2");
  assert.equal(report.actions[0].type, "reschedule_required");

  // 不提供新窗口 → 拒绝
  assert.throws(
    () => app.acceptAlternative(report.alternativeId, {}, "accept-no-window"),
    (err) => err.code === "VALIDATION",
  );
  // 新窗口落在澳门节假日 → 拒绝
  assert.throws(
    () => app.acceptAlternative(report.alternativeId, {
      rescheduledWindows: { "evt-mo-1": { startAt: "2026-12-20T01:00:00.000Z", endAt: "2026-12-20T07:00:00.000Z" } },
    }, "accept-holiday"),
    (err) => err.code === "VENUE_HOLIDAY",
  );
  // 显式改期成功，时间线可追溯
  app.acceptAlternative(report.alternativeId, {
    rescheduledWindows: { "evt-mo-1": { startAt: "2026-10-06T01:00:00.000Z", endAt: "2026-10-06T07:00:00.000Z" } },
  }, "accept-ok");
  const er = app.getState().eventRequests["evt-mo-1"];
  assert.equal(er.startAt, "2026-10-06T01:00:00.000Z");
  assert.equal(er.status, "scheduled");
  const rescheduled = app.timeline({ entity: "evt-mo-1" }).find((e) => e.type === "EventRescheduled");
  assert.match(rescheduled.reason, /事故/);
  assert.equal(rescheduled.responsibility, "carrier");
});

test("替代方案不可重复接受", () => {
  const app = approvedAndStarted();
  const report = app.reportIncident({
    routeId: "route-1", legIndex: 0, exhibitId: "core-1",
    occurredAt: "2026-10-04T02:00:00.000Z", responsibility: "carrier", description: "受潮",
  }, "inc-3");
  app.acceptAlternative(report.alternativeId, {}, "accept-3");
  assert.throws(
    () => app.acceptAlternative(report.alternativeId, {}, "accept-3-again"),
    (err) => err.code === "CONFLICT",
  );
});

test("未承运该展具的航段不可上报事故", () => {
  const app = approvedAndStarted();
  assert.throws(
    () => app.reportIncident({
      routeId: "route-1", legIndex: 0, exhibitId: "core-2",
      occurredAt: "2026-10-04T02:00:00.000Z", responsibility: "carrier",
    }, "inc-4"),
    (err) => err.code === "VALIDATION",
  );
});
