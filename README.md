# 港澳科普巡展路由

面向港澳两地科普巡展的协调服务：把展具序列、运输缓冲、场馆条件、人员资质与活动优先级纳入统一决策，替代人工排期。

## 运行

```bash
npm test          # 运行全部测试
npm start         # 启动服务（默认 127.0.0.1:8000，数据目录 ./data，可用 DATA_DIR 覆盖）
```

## 能力概览

- **统一排期**：路线由若干航段组成，校验展具位置与状态、维护停用窗口、航段间运输缓冲、布展时间、场馆条件（承重/恒温等）、讲解员资质与节假日规则。
- **锁定与释放**：所有变更命令强制幂等键（HTTP 头 `Idempotency-Key`），重复提交返回首个响应；锁带 fencing token 与过期时间，批准路线时原子锁定全部资源，冲突即整体失败；高优先级路线可抢占尚未出发的低优先级路线并留痕。
- **事故替代**：途中损坏上报后，系统标记展具停用、释放其锁，为受影响活动生成可追溯的替代方案（替换展具或显式改期），绝不静默改期。
- **时区规则**：跨日与节假日规则按各场馆时区（如 `Asia/Hong_Kong`、`Asia/Macau`）的本地日期计算。
- **重启恢复**：状态由追加式事件日志重建，重启后已批准路线继续执行，`POST /recover` 清理过期锁并列出待执行动作。
- **时间线**：`GET /timeline?entity=<id>` 按实体（路线、展具、活动、`school:<学校id>` 等）查看每次改派的原因、责任方与受影响学校。

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/venues` `/exhibits` `/docents` `/events` `/maintenance` | 登记场馆/展具/讲解员/活动/维护窗口 |
| POST | `/routes` | 计划路线（返回冲突警告） |
| POST | `/routes/:id/approve` | 批准路线（原子锁定，可带 `expectedVersion`） |
| POST | `/routes/:id/legs/:n/start` `/complete` | 执行航段 |
| POST | `/routes/:id/cancel` | 取消未出发路线 |
| POST | `/locks` `/locks/release` | 运营手工锁 |
| POST | `/incidents` | 上报途中损坏，生成替代方案 |
| POST | `/alternatives/:id/accept` | 接受替代方案（可附 `rescheduledWindows`） |
| POST | `/recover` | 重启恢复扫描 |
| GET | `/routes/:id` `/timeline` `/state` `/health` | 查询 |

错误以结构化 JSON 返回（`error.code` / `message` / `details`），冲突类为 409，参数类为 400，不存在为 404。
