import { randomUUID } from "node:crypto";
import { EventLog } from "./store/eventLog.mjs";
import { initialState, applyEvent } from "./domain/events.mjs";
import { fail } from "./domain/errors.mjs";
import { localDate, assertNoHoliday } from "./domain/time.mjs";
import {
  validateLegs,
  routeResources,
  findLockConflicts,
  windowsOverlap,
  venueAccepts,
  assertEventsNotAssigned,
} from "./domain/scheduler.mjs";

const DEFAULT_CONFIG = {
  transportBufferHours: 12,
  setupHours: 4,
  lockTtlMs: 7 * 24 * 3600 * 1000,
  lockMarginMs: 24 * 3600 * 1000,
};

const RESPONSIBILITIES = ["carrier", "venue", "operations", "unknown"];

const nowIso = () => new Date().toISOString();

export class App {
  #state;
  #log;
  #events;
  #config;

  constructor(state, log, events, config) {
    this.#state = state;
    this.#log = log;
    this.#events = events;
    this.#config = config;
  }

  /** 打开应用：重放追加式事件日志恢复全部状态（含幂等记录）。 */
  static open(dir = null, config = {}) {
    const log = EventLog.open(dir);
    const events = log.readAll();
    const state = initialState();
    for (const event of events) {
      applyEvent(state, event);
      state.seq = event.seq;
    }
    return new App(state, log, events, { ...DEFAULT_CONFIG, ...config });
  }

  // ---------- 内部机制 ----------

  #commit(entries, commandId) {
    const recordedAt = nowIso();
    const events = entries.map((entry, index) => ({
      seq: this.#state.seq + index + 1,
      eventId: randomUUID(),
      commandId,
      recordedAt,
      ...entry,
    }));
    this.#log.appendAll(events);
    for (const event of events) {
      applyEvent(this.#state, event);
      this.#state.seq = event.seq;
    }
    this.#events.push(...events);
    return events;
  }

  /**
   * 命令入口：强制幂等键。同一键重复提交直接返回首个响应，
   * 不会重复追加事件，以此抵抗重复请求。
   */
  #run(idempotencyKey, produce) {
    if (!idempotencyKey) fail("IDEMPOTENCY_REQUIRED", "变更请求必须携带幂等键（Idempotency-Key）");
    const seen = this.#state.idempotency[idempotencyKey];
    if (seen) return { ...structuredClone(seen.response), replay: true };
    const { entries, response } = produce();
    entries.push({
      type: "CommandRecorded",
      occurredAt: nowIso(),
      entities: [],
      payload: { key: idempotencyKey, response },
    });
    this.#commit(entries, idempotencyKey);
    return { ...response, replay: false };
  }

  #mustRoute(routeId) {
    const route = this.#state.routes[routeId];
    if (!route) fail("NOT_FOUND", `路线不存在: ${routeId}`);
    return route;
  }

  #nextFencing(resourceId) {
    return (this.#state.lockHistory[resourceId]?.lastFencing ?? 0) + 1;
  }

  #lockExpiry(windowEndAt) {
    return new Date(
      Math.max(Date.parse(windowEndAt), Date.now()) + this.#config.lockMarginMs,
    ).toISOString();
  }

  // ---------- 资源登记 ----------

  registerVenue(cmd, idempotencyKey) {
    return this.#run(idempotencyKey, () => {
      const { venueId, name, timeZone, conditions = {}, holidays = [] } = cmd ?? {};
      if (!venueId || !name) fail("VALIDATION", "场馆需要 venueId 与 name");
      localDate(nowIso(), timeZone); // 校验时区合法性
      if (this.#state.venues[venueId]) fail("CONFLICT", `场馆已存在: ${venueId}`);
      const payload = { venueId, name, timeZone, conditions, holidays: [...new Set(holidays)].sort() };
      return {
        entries: [{ type: "VenueRegistered", occurredAt: nowIso(), entities: [venueId], payload }],
        response: { venue: payload },
      };
    });
  }

  registerExhibit(cmd, idempotencyKey) {
    return this.#run(idempotencyKey, () => {
      const {
        exhibitId, name, kitId = null, sequenceNo = null,
        capabilities = [], requiresConditions = [], weightKg = null, homeVenueId,
      } = cmd ?? {};
      if (!exhibitId || !name) fail("VALIDATION", "展具需要 exhibitId 与 name");
      if (!this.#state.venues[homeVenueId]) fail("NOT_FOUND", `所属场馆不存在: ${homeVenueId}`);
      if (this.#state.exhibits[exhibitId]) fail("CONFLICT", `展具已存在: ${exhibitId}`);
      const payload = { exhibitId, name, kitId, sequenceNo, capabilities, requiresConditions, weightKg, homeVenueId };
      return {
        entries: [{ type: "ExhibitRegistered", occurredAt: nowIso(), entities: [exhibitId, homeVenueId], payload }],
        response: { exhibit: payload },
      };
    });
  }

  registerDocent(cmd, idempotencyKey) {
    return this.#run(idempotencyKey, () => {
      const { docentId, name, qualifications = [], baseVenueId = null } = cmd ?? {};
      if (!docentId || !name) fail("VALIDATION", "讲解员需要 docentId 与 name");
      if (baseVenueId && !this.#state.venues[baseVenueId]) fail("NOT_FOUND", `所属场馆不存在: ${baseVenueId}`);
      if (this.#state.docents[docentId]) fail("CONFLICT", `讲解员已存在: ${docentId}`);
      const payload = { docentId, name, qualifications, baseVenueId };
      return {
        entries: [{ type: "DocentRegistered", occurredAt: nowIso(), entities: [docentId], payload }],
        response: { docent: payload },
      };
    });
  }

  requestEvent(cmd, idempotencyKey) {
    return this.#run(idempotencyKey, () => {
      const {
        eventId, schoolId, venueId, startAt, endAt,
        requiredExhibitIds = [], requiredQualifications = [], priority = 0,
      } = cmd ?? {};
      if (!eventId || !schoolId) fail("VALIDATION", "活动需要 eventId 与 schoolId");
      const venue = this.#state.venues[venueId];
      if (!venue) fail("NOT_FOUND", `场馆不存在: ${venueId}`);
      if (this.#state.eventRequests[eventId]) fail("CONFLICT", `活动已存在: ${eventId}`);
      for (const exhibitId of requiredExhibitIds) {
        if (!this.#state.exhibits[exhibitId]) fail("NOT_FOUND", `展具不存在: ${exhibitId}`);
      }
      assertNoHoliday(venue, startAt, endAt);
      const payload = { eventId, schoolId, venueId, startAt, endAt, requiredExhibitIds, requiredQualifications, priority };
      return {
        entries: [{
          type: "EventRequested",
          occurredAt: nowIso(),
          entities: [eventId, venueId, `school:${schoolId}`, ...requiredExhibitIds],
          payload,
        }],
        response: { eventRequest: payload },
      };
    });
  }

  scheduleMaintenance(cmd, idempotencyKey) {
    return this.#run(idempotencyKey, () => {
      const { exhibitId, startAt, endAt, reason = null } = cmd ?? {};
      const exhibit = this.#state.exhibits[exhibitId];
      if (!exhibit) fail("NOT_FOUND", `展具不存在: ${exhibitId}`);
      if (!(new Date(endAt) > new Date(startAt))) fail("VALIDATION", "维护窗口结束必须晚于开始");
      const lock = this.#state.locks[exhibitId];
      if (lock && windowsOverlap(lock.window, { startAt, endAt })) {
        fail("CONFLICT", `展具 ${exhibitId} 在维护窗口内已被 ${lock.holderId} 锁定`, {
          holderId: lock.holderId,
        });
      }
      const payload = { exhibitId, startAt, endAt, reason };
      return {
        entries: [{ type: "ExhibitMaintenanceScheduled", occurredAt: nowIso(), entities: [exhibitId], payload }],
        response: { exhibitId, maintenanceWindow: { startAt, endAt } },
      };
    });
  }

  // ---------- 路线计划与批准 ----------

  planRoute(cmd, idempotencyKey) {
    return this.#run(idempotencyKey, () => {
      const { routeId, priority = 0, transportBufferHours, legs } = cmd ?? {};
      if (!routeId) fail("VALIDATION", "路线需要 routeId");
      if (this.#state.routes[routeId]) fail("CONFLICT", `路线已存在: ${routeId}`);
      const plan = { routeId, legs, transportBufferHours };
      validateLegs(this.#state, plan, this.#config);
      assertEventsNotAssigned(this.#state, routeId, legs);
      const { exhibitIds, docentIds, window } = routeResources(this.#state, { legs });
      const lockConflicts = findLockConflicts(
        this.#state, [...exhibitIds, ...docentIds], window, nowIso(),
      ).map((l) => ({ resourceId: l.resourceId, holderId: l.holderId, fencing: l.fencing }));
      const payload = {
        routeId,
        priority,
        transportBufferHours: transportBufferHours ?? this.#config.transportBufferHours,
        legs: structuredClone(legs),
      };
      const entities = [routeId, ...exhibitIds, ...docentIds];
      for (const leg of legs) {
        entities.push(leg.fromVenueId, leg.toVenueId);
        if (leg.eventId) entities.push(leg.eventId);
      }
      return {
        entries: [{ type: "RoutePlanned", occurredAt: nowIso(), entities: [...new Set(entities)], payload }],
        response: { routeId, status: "PLANNED", window, warnings: { lockConflicts } },
      };
    });
  }

  /**
   * 批准路线：原子锁定全部展具与讲解员。
   * 任一资源冲突则整体失败；更高优先级可抢占尚未出发的已批准路线，
   * 抢占会留下 LockPreempted / RoutePreempted 审计记录。
   */
  approveRoute(routeId, cmd, idempotencyKey) {
    return this.#run(idempotencyKey, () => {
      const route = this.#mustRoute(routeId);
      if (route.status !== "PLANNED") fail("CONFLICT", `路线状态为 ${route.status}，不可批准`);
      if (cmd?.expectedVersion != null && cmd.expectedVersion !== route.version) {
        fail("CONFLICT", `路线版本冲突: 期望 ${cmd.expectedVersion}，当前 ${route.version}`, {
          currentVersion: route.version,
        });
      }
      validateLegs(this.#state, route, this.#config);
      assertEventsNotAssigned(this.#state, routeId, route.legs);
      const { exhibitIds, docentIds, window } = routeResources(this.#state, route);
      const resources = [...exhibitIds, ...docentIds];
      const occurredAt = cmd?.occurredAt ?? nowIso();

      const entries = [];
      const expired = new Set();
      for (const resourceId of resources) {
        const lock = this.#state.locks[resourceId];
        if (lock && new Date(lock.expiresAt) <= new Date(occurredAt)) {
          expired.add(resourceId);
          entries.push({
            type: "LockExpired",
            occurredAt,
            entities: [resourceId, lock.holderId],
            payload: { resourceId, token: lock.token, holderId: lock.holderId, reason: "锁已过期" },
          });
        }
      }
      const effectiveLock = (resourceId) =>
        expired.has(resourceId) ? null : (this.#state.locks[resourceId] ?? null);

      const preemptedRoutes = new Map();
      for (const resourceId of resources) {
        const lock = effectiveLock(resourceId);
        if (!lock || lock.holderId === routeId) continue;
        if (!windowsOverlap(lock.window, window)) continue;
        const holderRoute = lock.holderRouteId ? this.#state.routes[lock.holderRouteId] : null;
        const canPreempt =
          holderRoute && holderRoute.status === "APPROVED" && holderRoute.priority < route.priority;
        if (!canPreempt) {
          fail("CONFLICT", `资源 ${resourceId} 已被 ${lock.holderId} 锁定`, {
            resourceId,
            holderId: lock.holderId,
            fencing: lock.fencing,
          });
        }
        preemptedRoutes.set(holderRoute.routeId, holderRoute);
      }

      for (const holderRoute of preemptedRoutes.values()) {
        for (const lock of Object.values(this.#state.locks)) {
          if (lock.holderId !== holderRoute.routeId || expired.has(lock.resourceId)) continue;
          entries.push({
            type: "LockPreempted",
            occurredAt,
            entities: [lock.resourceId, holderRoute.routeId, routeId],
            payload: {
              resourceId: lock.resourceId,
              token: lock.token,
              holderId: lock.holderId,
              preemptedBy: routeId,
              reason: `被更高优先级路线 ${routeId}（优先级 ${route.priority}）抢占`,
              responsibility: "operations",
            },
          });
        }
        entries.push({
          type: "RoutePreempted",
          occurredAt,
          entities: [holderRoute.routeId, routeId],
          payload: {
            routeId: holderRoute.routeId,
            preemptedBy: routeId,
            reason: `路线 ${routeId}（优先级 ${route.priority}）高于本路线（优先级 ${holderRoute.priority}）`,
            responsibility: "operations",
          },
        });
      }

      const locks = [];
      for (const resourceId of resources) {
        const existing = effectiveLock(resourceId);
        if (existing && existing.holderId === routeId) continue;
        const token = randomUUID();
        const fencing = this.#nextFencing(resourceId);
        const expiresAt = this.#lockExpiry(window.endAt);
        entries.push({
          type: "LockAcquired",
          occurredAt,
          entities: [resourceId, routeId],
          payload: {
            resourceId,
            holderId: routeId,
            holderRouteId: routeId,
            token,
            fencing,
            idempotencyKey: `${idempotencyKey}:${resourceId}`,
            purpose: "route",
            window,
            acquiredAt: occurredAt,
            expiresAt,
          },
        });
        locks.push({ resourceId, token, fencing });
      }
      entries.push({
        type: "RouteApproved",
        occurredAt,
        entities: [routeId, ...resources],
        payload: { routeId, window },
      });
      return {
        entries,
        response: {
          routeId,
          status: "APPROVED",
          version: route.version + 1,
          locks,
          preemptedRouteIds: [...preemptedRoutes.keys()],
        },
      };
    });
  }

  startLeg(routeId, legIndex, cmd, idempotencyKey) {
    return this.#run(idempotencyKey, () => {
      const route = this.#mustRoute(routeId);
      if (!["APPROVED", "IN_PROGRESS"].includes(route.status)) {
        fail("CONFLICT", `路线状态为 ${route.status}，不可出发`);
      }
      const leg = route.legs[legIndex];
      if (!leg) fail("NOT_FOUND", `航段不存在: ${legIndex}`);
      if (leg.status !== "planned") fail("CONFLICT", `航段 ${legIndex} 状态为 ${leg.status}`);
      for (let i = 0; i < legIndex; i++) {
        if (route.legs[i].status !== "completed") {
          fail("CONFLICT", `航段 ${i} 尚未完成，不能按顺序跳过`);
        }
      }
      const occurredAt = cmd?.occurredAt ?? nowIso();
      return {
        entries: [{
          type: "RouteLegStarted",
          occurredAt,
          entities: [routeId, ...leg.exhibitIds, ...(leg.docentIds ?? [])],
          payload: { routeId, legIndex },
        }],
        response: { routeId, legIndex, status: "in_transit" },
      };
    });
  }

  completeLeg(routeId, legIndex, cmd, idempotencyKey) {
    return this.#run(idempotencyKey, () => {
      const route = this.#mustRoute(routeId);
      const leg = route.legs[legIndex];
      if (!leg) fail("NOT_FOUND", `航段不存在: ${legIndex}`);
      if (leg.status !== "in_transit") fail("CONFLICT", `航段 ${legIndex} 状态为 ${leg.status}，不可完成`);
      const occurredAt = cmd?.occurredAt ?? nowIso();
      const entries = [{
        type: "RouteLegCompleted",
        occurredAt,
        entities: [routeId, leg.toVenueId, ...leg.exhibitIds],
        payload: { routeId, legIndex },
      }];
      if (leg.eventId) {
        entries.push({
          type: "EventFulfilled",
          occurredAt,
          entities: [leg.eventId, routeId, `school:${this.#state.eventRequests[leg.eventId].schoolId}`],
          payload: { eventId: leg.eventId, routeId },
        });
      }
      const isLast = route.legs.every((l, i) => i === legIndex || l.status === "completed");
      if (isLast) {
        entries.push({
          type: "RouteCompleted",
          occurredAt,
          entities: [routeId],
          payload: { routeId },
        });
        for (const lock of Object.values(this.#state.locks)) {
          if (lock.holderId !== routeId) continue;
          entries.push({
            type: "LockReleased",
            occurredAt,
            entities: [lock.resourceId, routeId],
            payload: {
              resourceId: lock.resourceId,
              token: lock.token,
              holderId: routeId,
              reason: "路线完成，释放资源",
            },
          });
        }
      }
      return { entries, response: { routeId, legIndex, status: "completed", routeCompleted: isLast } };
    });
  }

  cancelRoute(routeId, cmd, idempotencyKey) {
    return this.#run(idempotencyKey, () => {
      const route = this.#mustRoute(routeId);
      if (!["PLANNED", "APPROVED"].includes(route.status)) {
        fail("CONFLICT", `路线状态为 ${route.status}，不可取消（执行中路线请走事故流程）`);
      }
      const occurredAt = nowIso();
      const reason = cmd?.reason ?? "未说明";
      const entries = [];
      for (const lock of Object.values(this.#state.locks)) {
        if (lock.holderId !== routeId) continue;
        entries.push({
          type: "LockReleased",
          occurredAt,
          entities: [lock.resourceId, routeId],
          payload: { resourceId: lock.resourceId, token: lock.token, holderId: routeId, reason: `路线取消: ${reason}` },
        });
      }
      entries.push({
        type: "RouteCancelled",
        occurredAt,
        entities: [routeId],
        payload: { routeId, reason },
      });
      return { entries, response: { routeId, status: "CANCELLED" } };
    });
  }

  // ---------- 独立锁（运营手工协调） ----------

  acquireLock(cmd, idempotencyKey) {
    return this.#run(idempotencyKey, () => {
      const { resourceId, holderId, window, ttlMs } = cmd ?? {};
      if (!resourceId || !holderId) fail("VALIDATION", "锁定需要 resourceId 与 holderId");
      if (!window || !(new Date(window.endAt) > new Date(window.startAt))) {
        fail("VALIDATION", "锁定需要有效的占用窗口 window{startAt,endAt}");
      }
      const occurredAt = nowIso();
      const entries = [];
      const existing = this.#state.locks[resourceId];
      if (existing && new Date(existing.expiresAt) <= new Date(occurredAt)) {
        entries.push({
          type: "LockExpired",
          occurredAt,
          entities: [resourceId, existing.holderId],
          payload: { resourceId, token: existing.token, holderId: existing.holderId, reason: "锁已过期" },
        });
      } else if (existing) {
        fail("CONFLICT", `资源 ${resourceId} 已被 ${existing.holderId} 锁定`, {
          resourceId,
          holderId: existing.holderId,
          fencing: existing.fencing,
        });
      }
      const token = randomUUID();
      const fencing = this.#nextFencing(resourceId);
      const expiresAt = new Date(Date.now() + (ttlMs ?? this.#config.lockTtlMs)).toISOString();
      entries.push({
        type: "LockAcquired",
        occurredAt,
        entities: [resourceId, holderId],
        payload: {
          resourceId, holderId, holderRouteId: null, token, fencing,
          idempotencyKey, purpose: "manual", window, acquiredAt: occurredAt, expiresAt,
        },
      });
      return { entries, response: { resourceId, holderId, token, fencing, expiresAt } };
    });
  }

  releaseLock(cmd, idempotencyKey) {
    return this.#run(idempotencyKey, () => {
      const { resourceId, token, reason = "主动释放" } = cmd ?? {};
      const lock = this.#state.locks[resourceId];
      if (!lock) {
        if (this.#state.lockHistory[resourceId]?.lastReleasedToken === token) {
          return { entries: [], response: { resourceId, released: false, alreadyReleased: true } };
        }
        fail("NOT_FOUND", `资源 ${resourceId} 没有持有中的锁`);
      }
      if (lock.token !== token) {
        fail("CONFLICT", "锁令牌不匹配", { resourceId, fencing: lock.fencing });
      }
      return {
        entries: [{
          type: "LockReleased",
          occurredAt: nowIso(),
          entities: [resourceId, lock.holderId],
          payload: { resourceId, token, holderId: lock.holderId, reason },
        }],
        response: { resourceId, released: true },
      };
    });
  }

  // ---------- 事故与替代方案 ----------

  /**
   * 上报途中损坏：标记展具停用、释放其锁，并为受影响活动
   * 生成可追溯的替代方案（替换展具或显式改期），绝不静默改期。
   */
  reportIncident(cmd, idempotencyKey) {
    return this.#run(idempotencyKey, () => {
      const {
        incidentId = `inc-${randomUUID()}`,
        routeId, legIndex, exhibitId,
        occurredAt = nowIso(),
        responsibility = "unknown",
        description = "",
      } = cmd ?? {};
      if (!RESPONSIBILITIES.includes(responsibility)) {
        fail("VALIDATION", `责任方必须是 ${RESPONSIBILITIES.join("/")} 之一`);
      }
      const route = this.#mustRoute(routeId);
      if (!["APPROVED", "IN_PROGRESS"].includes(route.status)) {
        fail("CONFLICT", `路线状态为 ${route.status}，不可上报途中事故`);
      }
      const leg = route.legs[legIndex];
      if (!leg) fail("NOT_FOUND", `航段不存在: ${legIndex}`);
      if (!leg.exhibitIds.includes(exhibitId)) {
        fail("VALIDATION", `展具 ${exhibitId} 不在路线 ${routeId} 的航段 ${legIndex} 上`);
      }
      const exhibit = this.#state.exhibits[exhibitId];
      if (exhibit.status === "damaged") fail("CONFLICT", `展具 ${exhibitId} 已处于损坏状态`);

      // 在途航段无法更改装载，替换从下一航段开始；未出发航段当场替换。
      const replaceFrom = leg.status === "in_transit" ? legIndex + 1 : legIndex;
      const transportLegs = route.legs
        .map((l, i) => ({ leg: l, index: i }))
        .filter(({ leg: l, index }) => index >= replaceFrom && l.status !== "completed" && l.exhibitIds.includes(exhibitId));
      const eventLegs = route.legs
        .map((l, i) => ({ leg: l, index: i }))
        .filter(({ leg: l, index }) => index >= legIndex && l.status !== "completed" && l.exhibitIds.includes(exhibitId) && l.eventId);
      const affectedEventIds = [...new Set(eventLegs.map(({ leg: l }) => l.eventId))];
      const affectedSchoolIds = [...new Set(affectedEventIds.map((id) => this.#state.eventRequests[id].schoolId))];
      const joinVenueId = leg.status === "in_transit" ? leg.toVenueId : leg.fromVenueId;
      const remainingWindow = {
        startAt: transportLegs[0]?.leg.departAt ?? leg.arriveAt,
        endAt: routeResources(this.#state, route).window.endAt,
      };

      const entries = [{
        type: "IncidentReported",
        occurredAt,
        entities: [incidentId, routeId, exhibitId, ...affectedSchoolIds.map((s) => `school:${s}`)],
        payload: { incidentId, routeId, legIndex, exhibitId, responsibility, description },
      }, {
        type: "ExhibitDamaged",
        occurredAt,
        entities: [exhibitId, incidentId],
        payload: { exhibitId, incidentId, routeId, legIndex },
      }];
      const exhibitLock = this.#state.locks[exhibitId];
      if (exhibitLock && exhibitLock.holderId === routeId) {
        entries.push({
          type: "LockReleased",
          occurredAt,
          entities: [exhibitId, routeId],
          payload: {
            resourceId: exhibitId,
            token: exhibitLock.token,
            holderId: routeId,
            reason: "展具途中损坏，释放锁定",
            incidentId,
          },
        });
      }

      const actions = affectedEventIds.map((eventId) => {
        const er = this.#state.eventRequests[eventId];
        const venue = this.#state.venues[er.venueId];
        const needed = new Set(exhibit.capabilities ?? []);
        const candidates = Object.values(this.#state.exhibits)
          .filter((ex) => ex.exhibitId !== exhibitId)
          .filter((ex) => ex.status === "available")
          .filter((ex) => [...needed].every((c) => (ex.capabilities ?? []).includes(c)))
          .filter((ex) => ex.locationVenueId === joinVenueId)
          .filter((ex) => venueAccepts(venue, ex))
          .filter((ex) => !(ex.maintenanceWindows ?? []).some((mw) => windowsOverlap(mw, remainingWindow)))
          .filter((ex) => findLockConflicts(this.#state, [ex.exhibitId], remainingWindow, occurredAt).length === 0)
          .sort((a, b) => a.exhibitId.localeCompare(b.exhibitId));
        if (candidates.length > 0) {
          return { type: "substitute", eventId, replaceExhibitId: exhibitId, withExhibitId: candidates[0].exhibitId };
        }
        return { type: "reschedule_required", eventId, reason: "无可用替代展具，需显式改期" };
      });

      const alternativeId = `alt-${randomUUID()}`;
      entries.push({
        type: "AlternativeProposed",
        occurredAt,
        entities: [alternativeId, incidentId, routeId, ...affectedEventIds, ...affectedSchoolIds.map((s) => `school:${s}`)],
        payload: {
          alternativeId, incidentId, routeId, actions,
          affectedEventIds, affectedSchoolIds,
          reason: description || `展具 ${exhibitId} 途中损坏`,
          responsibility,
        },
      });
      for (const eventId of affectedEventIds) {
        entries.push({
          type: "EventDisrupted",
          occurredAt,
          entities: [eventId, incidentId, `school:${this.#state.eventRequests[eventId].schoolId}`],
          payload: {
            eventId,
            incidentId,
            schoolId: this.#state.eventRequests[eventId].schoolId,
            reason: `展具 ${exhibitId} 途中损坏（事故 ${incidentId}）`,
            responsibility,
          },
        });
      }
      return {
        entries,
        response: { incidentId, alternativeId, actions, affectedEventIds, affectedSchoolIds },
      };
    });
  }

  /** 接受替代方案：执行替换 / 显式改期，全部动作留痕。 */
  acceptAlternative(alternativeId, cmd, idempotencyKey) {
    return this.#run(idempotencyKey, () => {
      const alternative = this.#state.alternatives[alternativeId];
      if (!alternative) fail("NOT_FOUND", `替代方案不存在: ${alternativeId}`);
      if (alternative.status !== "proposed") {
        fail("CONFLICT", `替代方案状态为 ${alternative.status}，不可重复接受`);
      }
      const incident = this.#state.incidents[alternative.incidentId];
      const route = this.#mustRoute(alternative.routeId);
      const occurredAt = nowIso();
      const entries = [];
      const newLegs = structuredClone(route.legs);
      let legsChanged = false;

      for (const action of alternative.actions) {
        if (action.type === "substitute") {
          const substitute = this.#state.exhibits[action.withExhibitId];
          const replaceFrom = route.legs[incident.legIndex].status === "in_transit"
            ? incident.legIndex + 1
            : incident.legIndex;
          const remainingWindow = {
            startAt: route.legs[Math.min(replaceFrom, route.legs.length - 1)].departAt ?? route.legs[incident.legIndex].arriveAt,
            endAt: routeResources(this.#state, route).window.endAt,
          };
          if (!substitute || substitute.status !== "available") {
            fail("CONFLICT", `替代展具 ${action.withExhibitId} 不再可用`);
          }
          if (findLockConflicts(this.#state, [substitute.exhibitId], remainingWindow, occurredAt).length > 0) {
            fail("CONFLICT", `替代展具 ${substitute.exhibitId} 在所需窗口内已被锁定`);
          }
          for (let i = replaceFrom; i < newLegs.length; i++) {
            const idx = newLegs[i].exhibitIds.indexOf(action.replaceExhibitId);
            if (idx >= 0 && newLegs[i].status !== "completed") {
              newLegs[i].exhibitIds[idx] = substitute.exhibitId;
              legsChanged = true;
            }
          }
          const token = randomUUID();
          entries.push({
            type: "LockAcquired",
            occurredAt,
            entities: [substitute.exhibitId, route.routeId],
            payload: {
              resourceId: substitute.exhibitId,
              holderId: route.routeId,
              holderRouteId: route.routeId,
              token,
              fencing: this.#nextFencing(substitute.exhibitId),
              idempotencyKey: `${idempotencyKey}:${substitute.exhibitId}`,
              purpose: "route",
              window: remainingWindow,
              acquiredAt: occurredAt,
              expiresAt: this.#lockExpiry(remainingWindow.endAt),
            },
          });
          entries.push({
            type: "EventRestored",
            occurredAt,
            entities: [action.eventId, incident.incidentId, `school:${this.#state.eventRequests[action.eventId].schoolId}`],
            payload: {
              eventId: action.eventId,
              incidentId: incident.incidentId,
              reason: `以展具 ${substitute.exhibitId} 替代损坏展具 ${action.replaceExhibitId}`,
              responsibility: alternative.responsibility,
            },
          });
        } else if (action.type === "reschedule_required") {
          const newWindow = cmd?.rescheduledWindows?.[action.eventId];
          if (!newWindow) {
            fail("VALIDATION", `活动 ${action.eventId} 无替代展具，必须在 rescheduledWindows 中提供新窗口`);
          }
          const er = this.#state.eventRequests[action.eventId];
          assertNoHoliday(this.#state.venues[er.venueId], newWindow.startAt, newWindow.endAt);
          entries.push({
            type: "EventRescheduled",
            occurredAt,
            entities: [action.eventId, incident.incidentId, `school:${er.schoolId}`],
            payload: {
              eventId: action.eventId,
              startAt: newWindow.startAt,
              endAt: newWindow.endAt,
              reason: `因事故 ${incident.incidentId} 改期（展具 ${action.replaceExhibitId} 损坏且无替代）`,
              incidentId: incident.incidentId,
              responsibility: alternative.responsibility,
            },
          });
        }
      }

      if (legsChanged) {
        entries.push({
          type: "RouteUpdated",
          occurredAt,
          entities: [route.routeId, incident.incidentId],
          payload: {
            routeId: route.routeId,
            legs: newLegs,
            reason: `事故 ${incident.incidentId} 替代方案 ${alternativeId}`,
            incidentId: incident.incidentId,
          },
        });
      }
      entries.push({
        type: "AlternativeAccepted",
        occurredAt,
        entities: [alternativeId, incident.incidentId, route.routeId, ...alternative.affectedSchoolIds.map((s) => `school:${s}`)],
        payload: {
          alternativeId,
          incidentId: incident.incidentId,
          routeId: route.routeId,
          appliedActions: alternative.actions,
          affectedSchoolIds: alternative.affectedSchoolIds,
          responsibility: alternative.responsibility,
        },
      });
      return {
        entries,
        response: { alternativeId, status: "accepted", affectedSchoolIds: alternative.affectedSchoolIds },
      };
    });
  }

  // ---------- 重启恢复 ----------

  /**
   * 重启后调用：过期锁转为 LockExpired 事件，
   * 并列出已批准/执行中路线当前应执行的动作，保证路线继续推进。
   */
  recover(now = nowIso()) {
    const entries = [];
    for (const lock of Object.values(this.#state.locks)) {
      if (new Date(lock.expiresAt) <= new Date(now)) {
        entries.push({
          type: "LockExpired",
          occurredAt: now,
          entities: [lock.resourceId, lock.holderId],
          payload: { resourceId: lock.resourceId, token: lock.token, holderId: lock.holderId, reason: "恢复时发现锁已过期" },
        });
      }
    }
    if (entries.length > 0) this.#commit(entries, `recover:${randomUUID()}`);

    const pendingActions = [];
    for (const route of Object.values(this.#state.routes)) {
      if (route.status === "APPROVED" && new Date(route.legs[0].departAt) <= new Date(now)) {
        pendingActions.push({ type: "start_leg", routeId: route.routeId, legIndex: 0 });
      }
      if (route.status === "IN_PROGRESS") {
        const inTransit = route.legs.findIndex((l) => l.status === "in_transit");
        if (inTransit >= 0 && new Date(route.legs[inTransit].arriveAt) <= new Date(now)) {
          pendingActions.push({ type: "complete_leg", routeId: route.routeId, legIndex: inTransit });
        }
        if (inTransit < 0) {
          const next = route.legs.findIndex((l) => l.status === "planned");
          if (next >= 0 && new Date(route.legs[next].departAt) <= new Date(now)) {
            pendingActions.push({ type: "start_leg", routeId: route.routeId, legIndex: next });
          }
        }
      }
    }
    return { expiredLocks: entries.length, pendingActions };
  }

  // ---------- 查询 ----------

  /** 时间线：按实体过滤的审计视图，含每次改派的原因、责任方与受影响学校。 */
  timeline({ entity } = {}) {
    return this.#events
      .filter((e) => e.type !== "CommandRecorded")
      .filter((e) => !entity || (e.entities ?? []).includes(entity))
      .map((e) => ({
        seq: e.seq,
        type: e.type,
        occurredAt: e.occurredAt,
        recordedAt: e.recordedAt,
        entities: e.entities,
        reason: e.payload?.reason ?? null,
        responsibility: e.payload?.responsibility ?? null,
        affectedSchoolIds: e.payload?.affectedSchoolIds ?? null,
        details: e.payload,
      }));
  }

  getRoute(routeId) {
    const route = this.#state.routes[routeId];
    if (!route) fail("NOT_FOUND", `路线不存在: ${routeId}`);
    return structuredClone(route);
  }

  getState() {
    return structuredClone(this.#state);
  }
}
