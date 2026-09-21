import { randomUUID } from "node:crypto";

/**
 * 统一的身份生成入口。所有身份均为调用方可见的稳定标识：
 * 调用方可在命令中自带 ID（跨系统对账），未提供时以前缀 + UUID 兜底。
 */
export const newId = (prefix) => `${prefix}_${randomUUID()}`;
