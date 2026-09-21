import { createApp } from "./http/app.mjs";

const PORT = Number(process.env.PORT ?? 8000);
const HOST = process.env.HOST ?? "127.0.0.1";
const STORE_FILE = process.env.STORE_FILE ?? "data/events.jsonl";

const { server, store } = await createApp({ storeFile: STORE_FILE });

server.listen(PORT, HOST, () => {
  console.log(`巡展路由服务已启动：http://${HOST}:${PORT}（事件日志 ${STORE_FILE}）`);
});

const shutdown = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
