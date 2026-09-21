import assert from "node:assert/strict";
import test from "node:test";
import { makeRouter, reopen, seedBaseline, at } from "./helpers.mjs";

async function setup() {
  const ctx = makeRouter();
  await ctx.router.init();
  await seedBaseline(ctx.router);
  return ctx;
}

const schoolRequest = (id, day, { startH = "10:00", endH = "12:00", priority = 100 } = {}) => ({
  type: "RequestActivity",
  commandId: `cmd-${id}`,
  id,
  title: `校园借展 ${id}`,
  venueId: "s-hk-1",
  schoolId: "s-hk-1",
  start: at(day, startH),
  end: at(day, endH),
  priority,
  guideQualification: "bilingual",
  needs: ["core"],
});

test("途中损坏触发可追溯替代：活动改派到备用展具，事件链完整", async () => {
  const ctx = await setup();
  const day = "2026-10-05";
  await ctx.router.submit(schoolRequest("act-1", day));
  const before = ctx.router.activityView("act-1");
  assert.deepEqual(before.assignments.exhibitIds, ["core-a"]);

  // 活动进行到 11:00 时 core-a 损坏
  const damageAt = at(day, "11:00");
  const result = await ctx.router.submit({
    type: "ReportDamage",
    commandId: "cmd-damage-1",
    incidentId: "inc-1",
    exhibitId: "core-a",
    at: damageAt,
    reason: "运输颠簸导致结构件变形",
    causeCategory: "transport",
    location: "香江某中学体育馆",
    reporter: "logistics-chan",
    responsibility: { owner: "logistics", note: "跨境运输固定不到位" },
  });
  const types = result.events.map((e) => e.type);
  assert.deepEqual(types, ["DamageReported", "ExhibitReassigned", "SubstitutionChainFinished"]);

  const after = ctx.router.activityView("act-1");
  assert.equal(after.status, "held");
  assert.deepEqual(after.assignments.exhibitIds, ["core-b"]);

  const inc = ctx.router.incidentView("inc-1");
  assert.equal(inc.status, "resolved");
  assert.equal(inc.substitutions[0].toExhibitId, "core-b");
  assert.equal(inc.substitutions[0].partial, true);
  assert.deepEqual(inc.substitutions[0].newStart ?? inc.substitutions[0].newStart, damageAt);
  // 责任边界与受影响学校可查
  assert.equal(inc.responsibility.owner, "logistics");
  assert.equal(inc.chainResult.affected[0].schoolId, "s-hk-1");
  assert.equal(inc.impact[0].school.id, "s-hk-1");
  assert.equal(inc.impact[0].result, "reassigned");
  ctx.cleanup();
});

test("无替代展具时活动被显式阻断并记录受影响学校，绝不静默改期", async () => {
  const ctx = await setup();
  const day = "2026-10-06";
  // 先让 core-b 在另一场馆同窗被占用（学校活动只能用 core-a）
  await ctx.router.submit({
    type: "RequestActivity",
    commandId: "cmd-other",
    id: "other",
    venueId: "v-hk",
    start: at(day, "10:00"),
    end: at(day, "12:00"),
    priority: 100,
    guideQualification: null,
    needs: ["core"],
  });
  // other 拿到 core-b（core-a 留给学校？候选排序同为 HK 时按 id：core-a 先）
  // 实际 core-a 会被 other 取走——改为让学校先占 core-a
  ctx.cleanup();

  const ctx2 = await setup();
  await ctx2.router.submit(schoolRequest("school-1", day));
  await ctx2.router.submit({
    type: "RequestActivity",
    commandId: "cmd-other2",
    id: "other2",
    venueId: "v-hk",
    start: at(day, "10:00"),
    end: at(day, "12:00"),
    priority: 100,
    guideQualification: null,
    needs: ["core"],
  });
  // core-a 给学校，core-b 给 other2；两套全部占用
  assert.deepEqual(ctx2.router.activityView("school-1").assignments.exhibitIds, ["core-a"]);
  assert.deepEqual(ctx2.router.activityView("other2").assignments.exhibitIds, ["core-b"]);

  const result = await ctx2.router.submit({
    type: "ReportDamage",
    commandId: "cmd-damage-2",
    incidentId: "inc-2",
    exhibitId: "core-a",
    at: at(day, "11:00"),
    reason: "演示中短路",
    responsibility: { owner: "venue", note: "供电不稳" },
  });
  const types = result.events.map((e) => e.type);
  assert.deepEqual(types, ["DamageReported", "SubstitutionFailed", "SubstitutionChainFinished"]);

  const school = ctx2.router.activityView("school-1");
  assert.equal(school.status, "blocked");
  assert.equal(school.blockReason.code, "DAMAGE_NO_SUBSTITUTE");
  assert.equal(school.blockDetails.schoolId, "s-hk-1");
  // 时间窗保持不变（没有被悄悄挪动）
  assert.equal(school.start, at(day, "10:00"));

  const inc = ctx2.router.incidentView("inc-2");
  assert.equal(inc.status, "partial_blocked");
  assert.equal(inc.chainResult.blocked[0].activityId, "school-1");
  // other2 未受影响，仍持 core-b
  assert.deepEqual(ctx2.router.activityView("other2").assignments.exhibitIds, ["core-b"]);
  ctx2.cleanup();
});

test("损坏展具退出可用池，修复前后续活动不能再选它", async () => {
  const ctx = await setup();
  const day = "2026-10-07";
  await ctx.router.submit({
    type: "ReportDamage",
    commandId: "cmd-dmg",
    exhibitId: "core-a",
    at: at(day, "06:00"),
    reason: "仓储进水",
  });
  await ctx.router.submit(schoolRequest("late", day, { startH: "15:00", endH: "17:00" }));
  assert.deepEqual(ctx.router.activityView("late").assignments.exhibitIds, ["core-b"]);

  await ctx.router.submit({ type: "RepairExhibit", exhibitId: "core-a", actor: "tech" });
  const day2 = "2026-10-08";
  await ctx.router.submit(schoolRequest("late2", day2));
  assert.deepEqual(ctx.router.activityView("late2").assignments.exhibitIds, ["core-a"]);
  ctx.cleanup();
});

test("重启后继续执行已批准路线：状态从事件日志完整恢复", async () => {
  const ctx = await setup();
  const day = "2026-10-09";
  await ctx.router.submit(schoolRequest("persist-1", day));
  await ctx.router.submit({ type: "ApproveAllocation", activityId: "persist-1", actor: "ops" });
  // core-b 同日检修，确保唯一资源就是已批准路线占用的 core-a
  await ctx.router.submit({
    type: "ScheduleMaintenance",
    exhibitId: "core-b",
    start: at(day, "00:00"),
    end: at(day, "23:59"),
    reason: "检修",
  });

  const router2 = await reopen(ctx);
  const view = router2.activityView("persist-1");
  assert.equal(view.status, "approved");
  assert.equal(view.approvedBy, "ops");
  assert.deepEqual(view.assignments.exhibitIds, ["core-a"]);

  // 恢复后并发不变量依旧成立：同窗竞争仍被拒绝
  await assert.rejects(
    () =>
      router2.submit({
        type: "RequestActivity",
        commandId: "cmd-after-restart",
        id: "after-restart",
        venueId: "s-hk-1",
        schoolId: "s-hk-1",
        start: at(day, "10:00"),
        end: at(day, "12:00"),
        priority: 10,
        guideQualification: "bilingual",
        needs: ["core"],
      }),
    (err) => err.code === "ALLOCATION_FAILED",
  );
  // commandId 幂等记忆也随日志恢复
  const again = await router2.submit(schoolRequest("persist-1", day));
  assert.equal(again.duplicate, true);
  ctx.cleanup();
});

test("时间线可看清每次改派的原因、责任与受影响学校", async () => {
  const ctx = await setup();
  const day = "2026-10-10";
  await ctx.router.submit(schoolRequest("tl-1", day));
  await ctx.router.submit({
    type: "ReportDamage",
    commandId: "cmd-dmg-tl",
    incidentId: "inc-tl",
    exhibitId: "core-a",
    at: at(day, "11:00"),
    reason: "外力碰撞",
    responsibility: { owner: "logistics" },
  });
  const tl = ctx.router.timeline({ activityId: "tl-1" }).map((r) => r.type);
  assert.ok(tl.includes("ActivityRequested"));
  assert.ok(tl.includes("AllocationHeld"));
  assert.ok(tl.includes("ExhibitReassigned"));
  const record = ctx.router.timeline({ activityId: "tl-1" })[0];
  assert.ok(typeof record.eventTime === "number");
  assert.ok(typeof record.receivedAt === "number");
  ctx.cleanup();
});
