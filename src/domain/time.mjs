import { fail } from "./errors.mjs";

const STEP_MS = 6 * 3600 * 1000;

const formatters = new Map();

function formatter(timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      fmt.format(new Date(0));
    } catch {
      fail("VALIDATION", `未知时区: ${timeZone}`);
    }
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** 某个瞬间在指定时区下的本地日期（YYYY-MM-DD）。 */
export function localDate(instant, timeZone) {
  return formatter(timeZone).format(new Date(instant));
}

/**
 * 时间窗口 [startAt, endAt) 在指定时区下触及的所有本地日期。
 * 窗口按半开区间处理：恰好结束于当地 00:00 的活动不计入结束当天。
 */
export function localDatesTouched(startAt, endAt, timeZone) {
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    fail("VALIDATION", "时间窗口结束必须晚于开始");
  }
  const dates = [];
  const seen = new Set();
  for (let t = start; t < end; t += STEP_MS) {
    const d = localDate(t, timeZone);
    if (!seen.has(d)) {
      seen.add(d);
      dates.push(d);
    }
  }
  const tail = localDate(end - 1, timeZone);
  if (!seen.has(tail)) {
    seen.add(tail);
    dates.push(tail);
  }
  return dates;
}

/** 窗口在场馆时区下触及任一节假日则拒绝。 */
export function assertNoHoliday(venue, startAt, endAt) {
  const holidays = new Set(venue.holidays ?? []);
  const blocked = localDatesTouched(startAt, endAt, venue.timeZone).filter((d) => holidays.has(d));
  if (blocked.length > 0) {
    fail("VENUE_HOLIDAY", `场馆 ${venue.venueId} 在本地节假日不可用`, {
      venueId: venue.venueId,
      timeZone: venue.timeZone,
      blockedDates: blocked,
    });
  }
}

export function hoursBetween(startAt, endAt) {
  return (new Date(endAt).getTime() - new Date(startAt).getTime()) / 3600000;
}
