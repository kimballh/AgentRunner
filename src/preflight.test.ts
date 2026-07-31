import { describe, expect, test, vi } from "vitest";
import { PreflightError, runPreflightPhase } from "./preflight.js";

describe("runPreflightPhase", () => {
  test("retries transient failures and then succeeds", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }))
      .mockRejectedValueOnce(Object.assign(new Error("database starting"), { code: "57P03" }))
      .mockResolvedValue("ok");
    const onRetry = vi.fn();

    await expect(
      runPreflightPhase("load cleanup candidates (database)", operation, {
        retries: 2,
        delayMs: 0,
        onRetry,
      }),
    ).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  test("does not retry deterministic failures and records the phase", async () => {
    const cause = Object.assign(new Error("permission denied"), { code: "42501", detail: "table agent_runs" });
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(cause);

    const failure = await runPreflightPhase("load cleanup candidates (database)", operation, {
      retries: 2,
      delayMs: 0,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PreflightError);
    expect(failure).toMatchObject({
      phase: "load cleanup candidates (database)",
      attempt: 1,
      maxAttempts: 3,
      transient: false,
      cause,
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
