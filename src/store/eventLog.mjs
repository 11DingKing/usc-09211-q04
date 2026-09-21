import fs from "node:fs";
import path from "node:path";

/**
 * 追加式事件日志：事件只追加、不覆盖。
 * dir 为 null 时使用内存实现（测试与临时运行）。
 */
export class EventLog {
  #file;
  #buffer = null;

  constructor(dir) {
    if (dir === null) {
      this.#file = null;
      this.#buffer = [];
    } else {
      this.#file = path.join(dir, "events.jsonl");
    }
  }

  static open(dir) {
    if (dir !== null) fs.mkdirSync(dir, { recursive: true });
    return new EventLog(dir);
  }

  appendAll(events) {
    if (events.length === 0) return;
    if (this.#buffer) {
      this.#buffer.push(...events);
      return;
    }
    fs.appendFileSync(this.#file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  }

  readAll() {
    if (this.#buffer) return [...this.#buffer];
    if (!fs.existsSync(this.#file)) return [];
    return fs
      .readFileSync(this.#file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}
