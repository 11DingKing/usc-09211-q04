import { App } from "../src/app.mjs";

/** 标准世界：香港/澳门两馆、核心展品与替补、讲解员。 */
export function seedWorld(app) {
  app.registerVenue({
    venueId: "hk-venue",
    name: "香港科学馆",
    timeZone: "Asia/Hong_Kong",
    conditions: { climateControlled: true, maxItemWeightKg: 500, hasLoadingDock: true },
    holidays: ["2026-10-01"],
  }, "seed-venue-hk");
  app.registerVenue({
    venueId: "mo-venue",
    name: "澳门科学馆",
    timeZone: "Asia/Macau",
    conditions: { climateControlled: true, maxItemWeightKg: 300, hasLoadingDock: true },
    holidays: ["2026-12-20"],
  }, "seed-venue-mo");
  app.registerExhibit({
    exhibitId: "core-1",
    name: "核心舱模型",
    kitId: "kit-core",
    sequenceNo: 1,
    capabilities: ["core-display"],
    requiresConditions: ["climateControlled"],
    weightKg: 200,
    homeVenueId: "hk-venue",
  }, "seed-ex-core1");
  app.registerExhibit({
    exhibitId: "core-2",
    name: "核心舱备份模型",
    kitId: "kit-core",
    sequenceNo: 2,
    capabilities: ["core-display"],
    requiresConditions: ["climateControlled"],
    weightKg: 150,
    homeVenueId: "mo-venue",
  }, "seed-ex-core2");
  app.registerDocent({
    docentId: "docent-1",
    name: "陈讲师",
    qualifications: ["astro-basics"],
    baseVenueId: "hk-venue",
  }, "seed-docent1");
}

export function makeApp(config) {
  const app = App.open(null, config);
  seedWorld(app);
  return app;
}

/** 标准活动：澳门学校借展，2026-10-05 09:00–15:00 澳门本地时间。 */
export function seedMoEvent(app, { eventId = "evt-mo-1", priority = 1 } = {}) {
  app.requestEvent({
    eventId,
    schoolId: "mo-school-1",
    venueId: "mo-venue",
    startAt: "2026-10-05T01:00:00.000Z",
    endAt: "2026-10-05T07:00:00.000Z",
    requiredExhibitIds: ["core-1"],
    requiredQualifications: ["astro-basics"],
    priority,
  }, `seed-${eventId}`);
}

/** 标准路线：香港 → 澳门，10-04 08:00 出发、16:00（香港本地）到达。 */
export function planMoRoute(app, { routeId = "route-1", priority = 1, eventId = "evt-mo-1" } = {}) {
  return app.planRoute({
    routeId,
    priority,
    legs: [{
      fromVenueId: "hk-venue",
      toVenueId: "mo-venue",
      departAt: "2026-10-04T00:00:00.000Z",
      arriveAt: "2026-10-04T08:00:00.000Z",
      exhibitIds: ["core-1"],
      docentIds: ["docent-1"],
      eventId,
    }],
  }, `plan-${routeId}`);
}
