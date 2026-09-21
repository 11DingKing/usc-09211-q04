import http from "node:http";
import { App } from "./app.mjs";
import { DomainError } from "./domain/errors.mjs";

const ERROR_STATUS = {
  VALIDATION: 400,
  IDEMPOTENCY_REQUIRED: 400,
  QUALIFICATION: 400,
  VENUE_CONDITION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VENUE_HOLIDAY: 409,
  TRANSPORT_BUFFER: 409,
  SETUP_BUFFER: 409,
  MAINTENANCE: 409,
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new DomainError("VALIDATION", "请求体必须是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

export function createServer({ dataDir = null, config } = {}) {
  const app = App.open(dataDir, config);

  const routes = [
    ["GET", /^\/health$/, () => ({ status: "ok" })],
    ["POST", /^\/venues$/, (b, k) => app.registerVenue(b, k)],
    ["POST", /^\/exhibits$/, (b, k) => app.registerExhibit(b, k)],
    ["POST", /^\/docents$/, (b, k) => app.registerDocent(b, k)],
    ["POST", /^\/events$/, (b, k) => app.requestEvent(b, k)],
    ["POST", /^\/maintenance$/, (b, k) => app.scheduleMaintenance(b, k)],
    ["POST", /^\/routes$/, (b, k) => app.planRoute(b, k)],
    ["POST", /^\/routes\/([^/]+)\/approve$/, (b, k, m) => app.approveRoute(m[1], b, k)],
    ["POST", /^\/routes\/([^/]+)\/cancel$/, (b, k, m) => app.cancelRoute(m[1], b, k)],
    ["POST", /^\/routes\/([^/]+)\/legs\/(\d+)\/start$/, (b, k, m) => app.startLeg(m[1], Number(m[2]), b, k)],
    ["POST", /^\/routes\/([^/]+)\/legs\/(\d+)\/complete$/, (b, k, m) => app.completeLeg(m[1], Number(m[2]), b, k)],
    ["POST", /^\/locks$/, (b, k) => app.acquireLock(b, k)],
    ["POST", /^\/locks\/release$/, (b, k) => app.releaseLock(b, k)],
    ["POST", /^\/incidents$/, (b, k) => app.reportIncident(b, k)],
    ["POST", /^\/alternatives\/([^/]+)\/accept$/, (b, k, m) => app.acceptAlternative(m[1], b, k)],
    ["POST", /^\/recover$/, (b) => app.recover(b?.now)],
    ["GET", /^\/routes\/([^/]+)$/, (_b, _k, m) => app.getRoute(m[1])],
    ["GET", /^\/timeline$/, (_b, _k, _m, url) => app.timeline({ entity: url.searchParams.get("entity") ?? undefined })],
    ["GET", /^\/state$/, () => app.getState()],
  ];

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const match = routes.find(([method, pattern]) => method === request.method && pattern.test(url.pathname));
      if (!match) {
        response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "NOT_FOUND", message: "路由不存在" } }));
        return;
      }
      const body = request.method === "POST" ? await readBody(request) : {};
      const idempotencyKey = request.headers["idempotency-key"];
      const m = url.pathname.match(match[1]);
      const result = match[2](body, idempotencyKey, m, url);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (err) {
      if (err instanceof DomainError) {
        response.writeHead(ERROR_STATUS[err.code] ?? 400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: err.code, message: err.message, details: err.details ?? null } }));
        return;
      }
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "INTERNAL", message: "服务内部错误" } }));
    }
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const dataDir = process.env.DATA_DIR ?? "./data";
  createServer({ dataDir }).listen(8000, "127.0.0.1", () => {
    console.log(`巡展路由服务已启动: http://127.0.0.1:8000 （数据目录 ${dataDir}）`);
  });
}
