import { VenueCalendar } from "./timezone.mjs";

/**
 * 巡展路由状态机：所有状态变化都来自事件（event-sourced）。
 * 本模块是纯函数式的 reduce + 只读投影；决策与落盘由 router.mjs 负责。
 *
 * 关键不变量（由 router 的规划器与本文件的投影共同保证）：
 *  1. 同一展具 / 讲解员的承诺区间互不重叠（含跨境运输缓冲）。
 *  2. 已批准（approved）承诺不可被任何新请求挤占；未批准占位（held）只能被更高优先级挤落。
 *  3. 损坏展具立即退出可用池，替代链每一跳都有事件；无法替代时显式 blocked，绝不静默改期。
 *  4. 场馆日历判定一律使用场馆时区。
 */

export class CommandError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.details = details;
  }
}

export function initialState() {
  return {
    venues: new Map(), // id -> { id, name, kind, region, timeZone, capabilities, requiredCapabilities, calendar }
    exhibits: new Map(), // id -> { id, name, sequenceId, capabilities, envRequirements, region, damaged }
    guides: new Map(), // id -> { id, name, qualifications, regions, damaged? }
    activities: new Map(), // id -> activity
    incidents: new Map(), // id -> incident
    travel: new Map(), // "HK|MO" -> 小时数（无序键）
    maintenance: new Map(), // exhibitId -> [{ id, start, end, reason }]
    guideLeaves: new Map(), // guideId -> [{ start, end, reason }]
    /** 展具承诺：exhibitId -> [{ start,end,kind,activityId,region }]，按 start 排序 */
    exhibitCommitments: new Map(),
    guideCommitments: new Map(),
  };
}

const travelKey = (a, b) => [a, b].sort().join("|");

export function travelHoursBetween(state, regionA, regionB) {
  if (regionA === regionB) return state.travel.get(travelKey(regionA, regionB)) ?? 0;
  const hours = state.travel.get(travelKey(regionA, regionB));
  if (hours == null) {
    throw new CommandError("TRAVEL_NOT_CONFIGURED", `尚未配置 ${regionA} 与 ${regionB} 之间的运输缓冲`);
  }
  return hours;
}

export function calendarOf(venue) {
  return new VenueCalendar({
    timeZone: venue.timeZone,
    holidays: venue.calendar.holidays,
    weeklyClosed: venue.calendar.weeklyClosed,
    openHours: venue.calendar.openHours,
  });
}

export function apply(state, record) {
  const { type, data } = record;
  switch (type) {
    case "VenueRegistered": {
      state.venues.set(data.id, {
        kind: "venue",
        capabilities: [],
        requiredCapabilities: [],
        calendar: { holidays: [], weeklyClosed: [], openHours: [] },
        ...data,
      });
      break;
    }
    case "VenueCalendarUpdated": {
      const venue = mustGet(state.venues, data.venueId, "场馆");
      venue.calendar = data.calendar;
      break;
    }
    case "ExhibitRegistered": {
      state.exhibits.set(data.id, { damaged: null, ...data });
      break;
    }
    case "GuideRegistered": {
      state.guides.set(data.id, data);
      break;
    }
    case "TravelBufferConfigured": {
      state.travel.set(travelKey(data.regionA, data.regionB), data.hours);
      break;
    }
    case "ActivityRequested": {
      state.activities.set(data.id, {
        status: "requested",
        assignments: null,
        ...data,
      });
      break;
    }
    case "AllocationHeld": {
      const activity = mustGet(state.activities, data.activityId, "活动");
      activity.status = "held";
      activity.assignments = { exhibitIds: data.exhibitIds, guideId: data.guideId, plan: data.plan };
      for (const id of data.exhibitIds) {
        pushCommitment(state.exhibitCommitments, id, {
          start: activity.start,
          end: activity.end,
          kind: "activity",
          activityId: activity.id,
          region: activity.region,
        });
      }
      if (data.guideId) {
        pushCommitment(state.guideCommitments, data.guideId, {
          start: activity.start,
          end: activity.end,
          kind: "activity",
          activityId: activity.id,
          region: activity.region,
        });
      }
      break;
    }
    case "AllocationDisplaced": {
      const activity = mustGet(state.activities, data.activityId, "活动");
      removeCommitments(state, activity);
      activity.status = "displaced";
      activity.displacedBy = data.byActivityId;
      activity.assignments = null;
      break;
    }
    case "AllocationReplanned": {
      // 被挤落后重新占位成功
      const activity = mustGet(state.activities, data.activityId, "活动");
      activity.status = "held";
      activity.assignments = { exhibitIds: data.exhibitIds, guideId: data.guideId, plan: data.plan };
      for (const id of data.exhibitIds) {
        pushCommitment(state.exhibitCommitments, id, {
          start: activity.start,
          end: activity.end,
          kind: "activity",
          activityId: activity.id,
          region: activity.region,
        });
      }
      if (data.guideId) {
        pushCommitment(state.guideCommitments, data.guideId, {
          start: activity.start,
          end: activity.end,
          kind: "activity",
          activityId: activity.id,
          region: activity.region,
        });
      }
      break;
    }
    case "AllocationApproved": {
      const activity = mustGet(state.activities, data.activityId, "活动");
      activity.status = "approved";
      activity.approvedAt = data.at;
      activity.approvedBy = data.actor;
      break;
    }
    case "AllocationReleased": {
      const activity = mustGet(state.activities, data.activityId, "活动");
      removeCommitments(state, activity);
      activity.status = "released";
      activity.releaseReason = data.reason;
      activity.assignments = null;
      break;
    }
    case "AllocationBlocked": {
      const activity = mustGet(state.activities, data.activityId, "活动");
      if (activity.assignments) removeCommitments(state, activity);
      activity.status = "blocked";
      activity.blockReason = data.reason;
      activity.blockDetails = data.details;
      activity.assignments = null;
      break;
    }
    case "DamageReported": {
      const exhibit = mustGet(state.exhibits, data.exhibitId, "展具");
      exhibit.damaged = { incidentId: data.incidentId, at: data.at };
      state.incidents.set(data.incidentId, { ...data, substitutions: [], status: "open" });
      break;
    }
    case "ExhibitReassigned": {
      // 损坏替代链上的一跳：把某活动（或活动剩余时段）从旧展具改派到新展具
      const incident = mustGet(state.incidents, data.incidentId, "事件");
      const activity = mustGet(state.activities, data.activityId, "活动");
      // 从旧展具摘除原承诺窗口；途中损坏时新展具只承担损坏时刻之后的剩余窗口
      removeInterval(state.exhibitCommitments, data.fromExhibitId, data.oldStart, data.oldEnd, activity.id);
      pushCommitment(state.exhibitCommitments, data.toExhibitId, {
        start: data.newStart,
        end: data.newEnd,
        kind: "activity",
        activityId: activity.id,
        region: activity.region,
      });
      if (activity.assignments) {
        activity.assignments.exhibitIds = activity.assignments.exhibitIds
          .filter((id) => id !== data.fromExhibitId)
          .concat(data.toExhibitId)
          .filter((v, i, arr) => arr.indexOf(v) === i);
        activity.assignments.plan = data.plan ?? activity.assignments.plan;
      }
      incident.substitutions.push(data);
      break;
    }
    case "SubstitutionFailed": {
      // 找不到替代：活动被显式阻断并留痕，禁止静默改期；同时释放其僵占的其余资源
      const incident = mustGet(state.incidents, data.incidentId, "事件");
      const activity = mustGet(state.activities, data.activityId, "活动");
      releaseAllCommitments(state, activity);
      activity.status = "blocked";
      activity.blockReason = data.reason;
      activity.blockDetails = { at: data.at, schoolId: data.schoolId, capability: data.capability };
      activity.assignments = null;
      incident.substitutions.push(data);
      break;
    }
    case "SubstitutionChainFinished": {
      const incident = mustGet(state.incidents, data.incidentId, "事件");
      incident.status = data.blocked.length > 0 ? "partial_blocked" : "resolved";
      incident.chainResult = data;
      break;
    }
    case "ExhibitRepaired": {
      const exhibit = mustGet(state.exhibits, data.exhibitId, "展具");
      exhibit.damaged = null;
      break;
    }
    case "MaintenanceScheduled": {
      const list = state.maintenance.get(data.exhibitId) ?? [];
      list.push({ id: data.id, start: data.start, end: data.end, reason: data.reason });
      list.sort((a, b) => a.start - b.start);
      state.maintenance.set(data.exhibitId, list);
      break;
    }
    case "GuideLeaveScheduled": {
      const list = state.guideLeaves.get(data.guideId) ?? [];
      list.push({ start: data.start, end: data.end, reason: data.reason });
      list.sort((a, b) => a.start - b.start);
      state.guideLeaves.set(data.guideId, list);
      break;
    }
    default:
      // 未知事件不允许悄悄忽略：日志与代码版本不一致时必须暴露
      throw new Error(`未知事件类型：${type}`);
  }
  return state;
}

function mustGet(map, id, label) {
  const v = map.get(id);
  if (!v) throw new CommandError("NOT_FOUND", `${label}不存在：${id}`);
  return v;
}

function pushCommitment(map, ownerId, c) {
  const list = map.get(ownerId) ?? [];
  list.push(c);
  list.sort((a, b) => a.start - b.start);
  map.set(ownerId, list);
}

function removeCommitments(state, activity) {
  if (!activity.assignments) return;
  releaseAllCommitments(state, activity);
}

function releaseAllCommitments(state, activity) {
  for (const [ownerId, list] of state.exhibitCommitments) {
    const kept = list.filter((c) => c.activityId !== activity.id);
    if (kept.length !== list.length) state.exhibitCommitments.set(ownerId, kept);
  }
  for (const [ownerId, list] of state.guideCommitments) {
    const kept = list.filter((c) => c.activityId !== activity.id);
    if (kept.length !== list.length) state.guideCommitments.set(ownerId, kept);
  }
}

function removeInterval(map, ownerId, start, end, activityId) {
  const list = map.get(ownerId) ?? [];
  const remaining = list.filter(
    (c) => !(c.activityId === activityId && c.start === start && c.end === end),
  );
  map.set(ownerId, remaining);
}

export const overlaps = (s1, e1, s2, e2) => s1 < e2 && s2 < e1;

export function maintenanceWindows(state, exhibitId, at) {
  return (state.maintenance.get(exhibitId) ?? []).filter((w) => w.end > at);
}

export function isExhibitAvailable(state, exhibit, at) {
  if (exhibit.damaged && exhibit.damaged.at <= at) return false;
  return true;
}

/**
 * 判断展具在 [start,end) 于 region 办活动是否可行。
 * 返回 { ok, conflicts }，conflicts 中带可挤落信息。
 * ignoreActivityId：被替代/重规划中的活动自身承诺。
 */
export function checkExhibitWindow(state, exhibitId, start, end, region, ignoreActivityId) {
  const conflicts = [];
  const exhibit = state.exhibits.get(exhibitId);
  if (!exhibit) return { ok: false, conflicts: [{ kind: "missing" }] };
  if (!isExhibitAvailable(state, exhibit, start)) {
    conflicts.push({ kind: "damaged", exhibitId });
  }
  for (const w of state.maintenance.get(exhibitId) ?? []) {
    if (overlaps(start, end, w.start, w.end)) {
      conflicts.push({ kind: "maintenance", window: w });
    }
  }
  const commitments = state.exhibitCommitments.get(exhibitId) ?? [];
  for (const c of commitments) {
    if (c.activityId === ignoreActivityId) continue;
    if (overlaps(start, end, c.start, c.end)) {
      const blocker = state.activities.get(c.activityId);
      conflicts.push({
        kind: "commitment",
        commitment: c,
        displaceable: blocker?.status === "held",
        priority: blocker?.priority,
        activityId: c.activityId,
      });
    }
  }
  // 运输缓冲：与紧邻的前/后承诺之间必须留足跨区运输时间
  const before = commitments
    .filter((c) => c.end <= start && c.activityId !== ignoreActivityId)
    .sort((a, b) => b.end - a.end)[0];
  const after = commitments
    .filter((c) => c.start >= end && c.activityId !== ignoreActivityId)
    .sort((a, b) => a.start - b.start)[0];
  if (before) {
    const need = travelHoursBetween(state, before.region, region) * 3_600_000;
    if (start - before.end < need) {
      const blocker = state.activities.get(before.activityId);
      conflicts.push({
        kind: "transport_buffer",
        side: "before",
        against: before.activityId,
        needHours: need / 3_600_000,
        displaceable: blocker?.status === "held",
        priority: blocker?.priority,
        activityId: before.activityId,
      });
    }
  }
  if (after) {
    const need = travelHoursBetween(state, region, after.region) * 3_600_000;
    if (after.start - end < need) {
      const blocker = state.activities.get(after.activityId);
      conflicts.push({
        kind: "transport_buffer",
        side: "after",
        against: after.activityId,
        needHours: need / 3_600_000,
        displaceable: blocker?.status === "held",
        priority: blocker?.priority,
        activityId: after.activityId,
      });
    }
  }
  return { ok: conflicts.length === 0, conflicts };
}

/** 讲解员在 [start,end) 于 region 是否可排（含跨区缓冲与休假）。 */
export function checkGuideWindow(state, guideId, start, end, region, ignoreActivityId) {
  const conflicts = [];
  const guide = state.guides.get(guideId);
  if (!guide) return { ok: false, conflicts: [{ kind: "missing" }] };
  if (!guide.regions.includes(region)) conflicts.push({ kind: "region_not_qualified", region });
  for (const leave of state.guideLeaves.get(guideId) ?? []) {
    if (overlaps(start, end, leave.start, leave.end)) conflicts.push({ kind: "leave", leave });
  }
  const commitments = state.guideCommitments.get(guideId) ?? [];
  for (const c of commitments) {
    if (c.activityId === ignoreActivityId) continue;
    if (overlaps(start, end, c.start, c.end)) {
      const blocker = state.activities.get(c.activityId);
      conflicts.push({
        kind: "commitment",
        commitment: c,
        displaceable: blocker?.status === "held",
        priority: blocker?.priority,
        activityId: c.activityId,
      });
    }
  }
  const before = commitments
    .filter((c) => c.end <= start && c.activityId !== ignoreActivityId)
    .sort((a, b) => b.end - a.end)[0];
  const after = commitments
    .filter((c) => c.start >= end && c.activityId !== ignoreActivityId)
    .sort((a, b) => a.start - b.start)[0];
  if (before) {
    const need = travelHoursBetween(state, before.region, region) * 3_600_000;
    if (start - before.end < need)
      conflicts.push({
        kind: "transport_buffer",
        side: "before",
        against: before.activityId,
        needHours: need / 3_600_000,
        displaceable: state.activities.get(before.activityId)?.status === "held",
        priority: state.activities.get(before.activityId)?.priority,
        activityId: before.activityId,
      });
  }
  if (after) {
    const need = travelHoursBetween(state, region, after.region) * 3_600_000;
    if (after.start - end < need)
      conflicts.push({
        kind: "transport_buffer",
        side: "after",
        against: after.activityId,
        needHours: need / 3_600_000,
        displaceable: state.activities.get(after.activityId)?.status === "held",
        priority: state.activities.get(after.activityId)?.priority,
        activityId: after.activityId,
      });
  }
  return { ok: conflicts.length === 0, conflicts };
}
