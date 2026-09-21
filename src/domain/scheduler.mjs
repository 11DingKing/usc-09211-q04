import { fail } from "./errors.mjs";
import { assertNoHoliday, hoursBetween } from "./time.mjs";

export function windowsOverlap(a, b) {
  return new Date(a.startAt) < new Date(b.endAt) && new Date(b.startAt) < new Date(a.endAt);
}

/** 路线占用窗口：从首段出发到最后一段到达，并延伸到末段活动结束（含撤展前）。 */
export function routeResources(state, route) {
  const exhibitIds = new Set();
  const docentIds = new Set();
  let endAt = route.legs[route.legs.length - 1].arriveAt;
  for (const leg of route.legs) {
    for (const id of leg.exhibitIds ?? []) exhibitIds.add(id);
    for (const id of leg.docentIds ?? []) docentIds.add(id);
    if (leg.eventId) {
      const er = state.eventRequests[leg.eventId];
      if (er && new Date(er.endAt) > new Date(endAt)) endAt = er.endAt;
    }
  }
  return {
    exhibitIds: [...exhibitIds],
    docentIds: [...docentIds],
    window: { startAt: route.legs[0].departAt, endAt },
  };
}

export function findLockConflicts(state, resourceIds, window, nowIso) {
  const conflicts = [];
  for (const resourceId of resourceIds) {
    const lock = state.locks[resourceId];
    if (!lock) continue;
    if (new Date(lock.expiresAt) <= new Date(nowIso)) continue;
    if (windowsOverlap(lock.window, window)) conflicts.push(lock);
  }
  return conflicts;
}

function assertVenueConditions(venue, exhibit) {
  const missing = (exhibit.requiresConditions ?? []).filter((c) => !venue.conditions?.[c]);
  if (missing.length > 0) {
    fail("VENUE_CONDITION", `展具 ${exhibit.exhibitId} 需要场馆条件 [${missing.join(", ")}]，场馆 ${venue.venueId} 不满足`, {
      venueId: venue.venueId,
      exhibitId: exhibit.exhibitId,
      missing,
    });
  }
  const maxWeight = venue.conditions?.maxItemWeightKg;
  if (maxWeight != null && exhibit.weightKg != null && exhibit.weightKg > maxWeight) {
    fail("VENUE_CONDITION", `展具 ${exhibit.exhibitId} 重 ${exhibit.weightKg}kg，超出场馆 ${venue.venueId} 承重 ${maxWeight}kg`, {
      venueId: venue.venueId,
      exhibitId: exhibit.exhibitId,
    });
  }
}

export function venueAccepts(venue, exhibit) {
  try {
    assertVenueConditions(venue, exhibit);
    return true;
  } catch {
    return false;
  }
}

/** 同一活动不得被两条未取消的路线重复承接。 */
export function assertEventsNotAssigned(state, routeId, legs) {
  for (const leg of legs) {
    if (!leg.eventId) continue;
    for (const other of Object.values(state.routes)) {
      if (other.routeId === routeId || other.status === "CANCELLED") continue;
      if (other.legs.some((l) => l.eventId === leg.eventId)) {
        fail("CONFLICT", `活动 ${leg.eventId} 已由路线 ${other.routeId} 承接`, {
          eventId: leg.eventId,
          holderRouteId: other.routeId,
        });
      }
    }
  }
}

/**
 * 校验路线计划：展具状态与位置、维护停用窗口、运输缓冲、
 * 场馆条件、节假日规则、讲解员资质、布展时间。
 */
export function validateLegs(state, plan, config) {
  if (!Array.isArray(plan.legs) || plan.legs.length === 0) {
    fail("VALIDATION", "路线至少需要一个航段");
  }
  const bufferHours = plan.transportBufferHours ?? config.transportBufferHours;
  let prev = null;
  for (let i = 0; i < plan.legs.length; i++) {
    const leg = plan.legs[i];
    const from = state.venues[leg.fromVenueId];
    const to = state.venues[leg.toVenueId];
    if (!from) fail("NOT_FOUND", `出发场馆不存在: ${leg.fromVenueId}`);
    if (!to) fail("NOT_FOUND", `到达场馆不存在: ${leg.toVenueId}`);
    if (!(new Date(leg.arriveAt) > new Date(leg.departAt))) {
      fail("VALIDATION", `航段 ${i} 到达时间必须晚于出发时间`);
    }
    if (prev) {
      if (leg.fromVenueId !== prev.toVenueId) {
        fail("VALIDATION", `航段 ${i} 出发场馆必须等于上一航段到达场馆 ${prev.toVenueId}`);
      }
      if (hoursBetween(prev.arriveAt, leg.departAt) < bufferHours) {
        fail("TRANSPORT_BUFFER", `航段 ${i} 与上一航段之间运输缓冲不足 ${bufferHours} 小时`, {
          legIndex: i,
          requiredHours: bufferHours,
        });
      }
    }
    for (const exhibitId of leg.exhibitIds ?? []) {
      const exhibit = state.exhibits[exhibitId];
      if (!exhibit) fail("NOT_FOUND", `展具不存在: ${exhibitId}`);
      if (exhibit.status === "damaged") fail("CONFLICT", `展具 ${exhibitId} 已损坏停用`);
      for (const mw of exhibit.maintenanceWindows ?? []) {
        if (windowsOverlap(mw, { startAt: leg.departAt, endAt: leg.arriveAt })) {
          fail("MAINTENANCE", `展具 ${exhibitId} 在航段 ${i} 期间处于维护停用窗口`, {
            exhibitId,
            legIndex: i,
          });
        }
      }
      const joinsHere = i === 0 || !(prev.exhibitIds ?? []).includes(exhibitId);
      if (joinsHere && exhibit.locationVenueId && exhibit.locationVenueId !== leg.fromVenueId) {
        fail("CONFLICT", `展具 ${exhibitId} 当前位于 ${exhibit.locationVenueId}，无法从 ${leg.fromVenueId} 发运`, {
          exhibitId,
          locationVenueId: exhibit.locationVenueId,
        });
      }
    }
    for (const docentId of leg.docentIds ?? []) {
      if (!state.docents[docentId]) fail("NOT_FOUND", `讲解员不存在: ${docentId}`);
    }
    if (leg.eventId) {
      const er = state.eventRequests[leg.eventId];
      if (!er) fail("NOT_FOUND", `活动不存在: ${leg.eventId}`);
      if (er.venueId !== leg.toVenueId) {
        fail("VALIDATION", `活动 ${er.eventId} 的场馆 ${er.venueId} 与航段目的地 ${leg.toVenueId} 不一致`);
      }
      if (er.status !== "scheduled") {
        fail("CONFLICT", `活动 ${er.eventId} 当前状态为 ${er.status}，不可排入路线`);
      }
      if (hoursBetween(leg.arriveAt, er.startAt) < config.setupHours) {
        fail("SETUP_BUFFER", `活动 ${er.eventId} 开始时间距航段到达不足 ${config.setupHours} 小时布展时间`, {
          eventId: er.eventId,
        });
      }
      assertNoHoliday(to, er.startAt, er.endAt);
      for (const exhibitId of er.requiredExhibitIds ?? []) {
        if (!(leg.exhibitIds ?? []).includes(exhibitId)) {
          fail("VALIDATION", `活动 ${er.eventId} 需要展具 ${exhibitId}，但航段未携带`);
        }
        assertVenueConditions(to, state.exhibits[exhibitId]);
      }
      const covered = new Set((leg.docentIds ?? []).flatMap((d) => state.docents[d].qualifications ?? []));
      const missingQuals = (er.requiredQualifications ?? []).filter((q) => !covered.has(q));
      if (missingQuals.length > 0) {
        fail("QUALIFICATION", `活动 ${er.eventId} 缺少讲解员资质: ${missingQuals.join(", ")}`, {
          eventId: er.eventId,
          missingQualifications: missingQuals,
        });
      }
    }
    prev = leg;
  }
}
