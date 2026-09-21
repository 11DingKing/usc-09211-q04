import assert from "node:assert/strict";
import test from "node:test";
import { makeApp, seedMoEvent, planMoRoute } from "./helpers.mjs";

test("同一套核心展品不能被同时承诺给两地：第二条路线批准被拒", () => {
  const app = makeApp();
  seedMoEvent(app);
  planMoRoute(app);
  app.approveRoute("route-1", {}, "approve-r1");

  // 另一条路线要把同一核心展品同期留在香港本地展出
  app.requestEvent({
    eventId: "evt-hk-1",
    schoolId: "hk-school-1",
    venueId: "hk-venue",
    startAt: "2026-10-05T02:00:00.000Z",
    endAt: "2026-10-05T06:00:00.000Z",
    requiredExhibitIds: ["core-1"],
    requiredQualifications: [],
    priority: 1,
  }, "req-evt-hk-1");
  const planned = app.planRoute({
    routeId: "route-2",
    priority: 1,
    legs: [{
      fromVenueId: "hk-venue",
      toVenueId: "hk-venue",
      departAt: "2026-10-04T12:00:00.000Z",
      arriveAt: "2026-10-04T14:00:00.000Z",
      exhibitIds: ["core-1"],
      docentIds: [],
      eventId: "evt-hk-1",
    }],
  }, "plan-route-2");
  assert.equal(planned.warnings.lockConflicts.length, 1);
  assert.throws(
    () => app.approveRoute("route-2", {}, "approve-r2"),
    (err) => err.code === "CONFLICT" && err.details.resourceId === "core-1",
  );
});

test("重复批准同一路线是幂等的", () => {
  const app = makeApp();
  seedMoEvent(app);
  planMoRoute(app);
  const first = app.approveRoute("route-1", {}, "approve-r1");
  const second = app.approveRoute("route-1", {}, "approve-r1");
  assert.equal(second.replay, true);
  assert.deepEqual(second.locks, first.locks);
});

test("过期版本批准被拒绝（乐观并发）", () => {
  const app = makeApp();
  seedMoEvent(app);
  planMoRoute(app);
  assert.throws(
    () => app.approveRoute("route-1", { expectedVersion: 99 }, "approve-r1"),
    (err) => err.code === "CONFLICT",
  );
});

test("运输缓冲不足被拒绝", () => {
  const app = makeApp();
  app.requestEvent({
    eventId: "evt-back",
    schoolId: "hk-school-2",
    venueId: "hk-venue",
    startAt: "2026-10-06T01:00:00.000Z",
    endAt: "2026-10-06T05:00:00.000Z",
    requiredExhibitIds: ["core-1"],
  }, "req-evt-back");
  assert.throws(
    () => app.planRoute({
      routeId: "route-tight",
      legs: [
        { fromVenueId: "hk-venue", toVenueId: "mo-venue", departAt: "2026-10-04T00:00:00.000Z", arriveAt: "2026-10-04T08:00:00.000Z", exhibitIds: ["core-1"], docentIds: [] },
        { fromVenueId: "mo-venue", toVenueId: "hk-venue", departAt: "2026-10-04T10:00:00.000Z", arriveAt: "2026-10-04T18:00:00.000Z", exhibitIds: ["core-1"], docentIds: [], eventId: "evt-back" },
      ],
    }, "plan-tight"),
    (err) => err.code === "TRANSPORT_BUFFER",
  );
});

test("场馆条件与讲解员资质不满足时被拒绝", () => {
  const app = makeApp();
  app.registerExhibit({
    exhibitId: "heavy-1",
    name: "重型发动机",
    capabilities: ["engine-display"],
    requiresConditions: ["climateControlled"],
    weightKg: 400, // 澳门馆承重上限 300kg
    homeVenueId: "hk-venue",
  }, "reg-heavy");
  app.requestEvent({
    eventId: "evt-heavy",
    schoolId: "mo-school-3",
    venueId: "mo-venue",
    startAt: "2026-10-05T01:00:00.000Z",
    endAt: "2026-10-05T07:00:00.000Z",
    requiredExhibitIds: ["heavy-1"],
  }, "req-evt-heavy");
  assert.throws(
    () => app.planRoute({
      routeId: "route-heavy",
      legs: [{ fromVenueId: "hk-venue", toVenueId: "mo-venue", departAt: "2026-10-04T00:00:00.000Z", arriveAt: "2026-10-04T08:00:00.000Z", exhibitIds: ["heavy-1"], docentIds: [], eventId: "evt-heavy" }],
    }, "plan-heavy"),
    (err) => err.code === "VENUE_CONDITION",
  );

  seedMoEvent(app, { eventId: "evt-qual", priority: 1 });
  assert.throws(
    () => app.planRoute({
      routeId: "route-noqual",
      legs: [{ fromVenueId: "hk-venue", toVenueId: "mo-venue", departAt: "2026-10-04T00:00:00.000Z", arriveAt: "2026-10-04T08:00:00.000Z", exhibitIds: ["core-1"], docentIds: [], eventId: "evt-qual" }],
    }, "plan-noqual"),
    (err) => err.code === "QUALIFICATION",
  );
});

test("维护停用窗口内的展具不可排期", () => {
  const app = makeApp();
  app.scheduleMaintenance({
    exhibitId: "core-1",
    startAt: "2026-10-03T00:00:00.000Z",
    endAt: "2026-10-07T00:00:00.000Z",
    reason: "年度检修",
  }, "maint-1");
  seedMoEvent(app);
  assert.throws(
    () => planMoRoute(app),
    (err) => err.code === "MAINTENANCE",
  );
});

test("高优先级路线可抢占尚未出发的低优先级路线，并留下审计痕迹", () => {
  const app = makeApp();
  seedMoEvent(app, { eventId: "evt-low", priority: 1 });
  planMoRoute(app, { routeId: "route-low", priority: 1, eventId: "evt-low" });
  app.approveRoute("route-low", {}, "approve-low");

  // 更高优先级的活动同期需要同一讲解员（docent-1 已被 route-low 锁定）
  app.requestEvent({
    eventId: "evt-vip2",
    schoolId: "mo-school-vip",
    venueId: "mo-venue",
    startAt: "2026-10-05T01:00:00.000Z",
    endAt: "2026-10-05T07:00:00.000Z",
    requiredExhibitIds: ["core-2"],
    requiredQualifications: ["astro-basics"],
    priority: 9,
  }, "req-evt-vip2");
  app.planRoute({
    routeId: "route-vip2",
    priority: 9,
    legs: [{ fromVenueId: "mo-venue", toVenueId: "mo-venue", departAt: "2026-10-04T12:00:00.000Z", arriveAt: "2026-10-04T13:00:00.000Z", exhibitIds: ["core-2"], docentIds: ["docent-1"], eventId: "evt-vip2" }],
  }, "plan-vip2");
  const result = app.approveRoute("route-vip2", {}, "approve-vip2");
  assert.deepEqual(result.preemptedRouteIds, ["route-low"]);
  assert.equal(app.getRoute("route-low").status, "PLANNED");
  assert.equal(app.getRoute("route-vip2").status, "APPROVED");

  const timeline = app.timeline({ entity: "docent-1" });
  const preempted = timeline.find((e) => e.type === "LockPreempted");
  assert.ok(preempted, "时间线应包含 LockPreempted");
  assert.match(preempted.reason, /route-vip2/);
  assert.equal(preempted.responsibility, "operations");
});

test("已出发路线不可被抢占", () => {
  const app = makeApp();
  seedMoEvent(app, { eventId: "evt-low", priority: 1 });
  planMoRoute(app, { routeId: "route-low", priority: 1, eventId: "evt-low" });
  app.approveRoute("route-low", {}, "approve-low");
  app.startLeg("route-low", 0, {}, "start-low");

  app.requestEvent({
    eventId: "evt-vip",
    schoolId: "mo-school-vip",
    venueId: "mo-venue",
    startAt: "2026-10-05T01:00:00.000Z",
    endAt: "2026-10-05T07:00:00.000Z",
    requiredExhibitIds: ["core-2"],
    requiredQualifications: ["astro-basics"],
    priority: 9,
  }, "req-evt-vip");
  app.planRoute({
    routeId: "route-vip",
    priority: 9,
    legs: [{ fromVenueId: "mo-venue", toVenueId: "mo-venue", departAt: "2026-10-04T12:00:00.000Z", arriveAt: "2026-10-04T13:00:00.000Z", exhibitIds: ["core-2"], docentIds: ["docent-1"], eventId: "evt-vip" }],
  }, "plan-vip");
  assert.throws(
    () => app.approveRoute("route-vip", {}, "approve-vip"),
    (err) => err.code === "CONFLICT",
  );
});
