import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/server.mjs";

async function withServer(fn) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(base, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() };
}

test("HTTP：同一幂等键重放返回相同结果且不重复登记", async () => {
  await withServer(async (base) => {
    const venue = {
      venueId: "hk-venue",
      name: "香港科学馆",
      timeZone: "Asia/Hong_Kong",
      conditions: {},
      holidays: [],
    };
    const first = await post(base, "/venues", venue, { "idempotency-key": "http-key-1" });
    assert.equal(first.status, 200);
    assert.equal(first.body.replay, false);
    const second = await post(base, "/venues", venue, { "idempotency-key": "http-key-1" });
    assert.equal(second.status, 200);
    assert.equal(second.body.replay, true);
    const state = await (await fetch(`${base}/state`)).json();
    assert.equal(Object.keys(state.venues).length, 1);
  });
});

test("HTTP：缺少幂等键返回 400，未知路径返回 404", async () => {
  await withServer(async (base) => {
    const missing = await post(base, "/venues", { venueId: "v", name: "n", timeZone: "UTC" });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, "IDEMPOTENCY_REQUIRED");
    const notFound = await fetch(`${base}/nope`);
    assert.equal(notFound.status, 404);
  });
});

test("HTTP：领域冲突以 409 返回结构化错误", async () => {
  await withServer(async (base) => {
    await post(base, "/venues", {
      venueId: "hk-venue", name: "香港科学馆", timeZone: "Asia/Hong_Kong",
      conditions: {}, holidays: ["2026-10-01"],
    }, { "idempotency-key": "v1" });
    const conflict = await post(base, "/events", {
      eventId: "e1", schoolId: "s1", venueId: "hk-venue",
      startAt: "2026-09-30T17:00:00.000Z", endAt: "2026-09-30T18:00:00.000Z",
    }, { "idempotency-key": "e1" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "VENUE_HOLIDAY");
    assert.ok(conflict.body.error.details.blockedDates.includes("2026-10-01"));
  });
});
