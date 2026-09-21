import assert from "node:assert/strict";
import test from "node:test";
import { makeRouter, seedBaseline, at } from "./helpers.mjs";

async function setup() {
  const ctx = makeRouter();
  await ctx.router.init();
  await seedBaseline(ctx.router);
  return ctx;
}

const reqCoreHK = (id, day, { priority = 100, guide = "bilingual" } = {}) => ({
  type: "RequestActivity",
  commandId: `cmd-${id}`,
  id,
  venueId: "v-hk",
  start: at(day, "10:00"),
  end: at(day, "12:00"),
  priority,
  guideQualification: guide,
  needs: ["core"],
});

test("讲解员休假窗口内不可派", async () => {
  const ctx = await setup();
  const day = "2026-12-01";
  // 两位讲解员都休假 → 无可用讲解员
  await ctx.router.submit({
    type: "ScheduleGuideLeave",
    guideId: "g-can",
    start: at(day, "00:00"),
    end: at(day, "23:59"),
    reason: "年假",
  });
  await ctx.router.submit({
    type: "ScheduleGuideLeave",
    guideId: "g-hk",
    start: at(day, "00:00"),
    end: at(day, "23:59"),
    reason: "年假",
  });
  await assert.rejects(() => ctx.router.submit(reqCoreHK("leave-1", day)), (err) => {
    assert.equal(err.code, "ALLOCATION_FAILED");
    assert.match(JSON.stringify(err.details), /leave/);
    return true;
  });
  ctx.cleanup();
});

test("同等优先级不能互相挤落", async () => {
  const ctx = await setup();
  const day = "2026-12-02";
  await ctx.router.submit({
    type: "ScheduleMaintenance",
    exhibitId: "core-b",
    start: at(day, "00:00"),
    end: at(day, "23:59"),
  });
  await ctx.router.submit(reqCoreHK("p100-a", day, { priority: 100 }));
  await assert.rejects(
    () => ctx.router.submit(reqCoreHK("p100-b", day, { priority: 100 })),
    (err) => err.code === "ALLOCATION_FAILED",
  );
  assert.equal(ctx.router.activityView("p100-a").status, "held");
  ctx.cleanup();
});

test("场馆条件不满足展具环境要求时不入选：天象厅需要暗房，学校无暗房", async () => {
  const ctx = await setup();
  const day = "2026-12-03";
  await assert.rejects(
    () =>
      ctx.router.submit({
        type: "RequestActivity",
        commandId: "cmd-env",
        id: "env-1",
        venueId: "s-hk-1", // 无 darkroom
        start: at(day, "10:00"),
        end: at(day, "12:00"),
        priority: 100,
        needs: ["planetarium"], // dome-1 需要 darkroom
      }),
    (err) => err.code === "ALLOCATION_FAILED",
  );
  // 澳门场馆有 darkroom，可排
  const ok = await ctx.router.submit({
    type: "RequestActivity",
    commandId: "cmd-env-ok",
    id: "env-2",
    venueId: "v-mo",
    start: at(day, "10:00", "Asia/Macau"),
    end: at(day, "12:00", "Asia/Macau"),
    priority: 100,
    needs: ["planetarium"],
  });
  assert.deepEqual(ok.events.find((e) => e.type === "AllocationHeld").data.exhibitIds, ["dome-1"]);
  ctx.cleanup();
});

test("已批准路线上的展具损坏，替代链照常执行且批准状态不变", async () => {
  const ctx = await setup();
  const day = "2026-12-04";
  await ctx.router.submit(reqCoreHK("appr-1", day, { guide: null }));
  await ctx.router.submit({ type: "ApproveAllocation", activityId: "appr-1", actor: "ops" });
  await ctx.router.submit({
    type: "ReportDamage",
    commandId: "cmd-dmg-approved",
    incidentId: "inc-approved",
    exhibitId: "core-a",
    at: at(day, "11:00"),
    reason: "运行中故障",
    responsibility: { owner: "tech" },
  });
  const view = ctx.router.activityView("appr-1");
  assert.equal(view.status, "approved");
  assert.deepEqual(view.assignments.exhibitIds, ["core-b"]);
  assert.equal(ctx.router.incidentView("inc-approved").status, "resolved");
  ctx.cleanup();
});

test("过去的时间窗与非法参数被拒", async () => {
  const ctx = await setup();
  await assert.rejects(
    () =>
      ctx.router.submit({
        type: "RequestActivity",
        commandId: "cmd-past",
        id: "past-1",
        venueId: "v-hk",
        start: at("2025-01-01", "10:00"),
        end: at("2025-01-01", "12:00"),
        needs: ["core"],
      }),
    (err) => err.code === "VALIDATION",
  );
  await assert.rejects(
    () => ctx.router.submit({ type: "ConfigureTravelBuffer", regionA: "HK", regionB: "TW", hours: 5 }),
    (err) => err.code === "VALIDATION",
  );
  ctx.cleanup();
});
