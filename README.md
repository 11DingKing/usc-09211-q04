# 港澳科普巡展路由

面向香港（香江）与澳门（濠江）多机构协作的巡展排期协调服务：统一决策展具序列、跨境运输缓冲、场馆条件、讲解员资质与活动优先级，提供抗并发的锁定/释放、可追溯的损坏替代、场馆时区日历以及重启后续跑能力。

- 纯 Node.js（>=20）、零依赖，ESM + 内置 `node:test`
- 事件溯源：仅追加 JSONL 日志，事件时间/接收时间分离，审计记录不覆盖
- 命令串行执行 + 调用方幂等键，杜绝重复请求与并发竞争导致的双重承诺

## 运行

```bash
npm test          # 全部测试（29 个）
npm start         # 启动服务，默认 127.0.0.1:8000，日志 data/events.jsonl
```

环境变量：`PORT`、`HOST`、`STORE_FILE`。

## HTTP API

| 方法/路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查 |
| `POST /commands` | 提交命令（JSON；可带 `commandId` 幂等键、`occurredAt` 事件时间） |
| `GET /routes` | 全部活动路线 |
| `GET /activities/:id` | 活动详情（占用、状态、阻断原因、受影响学校） |
| `GET /incidents/:id` | 损坏事件与替代链（责任边界、影响学校） |
| `GET /timeline?activityId=...` | 审计时间线（`eventTime` / `receivedAt` 分列） |

完整命令目录与领域规则见 [`docs/domain.md`](docs/domain.md)，端到端示例见 [`examples/demo.mjs`](examples/demo.mjs)。

## 快速示例

```bash
curl -s localhost:8000/commands -H 'content-type: application/json' -d '{
  "type": "RegisterVenue",
  "id": "v-hk", "region": "HK",
  "capabilities": ["power-3kw"]
}'
```

## 代码结构

```
src/domain/
  ids.mjs        稳定身份
  timezone.mjs   场馆时区日历（跨日/节假日/开放时段）
  store.mjs      仅追加事件日志（fsync、残行截断、原子压缩）
  engine.mjs     事件 reduce 投影与冲突检查（承诺、缓冲、维护、休假）
  router.mjs     串行命令队列、幂等、规划器、挤落重规划、损坏替代链
src/http/app.mjs HTTP 适配层
```
