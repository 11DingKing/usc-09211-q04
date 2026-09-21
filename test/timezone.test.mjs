import assert from "node:assert/strict";
import test from "node:test";
import { VenueCalendar, localDate, zonedInstant, zonedParts, plusLocalDays } from "../src/domain/timezone.mjs";
import { makeRouter, seedBaseline, at } from "./helpers.mjs";

test("zonedInstant 按指定时区解释墙钟时间", () => {
  // 香港/澳门均为 UTC+8
  assert.equal(zonedInstant("2026-09-15", "10:00", "Asia/Hong_Kong"), Date.parse("2026-09-15T02:00:00Z"));
  assert.equal(localDate(Date.parse("2026-09-15T18:00:00Z"), "Asia/Hong_Kong"), "2026-09-16");
});

test("跨日按场馆本地日历判定：UTC 同一天但场馆已跨日", () => {
  // 2026-09-15 23:30 HK → UTC 15:30；本地已是次日不影响同一场馆判断，
  // 这里验证本地日期推进：UTC 15:30 在香港是 23:30 当天，加 2 小时即跨日
  const evening = zonedInstant("2026-09-15", "23:30", "Asia/Hong_Kong");
  assert.equal(localDate(evening, "Asia/Hong_Kong"), "2026-09-15");
  assert.equal(localDate(plusLocalDays(evening, 1, "Asia/Hong_Kong"), "Asia/Hong_Kong"), "2026-09-16");
});

test("闭馆日（每周闭馆 + 节假日）拒绝排期", async () => {
  const ctx = makeRouter();
  await ctx.router.init();
  await seedBaseline(ctx.router, {
    extraCommands: [
      {
        type: "UpdateVenueCalendar",
        venueId: "v-mo",
        calendar: { holidays: ["2026-09-25"], weeklyClosed: [2], openHours: [["09:00", "21:00"]] },
      },
    ],
  });

  const base = {
    type: "RequestActivity",
    id: "cal-1",
    venueId: "v-mo",
    start: at("2026-09-25", "10:00", "Asia/Macau"),
    end: at("2026-09-25", "12:00", "Asia/Macau"),
    priority: 100,
    needs: ["planetarium"],
  };
  await assert.rejects(() => ctx.router.submit({ ...base, commandId: "c1" }), /VENUE_CALENDAR_CLOSED|场馆日历/);

  // 2026-09-29 是周二（weeklyClosed=[2]）
  assert.equal(zonedParts(at("2026-09-29", "10:00", "Asia/Macau"), "Asia/Macau").weekday, 2);
  await assert.rejects(
    () =>
      ctx.router.submit({
        ...base,
        commandId: "c2",
        id: "cal-2",
        start: at("2026-09-29", "10:00", "Asia/Macau"),
        end: at("2026-09-29", "12:00", "Asia/Macau"),
      }),
    /closed_day|start_on_closed_day/,
  );

  // 开放时段外
  await assert.rejects(
    () =>
      ctx.router.submit({
        ...base,
        commandId: "c3",
        id: "cal-3",
        start: at("2026-09-24", "07:00", "Asia/Macau"),
        end: at("2026-09-24", "08:00", "Asia/Macau"),
      }),
    /outside_open_hours/,
  );

  // 正常开放日可以排
  const ok = await ctx.router.submit({
    ...base,
    commandId: "c4",
    id: "cal-4",
    start: at("2026-09-24", "10:00", "Asia/Macau"),
    end: at("2026-09-24", "12:00", "Asia/Macau"),
  });
  assert.equal(ok.duplicate, false);
  ctx.cleanup();
});

test("跨日活动经过的每一天都必须是开放日", () => {
  const cal = new VenueCalendar({
    timeZone: "Asia/Macau",
    holidays: ["2026-09-26"],
    weeklyClosed: [],
    openHours: [],
  });
  const start = at("2026-09-25", "09:00", "Asia/Macau");
  const end = at("2026-09-27", "18:00", "Asia/Macau");
  const problems = cal.checkWindow(start, end, { multiDay: true });
  assert.ok(problems.some((p) => p.includes("2026-09-26")));
});
