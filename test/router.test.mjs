import assert from "node:assert/strict";
import test from "node:test";
import { CommandError } from "../src/domain/engine.mjs";
import { makeRouter, seedBaseline, at } from "./helpers.mjs";

async function setup() {
  const ctx = makeRouter();
  await ctx.router.init();
  await seedBaseline(ctx.router);
  return ctx;
}

const requestCore = (id, venueId, day, { priority = 100, guide = "bilingual", startH = "10:00", endH = "12:00" } = {}) => ({
  type: "RequestActivity",
  commandId: `cmd-${id}`,
  id,
  title: `活动 ${id}`,
  venueId,
  start: at(day, startH),
  end: at(day, endH),
  priority,
  guideQualification: guide,
  needs: ["core"],
});

test("同一展具不能被同时承诺给两地：第二次同窗请求被明确拒绝", async () => {
  const ctx = await setup();
  const day = "2026-09-15";
  await ctx.router.submit(requestCore("a-hk", "v-hk", day));
  await assert.rejects(
    () => ctx.router.submit(requestCore("a-mo", "v-mo", day)),
    (err) => {
      assert.ok(err instanceof CommandError);
      assert.equal(err.code, "ALLOCATION_FAILED");
      assert.match(JSON.stringify(err.details), /commitment|transport_buffer/);
      return true;
    },
  );
  ctx.cleanup();
});

test("并发提交同一时间窗的两个活动也只允许一个成功", async () => {
  const ctx = await setup();
  const day = "2026-09-16";
  const [r1, r2] = await Promise.allSettled([
    ctx.router.submit(requestCore("race-1", "v-hk", day)),
    ctx.router.submit(requestCore("race-2", "v-mo", day)),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, ["fulfilled", "rejected"]);
  const routes = ctx.router.routes().filter((r) => ["race-1", "race-2"].includes(r.id));
  const held = routes.filter((r) => r.status === "held");
  assert.equal(held.length, 1);
  ctx.cleanup();
});

test("同一 commandId 的重复请求返回首次结果且不重复锁定", async () => {
  const ctx = await setup();
  const day = "2026-09-17";
  const cmd = requestCore("dup-1", "v-hk", day);
  const first = await ctx.router.submit(cmd);
  const second = await ctx.router.submit(cmd);
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.events, first.events);
  // core-a 上当天只有一个承诺
  const view = ctx.router.activityView("dup-1");
  assert.equal(view.status, "held");
  ctx.cleanup();
});

test("已批准承诺不可被更高优先级请求挤落，高优先级请求被拒绝", async () => {
  const ctx = await setup();
  const day = "2026-09-18";
  // core-b 同日检修，全场只剩 core-a，才能真正考验“已批准不可挤”
  await ctx.router.submit({
    type: "ScheduleMaintenance",
    exhibitId: "core-b",
    start: at(day, "00:00"),
    end: at(day, "23:59"),
    reason: "检修",
  });
  await ctx.router.submit(requestCore("low", "v-hk", day, { priority: 100 }));
  await ctx.router.submit({ type: "ApproveAllocation", activityId: "low", actor: "ops-lead" });
  await assert.rejects(
    () => ctx.router.submit(requestCore("high", "v-hk", day, { priority: 10 })),
    (err) => err.code === "ALLOCATION_FAILED",
  );
  assert.equal(ctx.router.activityView("low").status, "approved");
  assert.deepEqual(ctx.router.activityView("low").assignments.exhibitIds, ["core-a"]);
  ctx.cleanup();
});

test("未批准占位可被更高优先级挤落，被挤落者在同一时间窗重规划到替代展具", async () => {
  const ctx = await setup();
  const day = "2026-09-19";
  await ctx.router.submit(requestCore("low", "v-hk", day, { priority: 100 }));
  const before = ctx.router.activityView("low");
  assert.equal(before.assignments.exhibitIds[0], "core-a");

  await ctx.router.submit(requestCore("high", "v-hk", day, { priority: 10 }));
  const high = ctx.router.activityView("high");
  const low = ctx.router.activityView("low");
  assert.equal(high.assignments.exhibitIds[0], "core-a");
  assert.equal(low.status, "held");
  assert.deepEqual(low.assignments.exhibitIds, ["core-b"]);
  // 两活动同窗但展具不同，不重叠
  assert.notDeepEqual(high.assignments.exhibitIds, low.assignments.exhibitIds);
  ctx.cleanup();
});

test("被挤落且无替代资源时显式 blocked，而不是静默改期", async () => {
  const ctx = await setup();
  // 维护停用 core-b，使被挤落者无替代
  const day = "2026-09-20";
  await ctx.router.submit({
    type: "ScheduleMaintenance",
    exhibitId: "core-b",
    start: at(day, "00:00"),
    end: at(day, "23:59"),
    reason: "检修",
  });
  await ctx.router.submit(requestCore("low", "v-hk", day, { priority: 100 }));
  await ctx.router.submit(requestCore("high", "v-hk", day, { priority: 10 }));
  const low = ctx.router.activityView("low");
  assert.equal(low.status, "blocked");
  assert.equal(low.blockReason.code, "DISPLACED_NO_ALTERNATIVE");
  // 时间窗未被移动
  assert.equal(low.start, at(day, "10:00"));
  assert.equal(low.end, at(day, "12:00"));
  ctx.cleanup();
});

test("跨境运输缓冲不足时拒绝相邻排期", async () => {
  const ctx = await setup();
  // 10:00-12:00 在香港，紧接 12:00-14:00 在澳门：需要 24h 缓冲
  await ctx.router.submit(requestCore("hk-first", "v-hk", "2026-09-21", { startH: "10:00", endH: "12:00" }));
  await assert.rejects(
    () =>
      ctx.router.submit(
        requestCore("mo-next", "v-mo", "2026-09-21", { startH: "12:00", endH: "14:00" }),
      ),
    (err) => {
      assert.equal(err.code, "ALLOCATION_FAILED");
      assert.match(JSON.stringify(err.details), /transport_buffer/);
      return true;
    },
  );
  ctx.cleanup();
});

test("释放后同一展具可被重新承诺", async () => {
  const ctx = await setup();
  const day = "2026-09-22";
  await ctx.router.submit(requestCore("a1", "v-hk", day));
  await ctx.router.submit({ type: "ReleaseAllocation", activityId: "a1", reason: "学校取消", actor: "school" });
  const r = await ctx.router.submit(requestCore("a2", "v-mo", day));
  assert.equal(r.duplicate, false);
  assert.equal(ctx.router.activityView("a2").status, "held");
  ctx.cleanup();
});

test("讲解员资质与地区准入：仅 HK 资质的讲解员不能派往澳门", async () => {
  const ctx = await setup();
  const day = "2026-09-23";
  // g-can（双地）先在香港占用同窗；澳门活动只能找 g-hk，但他无 MO 资质
  await ctx.router.submit(requestCore("hk-busy", "v-hk", day));
  await assert.rejects(
    () => ctx.router.submit(requestCore("mo-no-guide", "v-mo", day)),
    (err) => {
      assert.equal(err.code, "ALLOCATION_FAILED");
      assert.match(JSON.stringify(err.details), /region_not_qualified/);
      return true;
    },
  );
  ctx.cleanup();
});
