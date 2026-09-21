// 场馆本地时区下的日历规则。所有“跨日 / 节假日 / 开放时段”判定都以场馆时区为准，
// 而不是服务器时区——香港（Asia/Hong_Kong）与澳门（Asia/Macau）同偏移但规则各自维护。

const DAY_MS = 86_400_000;

/** 返回某时刻在指定 IANA 时区内的日历部件（年/月/日、星期、时分）。 */
export function zonedParts(instant, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  const weekdayIndex = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    // ISO 星期（1=周一 … 7=周日）
    weekday: parts.weekday === "Sun" ? 7 : weekdayIndex + 1,
  };
}

/** 场馆本地日历日（YYYY-MM-DD）。 */
export function localDate(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * 把场馆本地“某日某时”的墙钟时间解释为 UTC 毫秒。
 * @param {string} date YYYY-MM-DD（场馆本地）
 * @param {string} time HH:MM（场馆本地）
 */
export function zonedInstant(date, time, timeZone) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  // 以 UTC 候选逼近，再用时区部件反算偏移，兼容夏令时（港澳当前不实行，仍保持通用）。
  let guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, timeZone);
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const target = Date.UTC(y, m - 1, d, hh, mm, 0);
    guess += target - asUTC;
  }
  return guess;
}

/** 场馆本地日历上把瞬时向后推 n 天的同一墙钟时刻。 */
export function plusLocalDays(instant, days, timeZone) {
  const p = zonedParts(instant, timeZone);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day) + days * DAY_MS);
  return zonedInstant(
    `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(
      shifted.getUTCDate(),
    ).padStart(2, "0")}`,
    `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`,
    timeZone,
  );
}

/**
 * 节假日与开放日历。holidays 为场馆本地日期集合（YYYY-MM-DD）；
 * weeklyClosed 为闭馆星期集合（ISO 星期，1=周一）；openHours 为每日允许的 [起,止] 本地时段。
 */
export class VenueCalendar {
  constructor({ timeZone, holidays = [], weeklyClosed = [], openHours = [] } = {}) {
    this.timeZone = timeZone;
    this.holidays = new Set(holidays);
    this.weeklyClosed = new Set(weeklyClosed);
    this.openHours = openHours;
  }

  isOpenDay(instant) {
    const p = zonedParts(instant, this.timeZone);
    return !this.holidays.has(localDate(instant, this.timeZone)) && !this.weeklyClosed.has(p.weekday);
  }

  /** 区间 [start,end)（UTC 毫秒）是否跨场馆本地非开放日或落在开放时段外。跨日活动允许跨午夜。 */
  checkWindow(start, end, { multiDay = false } = {}) {
    const problems = [];
    if (!this.isOpenDay(start)) problems.push(`start_on_closed_day:${localDate(start, this.timeZone)}`);
    if (multiDay) {
      // 跨日活动：起止之间每一天都必须是开放日
      let cursor = start;
      while (cursor < end) {
        if (!this.isOpenDay(cursor)) problems.push(`closed_day:${localDate(cursor, this.timeZone)}`);
        cursor = plusLocalDays(cursor, 1, this.timeZone);
      }
    } else if (!this.isOpenDay(end)) {
      problems.push(`end_on_closed_day:${localDate(end, this.timeZone)}`);
    }
    if (this.openHours.length > 0) {
      const p = zonedParts(start, this.timeZone);
      const minutes = p.hour * 60 + p.minute;
      const ok = this.openHours.some(([from, to]) => {
        const [fh, fm] = from.split(":").map(Number);
        const [th, tm] = to.split(":").map(Number);
        return minutes >= fh * 60 + fm && minutes <= th * 60 + tm;
      });
      if (!ok) problems.push("outside_open_hours");
    }
    return problems;
  }
}
