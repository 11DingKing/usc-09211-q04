import {
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  appendFileSync,
  fsyncSync,
  renameSync,
  ftruncateSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

/** 按字节切行，报告每行结尾（含换行符）的绝对偏移，供残缺尾行截断使用。 */
async function* scanLines(filePath) {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  let carried = "";
  let offset = 0;
  for await (const chunk of stream) {
    carried += chunk;
    let nl;
    while ((nl = carried.indexOf("\n")) >= 0) {
      const raw = carried.slice(0, nl);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const end = offset + Buffer.byteLength(carried.slice(0, nl + 1));
      const start = offset;
      offset = end;
      carried = carried.slice(nl + 1);
      yield { line, start, end };
    }
  }
  if (carried.length > 0) {
    yield { line: carried, start: offset, end: offset + Buffer.byteLength(carried), unterminated: true };
  }
}

/**
 * 仅追加事件日志（JSONL）。
 * - 每条记录占一行 JSON：{ seq, eventTime, receivedAt, type, data, commandId? }
 * - eventTime 为业务事件时间（调用方提供或服务生成），receivedAt 为服务落盘时间，二者始终分离
 * - append 后 fsync，保证崩溃前已确认的命令在重启重放后仍在
 * - 日志从不原地修改：压缩（compaction）通过“写新文件再原子改名”完成
 */
export class EventStore {
  constructor(filePath, { now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.seq = 0;
    this.torn = false;
    mkdirSync(dirname(filePath), { recursive: true });
    this.fd = openSync(filePath, "a");
  }

  /**
   * 逐条重放日志，对每条完整记录调用 visitor(record)。
   * 崩溃写坏的尾部残行将被截断（截断后 fsync），此前的完整记录照常生效。
   */
  async replay(visitor) {
    if (!existsSync(this.filePath)) return;
    let lastGoodEnd = 0;
    for await (const { line, end, unterminated } of scanLines(this.filePath)) {
      let record;
      try {
        record = JSON.parse(line);
      } catch (err) {
        if (unterminated) {
          ftruncateSync(this.fd, lastGoodEnd);
          fsyncSync(this.fd);
          this.torn = true;
          return;
        }
        throw new Error(`事件日志第 ${end} 字节附近存在无法解析的记录`, { cause: err });
      }
      if (record.seq !== this.seq + 1) {
        throw new Error(`事件日志序号断裂：期望 ${this.seq + 1}，实际 ${record.seq}`);
      }
      this.seq = record.seq;
      lastGoodEnd = end;
      visitor(record);
    }
  }

  /**
   * 原子追加一组事件（同一命令产生的事件一起落盘）。
   * 返回写入的记录。调用方必须在串行队列内调用。
   */
  append(events, { commandId, eventTime } = {}) {
    const receivedAt = this.now();
    const records = events.map((event) => {
      const record = {
        seq: ++this.seq,
        eventTime: eventTime ?? receivedAt,
        receivedAt,
        type: event.type,
        data: event.data,
      };
      if (commandId) record.commandId = commandId;
      return record;
    });
    const payload = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    appendFileSync(this.fd, payload);
    fsyncSync(this.fd);
    return records;
  }

  /**
   * 用快照重写日志（原子改名）。仅用于明确的维护性压缩；
   * 业务审计记录的“不覆盖”由快照内容保证：快照事件保留原始 eventTime/receivedAt。
   */
  rewrite(records) {
    closeSync(this.fd);
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    const fd = openSync(tmp, "w");
    let seq = 0;
    appendFileSync(
      fd,
      records
        .map((r) => {
          const out = { ...r, seq: ++seq };
          return JSON.stringify(out);
        })
        .join("\n") + "\n",
    );
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, this.filePath);
    this.fd = openSync(this.filePath, "a");
    this.seq = seq;
  }

  size() {
    return existsSync(this.filePath) ? statSync(this.filePath).size : 0;
  }

  close() {
    closeSync(this.fd);
  }
}
