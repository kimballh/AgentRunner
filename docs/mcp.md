# AgentRunner remote MCP

`agentrunner mcp` exposes the existing Postgres queue at `/mcp`, using Streamable HTTP. It starts no workers. Keep `agentrunner run` running separately; any worker connected to the queue can execute submitted jobs. Access authorizes prompt execution under those workers' existing provider permissions.

## Start locally

```sh
npm install
npm run build
agentrunner setup-db
agentrunner run
# In another terminal, after the OAuth configuration below:
agentrunner mcp
# Override only the MCP listener's port:
agentrunner mcp --port 9999
```

Apply additive migrations **without `--force`**. Upgrade every worker before relying on live capture. Older jobs/workers return saved output labeled `legacy_snapshot`. No old transcripts or attempt history are backfilled. MCP startup validates the queue and companion tables without checking provider binaries.

```toml
[mcp]
host = "127.0.0.1"
port = 8888
public_url = "https://YOUR-STABLE-NGROK-DOMAIN/mcp"
allowed_origins = []
submissions_per_minute = 30
max_pending_jobs = 1000

[mcp.oauth]
issuer = "https://YOUR-TENANT.auth0.com/"
audience = "https://YOUR-STABLE-NGROK-DOMAIN/mcp"
allowed_subjects = ["auth0|YOUR-USER-ID"]
```

The public URL is required, must use HTTPS, must end in `/mcp` without a trailing slash, and must exactly equal the API audience. The issuer includes its trailing slash. OAuth applies to loopback requests too.

CLI flags override environment, then TOML, then defaults. `--host`, `--port`, and `--public-url` affect only MCP. The existing dashboard's host and port settings remain separate. These environment variables are supported:

| Variable | Default |
| --- | --- |
| `AGENTRUNNER_MCP_HOST` | `127.0.0.1` |
| `AGENTRUNNER_MCP_PORT` | `8888` |
| `AGENTRUNNER_MCP_PUBLIC_URL` | Required |
| `AGENTRUNNER_MCP_OAUTH_ISSUER` | Required |
| `AGENTRUNNER_MCP_OAUTH_AUDIENCE` | Required |
| `AGENTRUNNER_MCP_OAUTH_ALLOWED_SUBJECTS` | Required; comma or whitespace separated |
| `AGENTRUNNER_MCP_ALLOWED_ORIGINS` | Empty; comma or whitespace separated |
| `AGENTRUNNER_MCP_SUBMISSIONS_PER_MINUTE` | `30` |
| `AGENTRUNNER_MCP_MAX_PENDING_JOBS` | `1000` |
| `AGENTRUNNER_OUTPUT_MAX_BYTES` | `33554432` per attempt |

`output_max_bytes` is a top-level TOML option used by workers. History remains in Postgres until removed through database administration. Normal queue-row deletion cascades to its attempt/event history; request receipts remain with a null job reference.

## Auth0 setup

1. Create an API with its Identifier equal to the public MCP URL above. Select RS256 and the **RFC 9068** access-token profile (`typ: at+jwt`). Set access-token expiration to **900 seconds**. Add the permission `agentrunner:access`.
2. In tenant advanced settings enable **Resource Parameter Compatibility Profile**. This makes the standard MCP `resource` parameter select the intended API audience. Leave the tenant-wide Default Audience unchanged. [Auth0's MCP audience guidance](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0).
3. Enable **Dynamic Client Registration (DCR)** in Auth0 tenant advanced settings, using enhanced third-party security controls. Auth0's authorization-server discovery advertises its `/oidc/register` endpoint. Compatible clients register their own application and exact redirect URI, then use authorization code with PKCE S256 and user consent. AgentRunner implements no registration endpoint or OAuth proxy. [Auth0 DCR configuration](https://auth0.com/docs/get-started/applications/dynamic-client-registration).
4. Promote the owner's login connection to domain level for third-party clients. On this API, configure **Default Permissions for Third Party Apps → User-Delegated Access** as authorized for only `agentrunner:access`, so newly registered clients can request this API permission. Leave machine-to-machine **Client Access** unauthorized. Enable offline access for refresh-capable clients. Clients request `agentrunner:access` plus their identity/refresh scopes; if Auth0 RBAC is enabled, assign this permission to the owner. [Auth0 third-party application configuration](https://auth0.com/docs/get-started/applications/third-party-applications/configure-third-party-applications).
5. Copy the owner's exact Auth0 **User ID / `sub`** into `allowed_subjects`. Use the subject for the connection you sign in with; social and database identities can differ. Configure MFA for that account.
6. In each client's connector settings enter the public `/mcp` URL and select automatic OAuth/DCR where supported. The client stores its dynamically issued credentials and tokens. AgentRunner stores neither application secrets nor Auth0 Management API credentials. Registration permits a client to start OAuth; queue access still requires the allowlisted owner's scoped API access token.

To avoid DCR application growth, or for a client without DCR support, pre-register a separate OAuth application with authorization code and PKCE S256, its supported token endpoint authentication method, exact callback URLs, and the same user-delegated API permission. Supply that fixed client ID and, for confidential clients, secret in the connector's OAuth settings. Reuse the application across reconnects. Public clients use no secret. Once all connectors work with fixed credentials, DCR can be disabled.

DCR creates an application before user login, so a later login denial does not remove the registration. Auth0 Free tenants have a limit of 10 applications; self-service paid tenants have a limit of 100. Repeated connector additions can consume those slots. Remove only confirmed-unused registrations, since deleting an active client breaks its connection. [Auth0 entity limits](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/entity-limit-policy).

Enable offline access on the API, the refresh-token grant on each application, and request `offline_access` to renew short-lived access tokens automatically. Configure refresh-token rotation and maximum/idle lifetimes for each application's needs; those lifetimes, rather than the API's 15-minute access-token lifetime, determine when login is required again. Maximum family lifetime does not restart on rotation. [Auth0 refresh-token expiration](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-expiration).

Clients discover Auth0 through `/.well-known/oauth-protected-resource/mcp` or its root alias. Unauthenticated MCP requests return a `WWW-Authenticate` challenge containing the discovery URL and scope. Auth0 supplies its own authorization-server discovery, consent, login, and tokens. [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

Every MCP request validates signature, RS256, issuer, audience, expiration, access-token type, scope, and exact subject against cached JWKS. ID tokens, opaque credentials, and tokens supplied in URLs are rejected. Unknown/unverifiable keys fail closed. Signed-in users outside the allowlist receive 403 even if Auth0 issued a valid API token.

To revoke access immediately, remove the subject and restart MCP. Revoking refresh tokens prevents renewal; already issued access tokens otherwise work until expiration. On a JWKS outage, already cached signing keys can still validate tokens; uncached/unverifiable keys cannot.

### Reject unauthorized accounts during connection

The MCP process can reject API requests, but Auth0 controls the login and token-issuance steps. To reject unauthorized accounts before OAuth completes:

1. Create a custom Auth0 **Post Login** Action using [mcp-allowlist.cjs](auth0/mcp-allowlist.cjs). Replace `MCP_RESOURCE` with the exact public `/mcp` URL.
2. Add the Action secret `MCP_ALLOWED_SUBJECTS` as a JSON array containing the same exact subjects as `mcp.oauth.allowed_subjects`, for example `["auth0|YOUR-USER-ID"]`.
3. Deploy the Action and add it to **Actions → Triggers → Post Login**, before other Actions; apply the flow. Preserve existing Actions.
4. Test a fresh owner connection and a non-allowlisted account. The latter must receive an OAuth access-denied error before an MCP token is issued. DCR registration itself can still succeed; registration does not authorize the user.

The Action scopes the check to this API's audience, preserving other tenant logins. It also runs during refresh-token exchanges. Keep both allowlists synchronized when adding/removing users. Existing access tokens are still checked by the MCP server on every request; the Action does not retroactively revoke them. Client wording for a denied connection varies, and Auth0's third-party redirect protection may display the error on the Auth0 page. [Auth0 Post Login trigger](https://auth0.com/docs/customize/actions/explore-triggers/post-login), [deny access API](https://auth0.com/docs/actions/reference/post-login/post-login-api-object#api-access-deny-reason).

### Cursor and Grok Bot

Choose automatic registration or fixed credentials according to the client's capabilities. For a Cursor client using static OAuth credentials, request the API scope explicitly: Auth0's authorization-server discovery advertises generic identity scopes, rather than this API's custom permission. An optional static-client `mcp.json` entry can use:

```json
{
  "mcpServers": {
    "agentrunner": {
      "url": "https://YOUR-STABLE-NGROK-DOMAIN/mcp",
      "auth": {
        "CLIENT_ID": "YOUR-CLIENT-ID",
        "CLIENT_SECRET": "${env:AGENTRUNNER_OAUTH_CLIENT_SECRET}",
        "scopes": ["agentrunner:access", "offline_access"]
      }
    }
  }
}
```

For static clients, use the equivalent explicit scope setting in Grok Bot's connector registration and register the exact redirect URI the client sends. Cursor documents `http://localhost:8787/callback` for desktop and `https://www.cursor.com/agents/mcp/oauth/callback` for web/Agents; enable only the callbacks used by that application. DCR clients register their redirect URIs automatically. [Cursor MCP documentation](https://cursor.com/docs/mcp).

If login says connected but no tools load, inspect the MCP HTTP rejection and Auth0 exchange logs:

| Rejection reason | Correction |
| --- | --- |
| `invalid_access_token_type` | Select **RFC 9068** on the Auth0 API, save, and reconnect to obtain a new access token. Existing Auth0-profile tokens remain invalid. Do not send an ID token. |
| `wrong_audience` | Verify the resource-parameter compatibility setting and that the requested API audience exactly equals the public `/mcp` URL. |
| `wrong_issuer` | Use the issuer from Auth0 discovery, including its trailing slash. |
| `missing_scope` | Explicitly request `agentrunner:access`; check the application's user-delegated API grant and owner permission when RBAC is enabled. |
| `subject_not_allowed` | Sign in with the allowlisted identity; verify the exact social/database subject. |
| `token_expired` | Refresh the access token or reconnect. |
| `signing_keys_unavailable` | Restore issuer/JWKS connectivity; validation fails closed. |

The response and `WWW-Authenticate` challenge include a safe explanation. Requests containing credentials that fail authentication also log only the status and a fixed reason; no token, authorization header, prompt, or output is logged. A bare unauthenticated 401 proves reachability, not successful OAuth. Successful Auth0 code exchange proves token issuance, not that the resource server accepted the token or loaded tools.

## ngrok

Use a stable HTTPS ngrok domain so the resource identifier does not change on restart. Expose **the MCP listener port**, not the dashboard:

```sh
ngrok http 8888 --url=https://YOUR-STABLE-NGROK-DOMAIN --inspect=false
```

Use the installed ngrok CLI's equivalent stable-domain option if its version differs. Disable cloud traffic body/header capture as well. Tokens and job output must not be recorded by a traffic inspector.

The listener accepts the configured public host and local listener hosts. Explicit browser origins must match the public origin or `allowed_origins`; requests without an Origin header are supported. Public URLs always come from configuration, never forwarded headers. Discovery contains no queue data or credentials. Only `/mcp` serves authenticated queue tools; this listener has no dashboard routes.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_status` | Counts by status, up to 100 running jobs, phase, worker host, heartbeat age/staleness, latest activity; idle fleet capacity is unknown. |
| `list_jobs` | Compact newest-first list. Filters: `status`, `uid`, `provider`, `updated_since`. Use `cursor` returned as `next_cursor`; `limit` defaults to 25, maximum 100. |
| `get_job` | Prompt, requested/effective configuration, errors/results, cancellation, workspace/session and attempt summary. Oversized fields carry truncation flags. |
| `upsert_job` | Insert a queued prompt, or edit a pending job with zero attempts using `job_id`. Optional UID, provider, mode, model, reasoning effort, priority, retry count, base branch and session reuse. |
| `cancel_job` | Cancel queued/retry jobs immediately; request running-worker interruption. Repeated cancellation is harmless. |
| `retry_job` | Requeue a failed/cancelled job, extending its allowance for one additional attempt and preserving history. |
| `list_job_attempts` | Latest attempts first; default 25, maximum 100. Continue with `before_attempt` from `next_before`. |
| `get_job_output` | Latest or explicit `attempt_number`. Select `source`: `logs` (default), `setup`, or `conversation`. Default tail: 100 lines/events, maximum 1000 and 64 KiB per response. |

Every tool has JSON schemas and structured output under `structuredContent.data`, with matching text JSON. Tool failures set `isError` and expose `error.code` / `error.message`; queue failures do not disclose database connection information.

### Submission and replay

```json
{
  "request_id": "unique-request-id-generated-once",
  "prompt": "Run the test suite and summarize failures",
  "uid": "my-conversation",
  "provider": "codex",
  "priority": 10,
  "retry_count": 1
}
```

All mutations require `request_id`. Reuse that ID only when retrying **identical arguments to the same tool** after an uncertain response. The receipt and queue write commit together, so repeated delivery returns the original acknowledgment even after restarting MCP. Reusing an ID with different arguments returns `conflict`. Generate a fresh ID for a new action.

UID groups related conversations and session reuse. It does not deduplicate jobs. Omitted settings remain unresolved until the claiming worker applies its own defaults. Each subject can submit/upsert 30 times per minute by default; successful replay does not consume another admission. MCP insertions transactionally enforce the pending queue cap; other existing queue producers remain independent.

A successful mutation acknowledges a queue change, not execution or completion. `upsert_job` updates only supplied fields and refuses edits once any attempt has started. A missing explicit job ID is an error, not an insertion. Prompts are limited to 64 KiB and HTTP bodies to 1 MiB. Tool codes include `not_found`, `invalid_state`, `invalid_arguments`, `conflict`, `rate_limited`, `queue_full`, and `unavailable`.

### Poll progress

1. Submit and retain the returned `job_id`.
2. Poll `get_job` for status and phase. Cancellation returns `cancellation_requested: true` while the underlying status can still be `running`.
3. Fetch `get_job_output` with a tail count. Pass `limit` alone to start at the first event and page through the complete captured history. Pass `next_cursor` on subsequent calls to retrieve following/new events; omit `tail_count` when using a cursor. Cursors are specific to job, source and attempt; when a retry starts, start a fresh tail for that attempt.
4. Inspect older attempts explicitly. Output completion means captured output was flushed; `truncated` can still be true. History represents captured provider events, not a guaranteed complete/restorable native transcript.

Workers flush journal events at least once per second and check cancellation every second. Process groups receive SIGTERM, followed by SIGKILL after five seconds when necessary. Stopping MCP does not cancel jobs. Stopping a worker interrupts active execution and records failure/retry separately from user cancellation. A crash leaves an incomplete attempt closed by the existing stale-lease recovery on worker startup.

Captures redact recognized environment credentials, bearer tokens, JSON credential fields and database passwords, including values split across process chunks. Submitted prompts remain the execution input. Redaction is best effort; authorized users can still encounter sensitive content written by jobs. Output is capped per attempt and truncation is explicit. Persistent recorder failures or an excessive pending backlog abort execution; database outages can leave a lease for recovery.

## Verification and rollout

Automated checks use an isolated Postgres schema, fake providers and signed test tokens:

```sh
npm run check
npm run build
TEST_DATABASE_URL=postgres://127.0.0.1:5432/TEST_DATABASE npm test
```

The database must be disposable or dedicated to tests. Tests create/drop their own schemas. Without `TEST_DATABASE_URL`, database acceptance tests are skipped.

After migrations and worker upgrades, verify each real client independently:

- Sign in as the allowlisted owner, discover all eight tools, submit a harmless prompt, and read the resulting queue row.
- Read live output before completion; cancel a running test job, retry it, and inspect both attempts.
- Restart MCP and replay a submission request ID; confirm the job ID remains unchanged.
- Test without a token, with an expired token, and with a second non-allowlisted Auth0 account. These must never expose queue tools/data.
- Confirm ngrok capture is off and the dashboard is not exposed.

Passing local fixtures verifies protocol and queue behavior. Actual ChatGPT, Claude, Grok Bot, Auth0 login, refresh and ngrok connectivity require these separate live acceptance checks.
