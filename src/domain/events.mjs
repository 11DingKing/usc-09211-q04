/**
 * 事件溯源状态：所有字段均为可 JSON 序列化的普通对象，
 * 状态只能由追加事件重建，审计记录不得以覆盖方式修改。
 */
export function initialState() {
  return {
    seq: 0,
    venues: {},
    exhibits: {},
    docents: {},
    eventRequests: {},
    routes: {},
    locks: {},
    lockHistory: {},
    incidents: {},
    alternatives: {},
    idempotency: {},
  };
}

export function applyEvent(state, event) {
  const p = event.payload;
  switch (event.type) {
    case "VenueRegistered":
      state.venues[p.venueId] = structuredClone(p);
      break;
    case "ExhibitRegistered":
      state.exhibits[p.exhibitId] = {
        ...structuredClone(p),
        status: "available",
        maintenanceWindows: [],
        locationVenueId: p.homeVenueId,
      };
      break;
    case "ExhibitMaintenanceScheduled":
      state.exhibits[p.exhibitId].maintenanceWindows.push({
        startAt: p.startAt,
        endAt: p.endAt,
        reason: p.reason ?? null,
      });
      break;
    case "ExhibitDamaged": {
      const exhibit = state.exhibits[p.exhibitId];
      exhibit.status = "damaged";
      exhibit.damagedByIncidentId = p.incidentId;
      break;
    }
    case "DocentRegistered":
      state.docents[p.docentId] = structuredClone(p);
      break;
    case "EventRequested":
      state.eventRequests[p.eventId] = { ...structuredClone(p), status: "scheduled" };
      break;
    case "EventDisrupted": {
      const er = state.eventRequests[p.eventId];
      er.status = "disrupted";
      er.disruptedByIncidentId = p.incidentId;
      break;
    }
    case "EventRestored": {
      const er = state.eventRequests[p.eventId];
      er.status = "scheduled";
      delete er.disruptedByIncidentId;
      break;
    }
    case "EventRescheduled": {
      const er = state.eventRequests[p.eventId];
      er.startAt = p.startAt;
      er.endAt = p.endAt;
      er.status = "scheduled";
      delete er.disruptedByIncidentId;
      break;
    }
    case "EventFulfilled":
      state.eventRequests[p.eventId].status = "fulfilled";
      break;
    case "RoutePlanned":
      state.routes[p.routeId] = {
        routeId: p.routeId,
        priority: p.priority,
        transportBufferHours: p.transportBufferHours,
        legs: p.legs.map((leg) => ({ ...structuredClone(leg), status: "planned" })),
        status: "PLANNED",
        version: 1,
      };
      break;
    case "RouteApproved": {
      const route = state.routes[p.routeId];
      route.status = "APPROVED";
      route.version += 1;
      break;
    }
    case "RoutePreempted": {
      const route = state.routes[p.routeId];
      route.status = "PLANNED";
      route.version += 1;
      break;
    }
    case "RouteUpdated": {
      const route = state.routes[p.routeId];
      route.legs = structuredClone(p.legs);
      route.version += 1;
      break;
    }
    case "RouteCancelled": {
      const route = state.routes[p.routeId];
      route.status = "CANCELLED";
      route.version += 1;
      break;
    }
    case "RouteLegStarted": {
      const route = state.routes[p.routeId];
      route.status = "IN_PROGRESS";
      route.legs[p.legIndex].status = "in_transit";
      for (const id of route.legs[p.legIndex].exhibitIds) {
        state.exhibits[id].status = "in_transit";
      }
      break;
    }
    case "RouteLegCompleted": {
      const route = state.routes[p.routeId];
      const leg = route.legs[p.legIndex];
      leg.status = "completed";
      for (const id of leg.exhibitIds) {
        const exhibit = state.exhibits[id];
        if (exhibit.status === "in_transit") exhibit.status = "available";
        exhibit.locationVenueId = leg.toVenueId;
      }
      break;
    }
    case "RouteCompleted":
      state.routes[p.routeId].status = "COMPLETED";
      break;
    case "LockAcquired":
      state.locks[p.resourceId] = {
        resourceId: p.resourceId,
        holderId: p.holderId,
        holderRouteId: p.holderRouteId ?? null,
        token: p.token,
        fencing: p.fencing,
        idempotencyKey: p.idempotencyKey ?? null,
        purpose: p.purpose,
        window: structuredClone(p.window),
        acquiredAt: p.acquiredAt,
        expiresAt: p.expiresAt,
      };
      state.lockHistory[p.resourceId] = {
        ...(state.lockHistory[p.resourceId] ?? {}),
        lastFencing: p.fencing,
      };
      break;
    case "LockReleased":
    case "LockExpired":
    case "LockPreempted":
      delete state.locks[p.resourceId];
      state.lockHistory[p.resourceId] = {
        ...(state.lockHistory[p.resourceId] ?? {}),
        lastReleasedToken: p.token,
      };
      break;
    case "IncidentReported":
      state.incidents[p.incidentId] = structuredClone(p);
      break;
    case "AlternativeProposed":
      state.alternatives[p.alternativeId] = { ...structuredClone(p), status: "proposed" };
      break;
    case "AlternativeAccepted":
      state.alternatives[p.alternativeId].status = "accepted";
      break;
    case "CommandRecorded":
      state.idempotency[p.key] = { response: structuredClone(p.response) };
      break;
    default:
      throw new Error(`未知事件类型: ${event.type}`);
  }
}
