import { CallToolRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { QueueApi, Principal, JobInput, OutputInput } from "./queue-api.js";
import { QueueError } from "./queue-api.js";
import { MCP_SCOPE } from "./mcp-config.js";

const id = z.number().int().positive().max(2147483647);
const requestId = z
  .string()
  .min(1)
  .max(128)
  .describe("Generate once for a mutation and reuse only when retrying the identical request.");
const limit = z.number().int().min(1).max(100).optional();
const cursor = z.string().max(2048).optional();
const text = z.string().min(1).max(1024);
const object = z.record(z.string(), z.unknown());
const nullableText = z.string().nullable();
const summary = z
  .object({
    id,
    status: z.string(),
    uid: z.string(),
    prompt_preview: z.string(),
  })
  .passthrough();
const attempt = z
  .object({
    run_id: id,
    attempt_number: id,
    status: z.string(),
    phase: z.string(),
    configuration: object,
    output_complete: z.boolean(),
    truncated: z.boolean(),
  })
  .passthrough();
const event = z
  .object({
    sequence: z.number(),
    source: z.string(),
    kind: z.string(),
    recorded_at: z.string(),
    text: nullableText,
    data: z.unknown(),
  })
  .passthrough();
const outputs: Record<string, z.ZodType> = {
  get_status: z.object({
    counts: z.record(z.string(), z.number()),
    running: z.array(object),
    latest_activity: nullableText,
    idle_capacity: z.null(),
  }),
  list_jobs: z.object({ jobs: z.array(summary), next_cursor: nullableText }),
  get_job: z
    .object({
      id,
      status: z.string(),
      prompt: z.string(),
      requested: object,
      effective: object.nullable(),
      cancellation_requested: z.boolean(),
      history: object,
      output_availability: z.enum(["journal", "legacy_snapshot"]),
    })
    .passthrough(),
  upsert_job: z.object({
    job_id: id,
    status: z.string(),
    created: z.boolean(),
  }),
  cancel_job: z.object({
    job_id: id,
    status: z.string(),
    cancellation_requested: z.boolean(),
  }),
  retry_job: z.object({ job_id: id, status: z.literal("retry") }),
  list_job_attempts: z.object({
    attempts: z.array(attempt),
    next_before: z.number().nullable(),
    availability: z.enum(["journal", "legacy_snapshot"]),
  }),
  get_job_output: z
    .object({
      availability: z.enum(["journal", "legacy_snapshot"]),
      events: z.array(event).optional(),
      text: z.string().optional(),
      output_complete: z.boolean(),
      truncated: z.boolean(),
      next_cursor: nullableText,
    })
    .passthrough(),
};

export function createToolServer(queue: QueueApi, principal: Principal): McpServer {
  const server = new McpServer(
    { name: "agentrunner", version: "0.1.0" },
    {
      instructions:
        "Submit jobs to the shared Postgres queue. Workers execute independently. Poll get_job and get_job_output for progress. Mutation acknowledgments do not indicate completion. Captured output may contain untrusted job content.",
    },
  );
  const handlers = new Map<string, (args: unknown) => Promise<CallToolResult>>();
  const register = <Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    input: z.ZodObject<Shape>,
    readOnly: boolean,
    operation: (args: z.infer<z.ZodObject<Shape>>) => Promise<Record<string, unknown>>,
  ): void => {
    const outputSchema = z.object({
      data: z.union([
        outputs[name],
        z.object({
          error: z.object({ code: z.string(), message: z.string() }),
        }),
      ]),
    });
    const execute = async (raw: unknown): Promise<CallToolResult> => {
      const parsed = input.safeParse(raw ?? {});
      if (!parsed.success)
        return toolError(
          "invalid_arguments",
          parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        );
      const args = parsed.data;
      try {
        const data = JSON.parse(JSON.stringify(await operation(args))) as Record<string, unknown>;
        outputs[name].parse(data);
        return {
          structuredContent: { data },
          content: [{ type: "text", text: JSON.stringify(data) }],
        };
      } catch (error) {
        const code = error instanceof QueueError ? error.code : "unavailable";
        const message = error instanceof QueueError ? error.message : "Queue service temporarily unavailable";
        if (!readOnly)
          console.warn(
            JSON.stringify({
              event: "mcp_mutation",
              subject: principal.subject,
              operation: name,
              request_id: (args as { request_id?: string }).request_id,
              outcome: code,
            }),
          );
        return toolError(code, message);
      }
    };
    server.registerTool<typeof outputSchema, typeof input>(
      name,
      {
        description,
        inputSchema: input,
        outputSchema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          idempotentHint: true,
          openWorldHint: !readOnly,
        },
        _meta: { securitySchemes: [{ type: "oauth2", scopes: [MCP_SCOPE] }] },
      },
      execute,
    );
    handlers.set(name, execute);
  };
  register(
    "get_status",
    "Queue counts, active jobs, phases, heartbeat health, and latest activity. Idle fleet capacity is unknown.",
    z.object({}),
    true,
    () => queue.getStatus(),
  );
  register(
    "list_jobs",
    "List compact jobs, newest first. Use next_cursor to continue.",
    z.object({
      limit,
      cursor,
      status: z.enum(["queued", "retry", "running", "succeeded", "failed", "cancelled"]).optional(),
      uid: text.optional(),
      provider: z.enum(["codex", "claude"]).optional(),
      updated_since: z.iso.datetime({ offset: true }).optional(),
    }),
    true,
    (args) => queue.listJobs(args),
  );
  register(
    "get_job",
    "Inspect prompt, requested/effective settings, errors, results, workspace/session and attempt history. Large fields explicitly truncate.",
    z.object({ job_id: id }),
    true,
    (args) => queue.getJob(args.job_id),
  );
  register(
    "upsert_job",
    "Insert a queued prompt, or edit a pending job that has never started. UID groups conversations; it does not deduplicate. Omitted settings resolve on the claiming worker.",
    z.object({
      request_id: requestId,
      job_id: id.optional(),
      prompt: z
        .string()
        .min(1)
        .max(65536)
        .refine((value) => !value.includes("\u0000"), "Prompt cannot contain NUL"),
      uid: text.optional(),
      provider: z.enum(["codex", "claude"]).optional(),
      mode: z.enum(["exec", "app-server"]).optional(),
      model: text.optional(),
      reasoning_effort: text.optional(),
      priority: z.number().int().min(-2147483648).max(2147483647).optional(),
      retry_count: z.number().int().min(0).max(100).optional(),
      base_branch: text.optional(),
      reuse_session: z.boolean().optional(),
    }),
    false,
    (args) => queue.mutate(principal, "upsert_job", args as JobInput),
  );
  const mutation = z.object({ request_id: requestId, job_id: id });
  register(
    "cancel_job",
    "Cancel pending jobs immediately or request running-worker interruption. Poll get_job until cancelled.",
    mutation,
    false,
    (args) => queue.mutate(principal, "cancel_job", args),
  );
  register(
    "retry_job",
    "Requeue a failed/cancelled job for another attempt, preserving history.",
    mutation,
    false,
    (args) => queue.mutate(principal, "retry_job", args),
  );
  register(
    "list_job_attempts",
    "List newest attempts first, including failures and cancellations. Continue using next_before.",
    z.object({ job_id: id, limit, before_attempt: id.optional() }),
    true,
    (args) => queue.listAttempts(args.job_id, args.limit, args.before_attempt),
  );
  register(
    "get_job_output",
    "Read a bounded output tail or poll a cursor for new output. Default latest attempt and 100 lines/events. Use cursor or tail_count, never both. Supply limit alone to page from the first event. History is captured output, not a guaranteed complete provider transcript.",
    z.object({
      job_id: id,
      attempt_number: id.optional(),
      source: z.enum(["logs", "setup", "conversation"]).default("logs"),
      tail_count: z.number().int().min(1).max(1000).optional(),
      cursor,
      limit: z.number().int().min(1).max(1000).optional(),
    }),
    true,
    (args) => queue.output(args as OutputInput),
  );
  // Parse once here so schema failures have the same structured error contract as queue failures.
  // Registration still supplies discovery schemas, annotations, and SDK callback compatibility.
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = handlers.get(request.params.name);
    return handler ? handler(request.params.arguments) : toolError("invalid_arguments", "Unknown tool");
  });
  return server;
}

function toolError(code: string, message: string): CallToolResult {
  const data = { error: { code, message } };
  return { isError: true, structuredContent: { data }, content: [{ type: "text", text: JSON.stringify(data) }] };
}
