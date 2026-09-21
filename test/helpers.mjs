import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/domain/store.mjs";
import { Router } from "../src/domain/router.mjs";
import { zonedInstant } from "../src/domain/timezone.mjs";

export const FIXED_NOW = Date.parse("2026-01-01T00:00:00Z");

export function makeRouter({ now = () => FIXED_NOW } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tour-router-"));
  const file = join(dir, "events.jsonl");
  const store = new EventStore(file, { now });
  return {
    dir,
    file,
    store,
    router: new Router(store, { now }),
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function reopen(ctx, { now = () => FIXED_NOW } = {}) {
  ctx.store.close();
  const store = new EventStore(ctx.file, { now });
  ctx.store = store;
  ctx.router = await new Router(store, { now }).init();
  return ctx.router;
}

/** 场馆本地“日期 时点” -> UTC 毫秒。 */
export const at = (date, time, tz = "Asia/Hong_Kong") => zonedInstant(date, time, tz);

/** 注册一组标准基线数据：HK/MO 场馆、一所香港学校、两套核心展具与讲解员。 */
export async function seedBaseline(router, overrides = {}) {
  const cmds = [
    {
      type: "RegisterVenue",
      id: "v-hk",
      name: "香港科普馆",
      kind: "venue",
      region: "HK",
      capabilities: ["power-3kw", "darkroom"],
      calendar: { holidays: ["2026-10-01"], weeklyClosed: [], openHours: [["08:00", "20:00"]] },
    },
    {
      type: "RegisterVenue",
      id: "s-hk-1",
      name: "香江某中学",
      kind: "school",
      region: "HK",
      capabilities: ["power-3kw"],
      calendar: { holidays: ["2026-10-01"], weeklyClosed: [], openHours: [["08:00", "18:00"]] },
    },
    {
      type: "RegisterVenue",
      id: "v-mo",
      name: "澳门科普馆",
      kind: "venue",
      region: "MO",
      capabilities: ["power-3kw", "darkroom"],
      calendar: { holidays: [], weeklyClosed: [], openHours: [["09:00", "21:00"]] },
    },
    {
      type: "RegisterExhibit",
      id: "core-a",
      name: "核心舱 A",
      sequenceId: "SEQ-CORE",
      capabilities: ["core"],
      envRequirements: ["power-3kw"],
      region: "HK",
    },
    {
      type: "RegisterExhibit",
      id: "core-b",
      name: "核心舱 B",
      sequenceId: "SEQ-CORE",
      capabilities: ["core"],
      envRequirements: ["power-3kw"],
      region: "HK",
    },
    {
      type: "RegisterExhibit",
      id: "dome-1",
      name: "移动天象厅",
      sequenceId: "SEQ-DOME",
      capabilities: ["planetarium"],
      envRequirements: ["power-3kw", "darkroom"],
      region: "MO",
    },
    {
      type: "RegisterGuide",
      id: "g-can",
      name: "阿甄",
      qualifications: ["bilingual"],
      regions: ["HK", "MO"],
    },
    {
      type: "RegisterGuide",
      id: "g-hk",
      name: "阿港",
      qualifications: ["bilingual"],
      regions: ["HK"],
    },
    { type: "ConfigureTravelBuffer", regionA: "HK", regionB: "MO", hours: 24 },
    ...(overrides.extraCommands ?? []),
  ];
  const out = [];
  for (const c of cmds) out.push(await router.submit(c));
  return out;
}

export function eventTypes(result) {
  return result.events.map((e) => e.type);
}
