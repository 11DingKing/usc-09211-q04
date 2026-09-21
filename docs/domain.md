# 港澳科普巡展路由领域约定

服务采用事件时间与接收时间分离的记录方式。所有业务身份由调用方提供的稳定标识表示，审计记录不得以覆盖方式修改。

## 核心不变量

1. **不双重承诺**：同一展具、同一讲解员在重叠时间窗内只能服务一个活动；跨境相邻排期之间必须满足配置的运输缓冲（HK↔MO 默认由命令配置）。
2. **承诺分级**：`held`（未批准占位）可被**严格更高优先级**（priority 数值更小）的新请求挤落；`approved`（已批准路线）在任何情况下不可被抢占。挤落只发生在同一命令的规划草稿内，且必须先释放被挤落者、再尝试在**同一时间窗**重规划；重规划失败则显式 `blocked`，系统不会静默改期。
3. **损坏可追溯**：展具损坏立即退出可用池，系统对每个受影响活动按能力与场馆条件寻找替代，逐跳记录 `ExhibitReassigned`（含剩余时段窗口、是否途中替代）；无替代则 `SubstitutionFailed` 并阻断活动，`SubstitutionChainFinished` 汇总受影响学校与责任边界。
4. **时区规则**：场馆各自带 IANA 时区（香港 `Asia/Hong_Kong`、澳门 `Asia/Macau`），跨日、每周闭馆、节假日、开放时段一律按场馆本地日历判定；跨日活动经过的每一天都必须是开放日。
5. **重启续跑**：状态完全由仅追加事件日志重放得到；已批准路线、幂等记忆在重启后仍然有效。日志尾部残缺行（崩溃写一半）重放时安全截断。

## 身份与优先级

- 场馆 `kind: "venue" | "school"`；学校借展通过活动上的 `schoolId` 或场馆本身为 school 体现。
- 展具有能力标签（如 `core`、`planetarium`）、环境要求（如 `power-3kw`、`darkroom`）与 `homeRegion`；场馆有提供能力 `capabilities` 与准入要求 `requiredCapabilities`。
- 讲解员有资质 `qualifications` 与可服务地区 `regions`；休假窗口与跨区缓冲同样参与冲突判定。
- `priority` 为整数，**数值越小优先级越高**；同优先级不可互相挤落。

## 命令目录

| 命令 | 说明 |
| --- | --- |
| `RegisterVenue` | 注册场馆/学校（region、时区、能力、日历） |
| `UpdateVenueCalendar` | 更新节假日、每周闭馆日、开放时段 |
| `RegisterExhibit` | 注册展具（序列、能力、环境要求、属地） |
| `RegisterGuide` | 注册讲解员（资质、地区） |
| `ConfigureTravelBuffer` | 配置两地间运输缓冲小时数 |
| `ScheduleMaintenance` / `ScheduleGuideLeave` | 维护停用 / 讲解员休假 |
| `RequestActivity` | 申请活动并整体分配（可挤落低优先级占位） |
| `ApproveAllocation` / `ReleaseAllocation` | 批准 / 释放承诺 |
| `ReportDamage` | 上报损坏，触发替代链 |
| `RepairExhibit` | 修复归队 |

所有命令可带调用方稳定 `commandId`（幂等键）与 `occurredAt`（业务事件时间）。

## 事件与时间线

事件仅追加落盘（JSONL，每行一条，顺序号 `seq`），关键字段：

- `eventTime`：业务事件时间（命令 `occurredAt` 或处理时刻）
- `receivedAt`：服务落盘时间
- `commandId`：造成该事件的命令（用于对账与幂等）
- `type` / `data`：事件类型与载荷

`GET /timeline?activityId=...` 给出活动相关的完整事件序列，可据以还原每次改派的原因、责任方（`responsibility`）与受影响学校。

## 活动生命周期

```
requested → held ──approve──→ approved ──release──→ released
              │                    │
              │ 被高优先级挤落      │ 损坏无替代
              ▼                    ▼
        displaced → held      blocked
                    └→ blocked
损坏替代不改变生命周期状态，只改派具体展具（approved 活动仍为 approved）。
```
