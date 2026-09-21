import assert from "node:assert/strict";
import test from "node:test";
import { App } from "../src/app.mjs";

const WINDOW = { startAt: "2026-10-04T00:00:00.000Z", endAt: "2026-10-06T00:00:00.000Z" };

test("重复请求：同一幂等键重复加锁返回同一令牌，不产生重复事件", () => {
  const app = App.open(null);
  const first = app.acquireLock({ resourceId: "crate-1", holderId: "ops-a", window: WINDOW }, "lock-key-1");
  const second = app.acquireLock({ resourceId: "crate-1", holderId: "ops-a", window: WINDOW }, "lock-key-1");
  assert.equal(second.replay, true);
  assert.equal(second.token, first.token);
  assert.equal(second.fencing, first.fencing);
  const acquired = app.timeline({ entity: "crate-1" }).filter((e) => e.type === "LockAcquired");
  assert.equal(acquired.length, 1);
});

test("并发竞争：资源已锁定时他人加锁被拒绝并返回 fencing", () => {
  const app = App.open(null);
  const first = app.acquireLock({ resourceId: "crate-1", holderId: "ops-a", window: WINDOW }, "k1");
  assert.throws(
    () => app.acquireLock({ resourceId: "crate-1", holderId: "ops-b", window: WINDOW }, "k2"),
    (err) => err.code === "CONFLICT" && err.details.fencing === first.fencing,
  );
});

test("释放后重新加锁 fencing 单调递增；错误令牌无法释放", () => {
  const app = App.open(null);
  const first = app.acquireLock({ resourceId: "crate-1", holderId: "ops-a", window: WINDOW }, "k1");
  assert.throws(
    () => app.releaseLock({ resourceId: "crate-1", token: "forged-token" }, "k2"),
    (err) => err.code === "CONFLICT",
  );
  app.releaseLock({ resourceId: "crate-1", token: first.token }, "k3");
  const second = app.acquireLock({ resourceId: "crate-1", holderId: "ops-b", window: WINDOW }, "k4");
  assert.equal(second.fencing, first.fencing + 1);
});

test("重复释放同一令牌是幂等空操作", () => {
  const app = App.open(null);
  const first = app.acquireLock({ resourceId: "crate-1", holderId: "ops-a", window: WINDOW }, "k1");
  app.releaseLock({ resourceId: "crate-1", token: first.token }, "k2");
  const again = app.releaseLock({ resourceId: "crate-1", token: first.token }, "k3");
  assert.equal(again.alreadyReleased, true);
});

test("过期锁可被接管，并留下 LockExpired 审计记录", () => {
  const app = App.open(null);
  app.acquireLock({ resourceId: "crate-1", holderId: "ops-a", window: WINDOW, ttlMs: -1000 }, "k1");
  const second = app.acquireLock({ resourceId: "crate-1", holderId: "ops-b", window: WINDOW }, "k2");
  assert.equal(second.fencing, 2);
  const types = app.timeline({ entity: "crate-1" }).map((e) => e.type);
  assert.ok(types.includes("LockExpired"));
});

test("缺少幂等键的变更请求被拒绝", () => {
  const app = App.open(null);
  assert.throws(
    () => app.acquireLock({ resourceId: "crate-1", holderId: "ops-a", window: WINDOW }, undefined),
    (err) => err.code === "IDEMPOTENCY_REQUIRED",
  );
});
