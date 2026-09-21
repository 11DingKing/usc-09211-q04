import {
  apply,
  calendarOf,
  checkExhibitWindow,
  checkGuideWindow,
  CommandError,
  initialState,
} from "./engine.mjs";
import { newId } from "./ids.mjs";

/**
 * 巡展路由器：命令串行执行 + 仅追加事件日志。
 * - 所有命令经单队列处理，规划与落盘之间不存在交叉读写，天然抗并发竞争。
 * - commandId 由调用方提供（稳定业务标识）；重复提交返回同一结果，绝不重复锁定。
 * - 规划在 draft 状态上完成；任一校验失败则不写任何事件（命令原子性）。
 */
export class Router {
  constructor(store, { now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
    this.state = initialState();
    this.records = []; // 与日志一致的全量记录，用于时间线投影
    this.chain = Promise.resolve();
    this.commandResults = new Map(); // commandId -> { events }
  }

  async init() {
    await this.store.replay((record) => {
      apply(this.state, record);
      this.records.push(record);
      if (record.commandId) {
        const bucket = this.commandResults.get(record.commandId) ?? { events: [] };
        bucket.events.push({ type: record.type, data: record.data });
        this.commandResults.set(record.commandId, bucket);
      }
    });
    return this;
  }

  /** 串行提交命令；同一时刻只有一个命令在规划/落盘。 */
  submit(command) {
    const run = this.chain.then(() => this.#runCommand(command));
    // 队列本身不因业务拒绝而中断
    this.chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  #runCommand(command) {
    if (!command || typeof command !== "object") {
      throw new CommandError("BAD_COMMAND", "命令必须是对象");
    }
    const commandId = command.commandId ?? newId("cmd");
    const seen = this.commandResults.get(commandId);
    if (seen) return { commandId, duplicate: true, events: seen.events };

    const draft = cloneState(this.state);
    const eventTime = command.occurredAt ?? this.now();
    const events = plan(draft, command, eventTime, this.now);
    const records = this.store.append(events, { commandId, eventTime });
    for (const record of records) {
      apply(this.state, record);
      this.records.push(record);
    }
    const result = { commandId, duplicate: false, events: events.map((e) => ({ type: e.type, data: e.data })) };
    this.commandResults.set(commandId, { events: result.events });
    return result;
  }

  // ---- 只读投影 ----

  /** 全量时间线（可按活动/时间过滤），含事件时间与接收时间，便于看清每次改派的来龙去脉。 */
  timeline({ activityId, from, to, limit = 1000 } = {}) {
    const out = [];
    for (const record of this.records) {
      if (activityId && !recordMentionsActivity(record, activityId)) continue;
      if (from && record.eventTime < from) continue;
      if (to && record.eventTime > to) continue;
      out.push(serializeRecord(record));
      if (out.length >= limit) break;
    }
    return out;
  }

  routes() {
    return [...this.state.activities.values()]
      .map((a) => this.#viewActivity(a))
      .sort((a, b) => a.start - b.start);
  }

  activityView(activityId) {
    const a = this.state.activities.get(activityId);
    if (!a) throw new CommandError("NOT_FOUND", `活动不存在：${activityId}`);
    return this.#viewActivity(a);
  }

  #viewActivity(a) {
    const venue = this.state.venues.get(a.venueId);
    const impactedSchool = a.schoolId
      ? venueInfo(this.state, a.schoolId)
      : venue?.kind === "school"
        ? venueInfo(this.state, a.venueId)
        : null;
    return {
      id: a.id,
      title: a.title,
      venueId: a.venueId,
      venueName: venue?.name,
      region: a.region,
      school: impactedSchool,
      start: a.start,
      end: a.end,
      priority: a.priority,
      status: a.status,
      needs: a.needs,
      assignments: a.assignments,
      displacedBy: a.displacedBy,
      blockReason: a.blockReason,
      blockDetails: a.blockDetails,
      releaseReason: a.releaseReason,
      approvedBy: a.approvedBy,
      approvedAt: a.approvedAt,
    };
  }

  incidentView(incidentId) {
    const inc = this.state.incidents.get(incidentId);
    if (!inc) throw new CommandError("NOT_FOUND", `事件不存在：${incidentId}`);
    return {
      ...inc,
      exhibitName: this.state.exhibits.get(inc.exhibitId)?.name,
      impact: (inc.chainResult?.affected ?? []).map((x) => ({
        ...x,
        school: x.schoolId ? venueInfo(this.state, x.schoolId) : null,
        activityTitle: this.state.activities.get(x.activityId)?.title,
      })),
    };
  }
}

function venueInfo(state, venueId) {
  const v = state.venues.get(venueId);
  return v ? { id: v.id, name: v.name, kind: v.kind, region: v.region } : { id: venueId };
}

function recordMentionsActivity(record, activityId) {
  const d = record.data;
  if (!d) return false;
  if (d.activityId === activityId) return true;
  if (d.byActivityId === activityId) return true;
  // ActivityRequested 的活动标识字段为 id
  if (record.type === "ActivityRequested" && d.id === activityId) return true;
  if (Array.isArray(d.affected)) return d.affected.some((x) => x.activityId === activityId);
  return false;
}

function serializeRecord(record) {
  return {
    seq: record.seq,
    commandId: record.commandId,
    eventTime: record.eventTime,
    receivedAt: record.receivedAt,
    type: record.type,
    data: record.data,
  };
}

function cloneState(state) {
  // 状态仅含 Map 与普通数据，结构化拷贝得到隔离 draft
  return structuredClone(state);
}

// ---------------------------------------------------------------------------
// 规划器：命令 -> 事件[]
// ---------------------------------------------------------------------------

export function plan(state, command, at, now) {
  const handler = handlers[command.type];
  if (!handler) throw new CommandError("UNKNOWN_COMMAND", `未知命令类型：${command.type}`);
  return handler(state, command, at, now);
}

const handlers = {
  RegisterVenue(state, c) {
    require(c.id, "venueId");
    if (state.venues.has(c.id)) throw new CommandError("ALREADY_EXISTS", `场馆已存在：${c.id}`);
    const timeZone = c.timeZone ?? (c.region === "HK" ? "Asia/Hong_Kong" : c.region === "MO" ? "Asia/Macau" : null);
    if (!timeZone) throw new CommandError("VALIDATION", "必须提供 timeZone 或已知 region（HK/MO）");
    // 提前构造一次以校验时区合法
    new Intl.DateTimeFormat("en-US", { timeZone });
    return [
      event("VenueRegistered", {
        id: c.id,
        name: c.name ?? c.id,
        kind: c.kind ?? "venue",
        region: requireRegion(c.region),
        timeZone,
        capabilities: c.capabilities ?? [],
        requiredCapabilities: c.requiredCapabilities ?? [],
        calendar: c.calendar ?? { holidays: [], weeklyClosed: [], openHours: [] },
      }),
    ];
  },

  UpdateVenueCalendar(state, c) {
    const venue = must(state.venues, c.venueId, "场馆");
    const calendar = normalizeCalendar(c.calendar);
    new Intl.DateTimeFormat("en-US", { timeZone: venue.timeZone });
    return [event("VenueCalendarUpdated", { venueId: venue.id, calendar })];
  },

  RegisterExhibit(state, c) {
    require(c.id, "exhibitId");
    if (state.exhibits.has(c.id)) throw new CommandError("ALREADY_EXISTS", `展具已存在：${c.id}`);
    return [
      event("ExhibitRegistered", {
        id: c.id,
        name: c.name ?? c.id,
        sequenceId: c.sequenceId ?? c.id,
        capabilities: c.capabilities ?? [],
        envRequirements: c.envRequirements ?? [],
        homeRegion: requireRegion(c.region ?? c.homeRegion),
      }),
    ];
  },

  RegisterGuide(state, c) {
    require(c.id, "guideId");
    if (state.guides.has(c.id)) throw new CommandError("ALREADY_EXISTS", `讲解员已存在：${c.id}`);
    const qualifications = c.qualifications ?? [];
    const regions = (c.regions ?? []).map(requireRegion);
    if (regions.length === 0) throw new CommandError("VALIDATION", "讲解员至少要有一个可服务地区");
    return [event("GuideRegistered", { id: c.id, name: c.name ?? c.id, qualifications, regions })];
  },

  ConfigureTravelBuffer(state, c) {
    const a = requireRegion(c.regionA);
    const b = requireRegion(c.regionB);
    const hours = Number(c.hours);
    if (!Number.isFinite(hours) || hours < 0) throw new CommandError("VALIDATION", "运输缓冲小时数非法");
    return [event("TravelBufferConfigured", { regionA: a, regionB: b, hours })];
  },

  ScheduleMaintenance(state, c) {
    must(state.exhibits, c.exhibitId, "展具");
    const { start, end } = requireWindow(c);
    return [
      event("MaintenanceScheduled", {
        id: c.id ?? newId("mnt"),
        exhibitId: c.exhibitId,
        start,
        end,
        reason: c.reason ?? "scheduled",
      }),
    ];
  },

  ScheduleGuideLeave(state, c) {
    must(state.guides, c.guideId, "讲解员");
    const { start, end } = requireWindow(c);
    return [
      event("GuideLeaveScheduled", {
        guideId: c.guideId,
        start,
        end,
        reason: c.reason ?? "leave",
      }),
    ];
  },

  RequestActivity(state, c, at) {
    const activity = buildActivity(state, c);
    if (activity.start < at - 60_000) {
      throw new CommandError("VALIDATION", "不得为过去时间创建活动");
    }
    const { picks, guideId, displaced, planLines } = allocate(state, activity);
    const events = [
      event("ActivityRequested", {
        id: activity.id,
        title: activity.title,
        venueId: activity.venueId,
        schoolId: activity.schoolId,
        region: activity.region,
        start: activity.start,
        end: activity.end,
        priority: activity.priority,
        needs: activity.needs,
        guideQualification: activity.guideQualification,
        multiDay: activity.multiDay,
      }),
    ];
    // 先占位新活动，再统一释放所有被挤落者，最后逐户重规划：
    // 重规划时新活动的资源是硬冲突，被挤落者之间的旧承诺均已释放，避免顺序依赖。
    events.push(
      event("AllocationHeld", {
        activityId: activity.id,
        exhibitIds: picks.map((p) => p.exhibitId),
        guideId,
        plan: planLines,
        displaced: displaced.map((d) => d.id),
      }),
    );
    apply(state, synth(events[0]));
    apply(state, synth(events[1]));

    for (const victim of displaced) {
      const evt = event("AllocationDisplaced", { activityId: victim.id, byActivityId: activity.id });
      events.push(evt);
      apply(state, synth(evt));
    }
    for (const victim of displaced) {
      const replanned = tryReplan(state, victim);
      if (replanned) {
        events.push(
          event("AllocationReplanned", {
            activityId: victim.id,
            exhibitIds: replanned.picks.map((p) => p.exhibitId),
            guideId: replanned.guideId,
            plan: replanned.planLines,
            reason: `displaced_by:${activity.id}`,
          }),
        );
        apply(state, synth(events[events.length - 1]));
      } else {
        events.push(
          event("AllocationBlocked", {
            activityId: victim.id,
            reason: { code: "DISPLACED_NO_ALTERNATIVE", byActivityId: activity.id },
            details: { note: "无可用替代展具或讲解员，且不允许静默改期" },
          }),
        );
        apply(state, synth(events[events.length - 1]));
      }
    }
    return events;
  },

  ApproveAllocation(state, c, at) {
    const a = must(state.activities, c.activityId, "活动");
    if (a.status !== "held") {
      throw new CommandError("INVALID_STATE", `仅已占位（held）活动可批准，当前状态：${a.status}`);
    }
    return [
      event("AllocationApproved", {
        activityId: a.id,
        at: c.at ?? at,
        actor: c.actor ?? "unknown",
      }),
    ];
  },

  ReleaseAllocation(state, c) {
    const a = must(state.activities, c.activityId, "活动");
    if (a.status === "released") throw new CommandError("INVALID_STATE", "活动已释放");
    return [
      event("AllocationReleased", {
        activityId: a.id,
        reason: c.reason ?? "manual_release",
        actor: c.actor ?? "unknown",
      }),
    ];
  },

  RepairExhibit(state, c, at) {
    const ex = must(state.exhibits, c.exhibitId, "展具");
    if (!ex.damaged) throw new CommandError("INVALID_STATE", "展具当前未处于损坏状态");
    return [
      event("ExhibitRepaired", {
        exhibitId: ex.id,
        at: c.at ?? at,
        actor: c.actor ?? "unknown",
      }),
    ];
  },

  ReportDamage(state, c, at) {
    const ex = must(state.exhibits, c.exhibitId, "展具");
    if (ex.damaged) throw new CommandError("INVALID_STATE", `展具已有未结案事件：${ex.damaged.incidentId}`);
    const damageAt = Number(c.at ?? at);
    const incidentId = c.incidentId ?? newId("inc");
    const events = [
      event("DamageReported", {
        incidentId,
        exhibitId: ex.id,
        at: damageAt,
        reason: c.reason ?? "unspecified",
        causeCategory: c.causeCategory ?? "unknown",
        location: c.location ?? null,
        reporter: c.reporter ?? "unknown",
        responsibility: c.responsibility ?? null, // 责任边界，例如 { owner: "logistics", note }
      }),
    ];
    apply(state, synth(events[0]));

    // 受影响活动：所有在 damaged 展具上、窗口延伸到 damageAt 之后的承诺分段
    const segments = (state.exhibitCommitments.get(ex.id) ?? []).filter((s) => s.end > damageAt);
    const activityIds = [...new Set(segments.map((s) => s.activityId))];
    const affectedActivities = activityIds
      .map((id) => state.activities.get(id))
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);

    const affected = [];
    for (const activity of affectedActivities) {
      const line = (activity.assignments?.plan ?? []).find((p) => p.exhibitId === ex.id);
      const capability = line?.capability ?? null;
      const winStart = Math.max(activity.start, damageAt);
      const winEnd = activity.end;
      const substitute = findSubstitute(state, {
        activity,
        capability,
        damagedExhibitId: ex.id,
        start: winStart,
        end: winEnd,
      });
      const schoolId = activity.schoolId ?? (state.venues.get(activity.venueId)?.kind === "school" ? activity.venueId : null);
      if (substitute) {
        const evt = event("ExhibitReassigned", {
          incidentId,
          activityId: activity.id,
          schoolId,
          fromExhibitId: ex.id,
          toExhibitId: substitute,
          capability,
          // 旧承诺分段（整段或活动开始以来的整窗）
          oldStart: activity.start,
          oldEnd: activity.end,
          // 新展具承担的窗口（途中损坏时仅承担剩余时段）
          newStart: winStart,
          newEnd: winEnd,
          partial: activity.start < damageAt,
          reason: `damage:${c.reason ?? "unspecified"}`,
          plan: [
            ...(activity.assignments?.plan ?? []).filter((p) => p.exhibitId !== ex.id),
            { needIndex: line?.needIndex ?? null, capability, exhibitId: substitute, reassignedFrom: ex.id },
          ],
        });
        events.push(evt);
        apply(state, synth(evt));
        affected.push({
          activityId: activity.id,
          schoolId,
          result: "reassigned",
          fromExhibitId: ex.id,
          toExhibitId: substitute,
          window: { start: winStart, end: winEnd },
        });
      } else {
        const evt = event("SubstitutionFailed", {
          incidentId,
          activityId: activity.id,
          schoolId,
          fromExhibitId: ex.id,
          capability,
          at: damageAt,
          reason: { code: "DAMAGE_NO_SUBSTITUTE", damagedExhibitId: ex.id },
        });
        events.push(evt);
        apply(state, synth(evt));
        affected.push({
          activityId: activity.id,
          schoolId,
          result: "blocked",
          fromExhibitId: ex.id,
          window: { start: winStart, end: winEnd },
        });
      }
    }

    events.push(
      event("SubstitutionChainFinished", {
        incidentId,
        at,
        blocked: affected.filter((x) => x.result === "blocked"),
        affected,
      }),
    );
    apply(state, synth(events[events.length - 1]));
    return events;
  },
};

// ---------------------------------------------------------------------------
// 分配规划
// ---------------------------------------------------------------------------

function buildActivity(state, c) {
  require(c.id, "activityId");
  if (state.activities.has(c.id)) throw new CommandError("ALREADY_EXISTS", `活动已存在：${c.id}`);
  const venue = must(state.venues, c.venueId, "场馆");
  const { start, end } = requireWindow(c);
  if (end <= start) throw new CommandError("VALIDATION", "活动结束时间必须晚于开始时间");
  const multiDay = Boolean(c.multiDay);
  const problems = calendarOf(venue).checkWindow(start, end, { multiDay });
  if (problems.length) {
    throw new CommandError("VENUE_CALENDAR_CLOSED", `场馆日历不允许该时段：${problems.join(", ")}`, {
      venueTimeZone: venue.timeZone,
      problems,
    });
  }
  const needs = normalizeNeeds(c.needs);
  if (needs.length === 0) throw new CommandError("VALIDATION", "活动至少声明一项展具需求");
  return {
    id: c.id,
    title: c.title ?? c.id,
    venueId: venue.id,
    schoolId: c.schoolId ?? null,
    region: venue.region,
    start,
    end,
    priority: Number.isFinite(Number(c.priority)) ? Number(c.priority) : 100,
    needs,
    guideQualification: c.guideQualification ?? null,
    multiDay,
  };
}

function normalizeNeeds(needs) {
  if (!Array.isArray(needs) || needs.length === 0) return [];
  return needs.map((n, i) => {
    if (typeof n === "string") return { needIndex: i, capability: n, quantity: 1 };
    return {
      needIndex: i,
      capability: require(n.capability, "needs[].capability"),
      quantity: Math.max(1, Number(n.quantity) || 1),
    };
  });
}

/**
 * 为活动尝试整体分配。返回 { picks, guideId, displaced, planLines }；
 * 无法分配时抛出 ALLOCATION_FAILED（带每项需求/讲解员的具体冲突）。
 * 允许在 priority 严格高于被占方、且被占方仅为 held 时挤落；approved 承诺不可挤。
 */
function allocate(state, activity) {
  const venue = must(state.venues, activity.venueId, "场馆");
  const picked = new Set();
  const picks = [];
  const displaced = new Map();
  const failures = [];

  const considerConflict = (conflicts) => {
    for (const cf of conflicts) {
      const id = cf.activityId;
      if (id && displaced.has(id)) continue; // 已在本命令中被判为可挤落
      // 优先级数值越小越高；仅 held 且严格更低优先级（数值更大）者可被挤落
      if (!cf.displaceable || cf.priority == null || cf.priority <= activity.priority) {
        return false;
      }
      const victim = state.activities.get(id);
      if (!victim || victim.status !== "held") return false;
      displaced.set(id, victim);
    }
    return true;
  };

  for (const need of activity.needs) {
    for (let q = 0; q < need.quantity; q++) {
      const candidates = candidateExhibits(state, need.capability, venue, activity.region);
      let chosen = null;
      const attemptLog = [];
      for (const ex of candidates) {
        if (picked.has(ex.id)) continue;
        const check = checkExhibitWindow(state, ex.id, activity.start, activity.end, activity.region, activity.id);
        if (check.ok) {
          chosen = ex;
          break;
        }
        const blocking = check.conflicts.filter((cf) => !(cf.activityId && displaced.has(cf.activityId)));
        if (blocking.length === 0) {
          chosen = ex; // 剩余冲突全部来自即将被挤落者
          break;
        }
        if (blocking.every((cf) => cf.displaceable && cf.priority != null && cf.priority > activity.priority)) {
          considerConflict(blocking);
          chosen = ex;
          break;
        }
        attemptLog.push({ exhibitId: ex.id, conflicts: blocking.map(shortConflict) });
      }
      if (!chosen) {
        failures.push({ need: { needIndex: need.needIndex, capability: need.capability, q }, attempts: attemptLog });
        continue;
      }
      picked.add(chosen.id);
      picks.push({ needIndex: need.needIndex, capability: need.capability, exhibitId: chosen.id });
    }
  }

  let guideId = null;
  if (activity.guideQualification) {
    const guideCandidates = candidateGuides(state, activity.guideQualification, activity.region);
    const guideAttempts = [];
    for (const g of guideCandidates) {
      const check = checkGuideWindow(state, g.id, activity.start, activity.end, activity.region, activity.id);
      const blocking = check.conflicts.filter((cf) => !(cf.activityId && displaced.has(cf.activityId)));
      if (blocking.length === 0) {
        guideId = g.id;
        break;
      }
      if (blocking.every((cf) => cf.displaceable && cf.priority != null && cf.priority > activity.priority)) {
        considerConflict(blocking);
        guideId = g.id;
        break;
      }
      guideAttempts.push({ guideId: g.id, conflicts: blocking.map(shortConflict) });
    }
    if (!guideId) {
      failures.push({ need: { guide: activity.guideQualification }, attempts: guideAttempts });
    }
  }

  if (failures.length) {
    throw new CommandError("ALLOCATION_FAILED", "无可行的展具/讲解员组合", { failures });
  }

  const planLines = picks.map((p) => ({ needIndex: p.needIndex, capability: p.capability, exhibitId: p.exhibitId }));
  if (guideId) planLines.push({ guideId });
  return { picks, guideId, displaced: [...displaced.values()], planLines };
}

/** 被挤落后的重规划：同一时间窗（绝不静默改期），只找当前空闲资源，不再挤落任何人。 */
function tryReplan(state, activity) {
  const venue = must(state.venues, activity.venueId, "场馆");
  const picked = new Set();
  const picks = [];
  for (const need of activity.needs) {
    for (let q = 0; q < need.quantity; q++) {
      const candidates = candidateExhibits(state, need.capability, venue, activity.region);
      const ex = candidates.find((candidate) => {
        if (picked.has(candidate.id)) return false;
        const check = checkExhibitWindow(
          state,
          candidate.id,
          activity.start,
          activity.end,
          activity.region,
          activity.id,
        );
        return check.ok;
      });
      if (!ex) return false;
      picked.add(ex.id);
      picks.push({ needIndex: need.needIndex, capability: need.capability, exhibitId: ex.id });
    }
  }
  let guideId = null;
  if (activity.guideQualification) {
    const g = candidateGuides(state, activity.guideQualification, activity.region).find((candidate) => {
      const check = checkGuideWindow(
        state,
        candidate.id,
        activity.start,
        activity.end,
        activity.region,
        activity.id,
      );
      return check.ok;
    });
    if (!g) return false;
    guideId = g.id;
  }
  const planLines = picks.map((p) => ({ needIndex: p.needIndex, capability: p.capability, exhibitId: p.exhibitId }));
  if (guideId) planLines.push({ guideId });
  return { picks, guideId, planLines };
}

/** 损坏替代：同能力、符合同一场馆条件，在受影响窗口内零冲突，且不动任何既有承诺。 */
function findSubstitute(state, { activity, capability, damagedExhibitId, start, end }) {
  const venue = must(state.venues, activity.venueId, "场馆");
  const candidates = candidateExhibits(state, capability, venue, activity.region);
  for (const ex of candidates) {
    if (ex.id === damagedExhibitId) continue;
    const check = checkExhibitWindow(state, ex.id, start, end, activity.region, activity.id);
    if (check.ok) return ex.id;
  }
  return null;
}

function candidateExhibits(state, capability, venue, region) {
  return [...state.exhibits.values()]
    .filter((ex) => ex.capabilities.includes(capability))
    .filter((ex) => ex.envRequirements.every((req) => venue.capabilities.includes(req)))
    .filter((ex) => venue.requiredCapabilities.every((req) => ex.capabilities.includes(req)))
    .filter((ex) => !ex.damaged)
    .sort((a, b) => {
      const aHome = a.homeRegion === region ? 0 : 1;
      const bHome = b.homeRegion === region ? 0 : 1;
      return aHome - bHome || a.id.localeCompare(b.id);
    });
}

function candidateGuides(state, qualification, region) {
  // 不按地区预过滤：让地区不符的讲解员也进入评估，失败原因可明确呈现为 region_not_qualified
  return [...state.guides.values()]
    .filter((g) => g.qualifications.includes(qualification))
    .sort((a, b) => {
      const aRegion = a.regions.includes(region) ? 0 : 1;
      const bRegion = b.regions.includes(region) ? 0 : 1;
      return aRegion - bRegion || a.id.localeCompare(b.id);
    });
}

function shortConflict(cf) {
  if (cf.kind === "commitment")
    return { kind: cf.kind, activityId: cf.activityId, displaceable: cf.displaceable, priority: cf.priority };
  if (cf.kind === "transport_buffer")
    return { kind: cf.kind, against: cf.against, needHours: cf.needHours, displaceable: cf.displaceable };
  if (cf.kind === "maintenance") return { kind: cf.kind, window: cf.window };
  return { kind: cf.kind };
}

// ---------------------------------------------------------------------------

function event(type, data) {
  return { type, data };
}
function synth(evt) {
  return { type: evt.type, data: evt.data };
}
function require(v, label) {
  if (v == null || v === "") throw new CommandError("VALIDATION", `缺少必填字段：${label}`);
  return v;
}
function requireRegion(r) {
  if (r !== "HK" && r !== "MO") throw new CommandError("VALIDATION", `region 仅支持 HK / MO，收到：${r}`);
  return r;
}
function must(map, id, label) {
  const v = map.get(id);
  if (!v) throw new CommandError("NOT_FOUND", `${label}不存在：${id}`);
  return v;
}
function requireWindow(c) {
  const start = Number(c.start);
  const end = Number(c.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new CommandError("VALIDATION", "时间窗非法：需要数值型 start/end 且 end > start");
  }
  return { start, end };
}
function normalizeCalendar(cal) {
  return {
    holidays: cal?.holidays ?? [],
    weeklyClosed: cal?.weeklyClosed ?? [],
    openHours: cal?.openHours ?? [],
  };
}
