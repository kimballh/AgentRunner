import { describe, expect, test } from "vitest";
import { runProcess } from "./process.js";

describe("runProcess cancellation", () => {
  test("sends SIGTERM and retains partial output", async () => {
    const controller = new AbortController();
    const resultPromise = runProcess(
      [
        process.execPath,
        "-e",
        `process.on("SIGTERM", () => {
          process.stdout.write("terminated gracefully");
          process.exit(0);
        });
        setInterval(() => undefined, 1000);`,
      ],
      { cwd: process.cwd(), signal: controller.signal, terminationGraceMs: 500 },
    );

    setTimeout(() => controller.abort(), 100);
    const result = await resultPromise;

    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("terminated gracefully");
  });

  test("escalates to SIGKILL after the grace period", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const resultPromise = runProcess(
      [process.execPath, "-e", `process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000);`],
      { cwd: process.cwd(), signal: controller.signal, terminationGraceMs: 50 },
    );

    setTimeout(() => controller.abort(), 100);
    const result = await resultPromise;

    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("does not spawn when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runProcess([process.execPath, "-e", `process.stdout.write("unexpected");`], {
      cwd: process.cwd(),
      signal: controller.signal,
    });

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 1, aborted: true });
  });
});
