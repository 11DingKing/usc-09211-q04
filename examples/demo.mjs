#!/usr/bin/env node
/**
 * 端到端场景演示（不启动 HTTP，直接驱动领域层；日志落在临时目录）。
 * 运行：node examples/demo.mjs
 *
 * 场景：
 *  1. 注册两地场馆、学校、两套核心展具、双地讲解员与 24h 跨境缓冲
 *  2. 香港学校借展核心舱，批准锁定
 *  3. 澳门同日来抢同一展具 → 被明确拒绝（已批准不可挤）
 *  4. 另一未批准占位被高优先级活动挤落，并在同一时间窗重规划到备用展具
 *  5. 运输途中核心舱损坏 → 自动改派备用舱，责任与受影响学校入时间线
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/domain/store.mjs";
import { Router } from "../src/domain/router.mjs";
import { zonedInstant } from "../src/domain/timezone.mjs";

const day = "2026-12-20";
const hk = (t) => zonedInstant(day, t, "Asia/Hong_Kong");
const mo = (t) => zonedInstant(day, t, "Asia/Macau");

const dir = mkdtempSync(join(tmpdir(), "tour-demo-"));
const store = new EventStore(join(dir, "events.jsonl"));
const router = await new Router(store).init();

const run = async (label, cmd, { ok = true } = {}) => {
  try {
    const r = await router.submit(cmd);
    console.log(`✓ ${label}: ${r.events.map((e) => e.type).join(", ")}${r.duplicate ? "（重复请求，幂等返回）" : ""}`);
    return r;
  } catch (err) {
    if (!ok) {
      console.log(`⊘ ${label}: 如预期被拒 [${err.code}] ${err.message}`);
      return null;
    }
    throw err;
  }
};

// 1. 基础数据
await run("注册香港科普馆", { type: "RegisterVenue", id: "v-hk", name: "香港科普馆", region: "HK", capabilities: ["power-3kw", "darkroom"] });
await run("注册香港中学", { type: "RegisterVenue", id: "s-hk-1", name: "濠光中学", kind: "school", region: "HK", capabilities: ["power-3kw"] });
await run("注册澳门科普馆", { type: "RegisterVenue", id: "v-mo", name: "澳门科普馆", region: "MO", capabilities: ["power-3kw", "darkroom"] });
await run("注册核心舱A", { type: "RegisterExhibit", id: "core-a", name: "核心舱 A", capabilities: ["core"], envRequirements: ["power-3kw"], region: "HK" });
await run("注册核心舱B", { type: "RegisterExhibit", id: "core-b", name: "核心舱 B", capabilities: ["core"], envRequirements: ["power-3kw"], region: "HK" });
await run("注册双地讲解员", { type: "RegisterGuide", id: "g-can", qualifications: ["bilingual"], regions: ["HK", "MO"] });
await run("配置跨境缓冲24h", { type: "ConfigureTravelBuffer", regionA: "HK", regionB: "MO", hours: 24 });

// 2. 学校借展并批准
await run("学校借展（10:00-12:00）", {
  type: "RequestActivity", commandId: "cmd-school", id: "school-day", title: "濠光中学航天日",
  venueId: "s-hk-1", schoolId: "s-hk-1", start: hk("10:00"), end: hk("12:00"),
  priority: 100, guideQualification: "bilingual", needs: ["core"],
});
await run("批准学校路线", { type: "ApproveAllocation", activityId: "school-day", actor: "ops-lead" });

// 3. 澳门同日抢同一展具：core-b 检修到 10:30（10:00 的澳门活动仍与其重叠而不可用），
//    core-a 被已批准路线持有不可挤 → 澳门请求被拒
await run("core-b 检修至 10:30", { type: "ScheduleMaintenance", exhibitId: "core-b", start: hk("00:00"), end: hk("10:30"), reason: "例检" });
await run("澳门同日抢展（应拒绝）", {
  type: "RequestActivity", commandId: "cmd-mo-clash", id: "mo-clash",
  venueId: "v-mo", start: mo("10:00"), end: mo("12:00"), priority: 10, needs: ["core"],
}, { ok: false });

// 4. 高优先级挤落未批准占位（安排在损坏日之前，避免与后续损坏替代链交织）
const day2 = "2026-12-18";
const hk2 = (t) => zonedInstant(day2, t, "Asia/Hong_Kong");
await run("普通占位 low", {
  type: "RequestActivity", commandId: "cmd-low", id: "low-1",
  venueId: "v-hk", start: hk2("14:00"), end: hk2("16:00"), priority: 100, needs: ["core"],
});
await run("高优先级活动 high（挤落 low 并令其改用 core-b）", {
  type: "RequestActivity", commandId: "cmd-high", id: "high-1",
  venueId: "v-hk", start: hk2("14:00"), end: hk2("16:00"), priority: 10, needs: ["core"],
});

// 5. 学校活动进行中 core-a 损坏（11:00）→ core-b 已检修结束，自动改派承担剩余时段
await run("上报 core-a 途中损坏", {
  type: "ReportDamage", commandId: "cmd-damage", incidentId: "inc-1", exhibitId: "core-a",
  at: hk("11:00"), reason: "跨境运输颠簸致结构件变形", causeCategory: "transport",
  location: "濠光中学体育馆", reporter: "logistics-chan",
  responsibility: { owner: "logistics", note: "运输固定不到位" },
});

console.log("\n—— 学校活动时间线（改派原因 / 责任 / 学校）——");
for (const r of router.timeline({ activityId: "school-day" })) {
  console.log(`${new Date(r.eventTime).toISOString()}  ${r.type}`);
}
const inc = router.incidentView("inc-1");
console.log("\n事件汇总:", JSON.stringify({ status: inc.status, responsibility: inc.responsibility, impact: inc.impact }, null, 2));

store.close();
rmSync(dir, { recursive: true, force: true });
