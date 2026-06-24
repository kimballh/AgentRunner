import { describe, expect, test } from "vitest";
import { parseExecThreadId, threadUrl } from "./codex.js";

describe("codex executor helpers", () => {
  test("extracts thread id from codex JSONL", () => {
    const stdout = ['{"type":"noise"}', '{"type":"thread.started","thread_id":"019-thread"}'].join("\n");
    expect(parseExecThreadId(stdout)).toBe("019-thread");
  });

  test("builds codex thread URLs", () => {
    expect(threadUrl("thread with spaces")).toBe("codex://threads/thread%20with%20spaces");
  });
});
