import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { redactSecrets, redactValue } from "./redact.js";

describe("secret redaction", () => {
  test("redacts assignments with prefixes and adjacent punctuation", () => {
    expect(redactSecrets("(APP_API_KEY=hidden) MY_TOKEN=secret DATABASE_URL=postgres://user:pass@db/name"))
      .toBe("(APP_API_KEY=[REDACTED] MY_TOKEN=[REDACTED] DATABASE_URL=[REDACTED]");
  });

  test("preserves ordinary text and redacts other secret formats", () => {
    expect(redactSecrets('hello {"APP_API_KEY": "hidden"} Bearer abc.def postgres://user:pass@db/name'))
      .toBe('hello {"APP_API_KEY": "[REDACTED]"} Bearer [REDACTED] postgres://user:[REDACTED]@db/name');
    expect(redactValue({ access_token: "hidden", nested: ["APP_SECRET=hidden"] }))
      .toEqual({ access_token: "[REDACTED]", nested: ["APP_SECRET=[REDACTED]"] });
  });

  test("scans large unbroken output within a bounded process deadline", () => {
    // A separate process makes the deadline effective even if a synchronous
    // regex blocks the event loop, as happened while recovering completion 3956.
    const source = new URL("./redact.ts", import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import { redactSecrets } from ${JSON.stringify(source)};
      const output = 'A'.repeat(600_000);
      assert.equal(redactSecrets(output), output);
      assert.equal(redactSecrets(output + '_API_KEY=hidden'), output + '_API_KEY=[REDACTED]');
      assert.equal(redactSecrets(output + '\\nMY_TOKEN=hidden'), output + '\\nMY_TOKEN=[REDACTED]');
    `;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 5000 });
  });
});
