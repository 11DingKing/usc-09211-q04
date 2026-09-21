import http from "node:http";
import { Router } from "../domain/router.mjs";
import { EventStore } from "../domain/store.mjs";
import { CommandError } from "../domain/engine.mjs";

/**
 * HTTP 适配层：
 *   GET  /health
 *   POST /commands                 提交一条命令（幂等：body.commandId）
 *   GET  /routes                   全部活动路线（按开始时间排序）
 *   GET  /activities/:id           单个活动视图（含受影响学校、阻断原因）
 *   GET  /incidents/:id            损坏事件与替代链
 *   GET  /timeline?activityId=...  审计时间线（事件时间/接收时间分列）
 */
export async function createApp({ storeFile, now = () => Date.now() } = {}) {
  if (!storeFile) throw new Error("createApp 需要 storeFile");
  const store = new EventStore(storeFile, { now });
  const router = await new Router(store, { now }).init();

  const server = http.createServer((request, response) => {
    handle(request, response, router).catch((err) => {
      const body = { error: "INTERNAL", message: err.message };
      send(response, 500, body);
    });
  });

  return { server, router, store };
}

async function handle(request, response, router) {
  const url = new URL(request.url, "http://localhost");
  const { pathname } = url;

  if (request.method === "GET" && pathname === "/health") {
    return send(response, 200, { status: "ok" });
  }

  if (request.method === "POST" && pathname === "/commands") {
    let command;
    try {
      command = await readJson(request);
      const result = await router.submit(command);
      return send(response, 200, result);
    } catch (err) {
      return send(response, statusFor(err), serializeError(err));
    }
  }

  if (request.method === "GET" && pathname === "/routes") {
    return send(response, 200, { routes: router.routes() });
  }

  if (request.method === "GET" && pathname.startsWith("/activities/")) {
    const id = decodeURIComponent(pathname.slice("/activities/".length));
    try {
      return send(response, 200, router.activityView(id));
    } catch (err) {
      return send(response, statusFor(err), serializeError(err));
    }
  }

  if (request.method === "GET" && pathname.startsWith("/incidents/")) {
    const id = decodeURIComponent(pathname.slice("/incidents/".length));
    try {
      return send(response, 200, router.incidentView(id));
    } catch (err) {
      return send(response, statusFor(err), serializeError(err));
    }
  }

  if (request.method === "GET" && pathname === "/timeline") {
    const activityId = url.searchParams.get("activityId") ?? undefined;
    const from = url.searchParams.get("from") ? Number(url.searchParams.get("from")) : undefined;
    const to = url.searchParams.get("to") ? Number(url.searchParams.get("to")) : undefined;
    return send(response, 200, { timeline: router.timeline({ activityId, from, to }) });
  }

  send(response, 404, { error: "NOT_FOUND", message: `无此路由：${request.method} ${pathname}` });
}

function statusFor(err) {
  if (!(err instanceof CommandError)) return 500;
  switch (err.code) {
    case "NOT_FOUND":
      return 404;
    case "ALREADY_EXISTS":
    case "ALLOCATION_FAILED":
    case "VENUE_CALENDAR_CLOSED":
    case "TRAVEL_NOT_CONFIGURED":
    case "INVALID_STATE":
      return 409;
    case "VALIDATION":
    case "UNKNOWN_COMMAND":
    case "BAD_COMMAND":
      return 400;
    default:
      return 400;
  }
}

function serializeError(err) {
  return { error: err.code ?? "INTERNAL", message: err.message, details: err.details };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) throw new CommandError("VALIDATION", "请求体为空");
  try {
    return JSON.parse(raw);
  } catch {
    throw new CommandError("VALIDATION", "请求体不是合法 JSON");
  }
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
