import { describe, expect, test } from "vitest";
import { PreflightError } from "./preflight.js";
import { CommandError } from "./process.js";
import { errorToJson, sanitizePostgresText, stringifyPostgresJson } from "./store.js";

describe("errorToJson", () => {
  test("preserves an already structured error instead of stringifying it", () => {
    expect(errorToJson({ message: "agent exited", exitCode: 7 })).toEqual({
      message: "agent exited",
      exitCode: 7,
    });
  });

  test("preserves preflight phase and command stderr through the cause chain", () => {
    const commandError = new CommandError(
      "fetch failed",
      "fetch base branch",
      ["git", "fetch", "origin"],
      "/repo",
      128,
      "",
      "fatal: unable to access remote: connection reset",
    );
    const error = new PreflightError("fetch Git base branch", 3, 3, commandError, true);

    expect(errorToJson(error)).toMatchObject({
      message: expect.stringContaining('Preflight phase "fetch Git base branch" failed'),
      phase: "fetch Git base branch",
      attempt: 3,
      maxAttempts: 3,
      transient: true,
      cause: {
        name: "CommandError",
        label: "fetch base branch",
        command: ["git", "fetch", "origin"],
        exitCode: 128,
        stdout: "",
        stderr: "fatal: unable to access remote: connection reset",
      },
    });
  });
});

describe("Postgres persistence sanitization", () => {
  test("replaces NUL characters in text values", () => {
    expect(sanitizePostgresText("before\u0000after")).toBe("before\ufffdafter");
  });

  test("replaces NUL characters in JSON keys and nested values", () => {
    const serialized = stringifyPostgresJson({
      "key\u0000name": { aggregatedOutput: "user@example.com\u0000secret" },
    });

    expect(JSON.parse(serialized)).toEqual({
      "key\ufffdname": { aggregatedOutput: "user@example.com\ufffdsecret" },
    });
  });

  test("preserves literal Unicode escape text", () => {
    const serialized = stringifyPostgresJson({ output: String.raw`before\u0000after` });

    expect(JSON.parse(serialized)).toEqual({ output: String.raw`before\u0000after` });
  });
});
