import assert from "node:assert/strict";
import test from "node:test";
import { localDate, localDatesTouched, assertNoHoliday } from "../src/domain/time.mjs";
import { makeApp } from "./helpers.mjs";

test("同一瞬间按场馆时区落在不同本地日期", () => {
  // UTC 2026-09-30 16:30 在香港已是 10-01 00:30
  assert.equal(localDate("2026-09-30T16:30:00.000Z", "Asia/Hong_Kong"), "2026-10-01");
  assert.equal(localDate("2026-09-30T16:30:00.000Z", "UTC"), "2026-09-30");
});

test("跨日窗口触及的本地日期按半开区间计算", () => {
  const dates = localDatesTouched("2026-09-30T20:00:00.000Z", "2026-10-02T04:00:00.000Z", "Asia/Hong_Kong");
  assert.deepEqual(dates, ["2026-10-01", "2026-10-02"]);
  // 恰好结束于当地 00:00 的窗口不计入结束当天（16:00Z 即香港次日 00:00）
  const tillMidnight = localDatesTouched("2026-09-30T10:00:00.000Z", "2026-09-30T16:00:00.000Z", "Asia/Hong_Kong");
  assert.deepEqual(tillMidnight, ["2026-09-30"]);
});

test("节假日按场馆时区判定：香港假期拒绝、澳门同一瞬间放行", () => {
  const app = makeApp();
  // UTC 2026-09-30 17:00–18:00 → 香港本地 10-01 01:00–02:00（香港公众假期）
  assert.throws(
    () => app.requestEvent({
      eventId: "evt-hk-holiday",
      schoolId: "hk-school-1",
      venueId: "hk-venue",
      startAt: "2026-09-30T17:00:00.000Z",
      endAt: "2026-09-30T18:00:00.000Z",
      requiredExhibitIds: ["core-1"],
    }, "k-hk-holiday"),
    (err) => err.code === "VENUE_HOLIDAY" && err.details.blockedDates.includes("2026-10-01"),
  );
  // 同一瞬间在澳门不是节假日
  const ok = app.requestEvent({
    eventId: "evt-mo-same-instant",
    schoolId: "mo-school-2",
    venueId: "mo-venue",
    startAt: "2026-09-30T17:00:00.000Z",
    endAt: "2026-09-30T18:00:00.000Z",
    requiredExhibitIds: [],
  }, "k-mo-same-instant");
  assert.equal(ok.replay, false);
});

test("未知时区被拒绝", () => {
  assert.throws(
    () => assertNoHoliday({ venueId: "v", timeZone: "Mars/Olympus", holidays: [] }, "2026-10-02T00:00:00.000Z", "2026-10-02T01:00:00.000Z"),
    (err) => err.code === "VALIDATION",
  );
});
