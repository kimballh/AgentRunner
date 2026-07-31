const TRANSIENT_ERROR_CODES = new Set([
  "40001",
  "40P01",
  "53000",
  "53100",
  "53200",
  "53300",
  "53400",
  "57P01",
  "57P02",
  "57P03",
  "57014",
  "55P03",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "EAI_AGAIN",
  "EBUSY",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EMFILE",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENFILE",
  "EPIPE",
  "ETIMEDOUT",
]);

const TRANSIENT_MESSAGE =
  /could not resolve host|connection (?:reset|refused|timed out)|failed to connect|network is unreachable|remote end hung up|unexpected disconnect|operation timed out|rpc failed|http 5\d\d|tls connection was non-properly terminated|temporary failure|temporarily unavailable|too many connections|the database system is (?:starting up|shutting down)|deadlock detected|could not serialize access|index\.lock|another git process/i;

export interface PreflightRetryOptions {
  retries: number;
  delayMs: number;
  onRetry?: (error: unknown, attempt: number, maxAttempts: number) => void;
}

export class PreflightError extends Error {
  readonly phase: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly transient: boolean;

  constructor(phase: string, attempt: number, maxAttempts: number, cause: unknown, transient: boolean) {
    super(`Preflight phase "${phase}" failed (attempt ${attempt}/${maxAttempts}): ${errorMessage(cause)}`, { cause });
    this.name = "PreflightError";
    this.phase = phase;
    this.attempt = attempt;
    this.maxAttempts = maxAttempts;
    this.transient = transient;
  }
}

export async function runPreflightPhase<T>(
  phase: string,
  operation: () => Promise<T>,
  options: PreflightRetryOptions,
): Promise<T> {
  const maxAttempts = options.retries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PreflightError) {
        throw error;
      }
      const transient = isTransientPreflightError(error);
      if (!transient || attempt === maxAttempts) {
        throw new PreflightError(phase, attempt, maxAttempts, error, transient);
      }
      options.onRetry?.(error, attempt, maxAttempts);
      if (options.delayMs > 0) {
        await delay(options.delayMs * attempt);
      }
    }
  }
  throw new Error("unreachable");
}

export function isTransientPreflightError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      if (typeof record.code === "string") {
        if (TRANSIENT_ERROR_CODES.has(record.code) || record.code.startsWith("08") || record.code.startsWith("53")) {
          return true;
        }
      }
      if (typeof record.message === "string" && TRANSIENT_MESSAGE.test(record.message)) {
        return true;
      }
      if (typeof record.stderr === "string" && TRANSIENT_MESSAGE.test(record.stderr)) {
        return true;
      }
      if (typeof record.setupLogs === "string" && TRANSIENT_MESSAGE.test(record.setupLogs)) {
        return true;
      }
      current = record.cause;
      continue;
    }
    if (TRANSIENT_MESSAGE.test(String(current))) {
      return true;
    }
    break;
  }
  return false;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
