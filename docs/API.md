# dockflow-services — API Reference

Shared REST API over the existing company DockFlow Receiving Records and Power Tool PostgreSQL data.

- **Local base URL:** `http://localhost:5230`; production uses your approved reachable HTTPS proxy URL.
- **Version prefix:** `/api/v1`
- **Format:** JSON; health checks use GET, repository operations use POST.
- **Interactive docs:** `/docs/`; spec at `/openapi.json` / `/openapi.yaml`.
- **Contract:** [`src/openapi/openapi.yaml`](../src/openapi/openapi.yaml).

## Contents

- [Conventions](#conventions)
- [Health](#health)
- [Connection handshake](#connection-handshake)
- [DockFlow](#dockflow)
- [Power Tool](#power-tool)
- [Endpoint summary](#endpoint-summary)

## Conventions

### Authentication

Every `/api/v1/*` route requires the generated integration key in `Authorization: Bearer <key>` or `X-API-Key: <key>`. The workstation accepts `API_KEYS`, a comma-separated rotation list; the Ubuntu backends send one matching `COMPANY_API_KEY`. If both header forms are sent, they must match. This token is an integration secret, not a browser JWT.

```bash
curl -H "Authorization: Bearer $COMPANY_API_KEY" http://localhost:5230/api/v1/dockflow/health
```

Missing or rejected authorization returns HTTP 401:

```json
{"error":"unauthorized","code":"COMPANY_API_AUTH","requestId":"example-request"}
```

The handshake and all later operations require the token. Existing Ubuntu user authentication and role rules still apply before repository calls. This workstation API authenticates the backend, not individual browser users. Keep the token in backend configuration.

`/health`, `/ready`, `/docs/` and the OpenAPI document are open. Docs contain no credentials and may be disabled with `DOCS_ENABLED=false`. Protect operational endpoints at the approved proxy if required by your deployment.

### Request IDs and logs

Send `X-Request-ID` with 1–128 letters, digits, underscores, hyphens or periods. Invalid/missing IDs are replaced by a UUID. The same ID appears in the response header and HTTP/database logs. Ubuntu forwards its request ID automatically.

`X-Caller-Service` and base64url JSON `X-Actor-Context` are optional diagnostic metadata. Actor name/role is forwarded only after backend authorization and does not replace the operation's role validation. Runtime logs contain summaries, query fingerprints, parameter counts, durations and SQLSTATE; they omit tokens, SQL text/values, bodies and full records.

### Payloads, pagination and time

JSON bodies are limited to 64 MiB. DockFlow page limits are clamped to 1–100, with offsets 0–1,000,000 and `hasMore` in results. Power Tool read returns the existing full snapshot contract; write sends both original and modified snapshots, so monitor payload size for installations with many images.

PostgreSQL date/time/timestamp-without-time-zone values remain strings, preserving existing company wall-clock semantics. The application timezone is Asia/Manila unless configured otherwise.

### Errors

| HTTP | Meaning |
|---|---|
| 400 | Invalid JSON, argument shape, area, operation, sort/filter or snapshot |
| 401 | Missing or invalid integration key |
| 403 | Existing worksheet role lacks permitted fields |
| 404 | Unrecognized endpoint |
| 409 | Worksheet revision or final approval conflict; reload current data |
| 413 | JSON payload exceeds the body limit |
| 500 | Unexpected internal error |
| 503 | Database, schema or service unavailable |
| 504 | Database statement timeout |

Errors include `error` and `requestId`; `code` is included when available. Internal/database messages are masked in client responses. See correlated runtime logs for safe diagnostic details. Ubuntu converts workstation 401 to an integration error with HTTP 503 so an upstream token mismatch does not sign a browser user out.

## Health

### `GET /health`

Public process liveness. Does not prove database access or Ubuntu connectivity.

```json
{"status":"ok","service":"dockflow-services","version":"13.3.0","transport":"direct-express-api"}
```

### `GET /ready`

Public readiness. Checks both Receiving Records tables and the existing Power Tool database. Returns 200 when both are ready, otherwise 503 with generic per-module availability.

### `GET /api/v1/dockflow/health`

Authenticated DockFlow schema/query check. `areas.DRESSINGS` and `areas.SAVOURY` include `ok`, schema, table, columns, optional missing columns, `hasRecords` and `worksheetVersion: "13.2"`. Returns 503 if either area is unavailable.

### `GET /api/v1/power-tool/health`

Authenticated Power Tool database check. Includes `provider: "postgresql"`, `loggingAvailable`, `approvalSafetyVersion: "13.2"`, service/protocol version and safe runtime identity. Returns 503 if unavailable.

## Connection handshake

### `POST /api/v1/handshake`

```json
{"nonce":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","caller":"dockflow"}
```

`nonce` is 32–128 hexadecimal characters. Generate a new random nonce for verification; do not reuse a static value in application code. `caller` is `dockflow` or `power-tool`.

The response includes `ok`, `service: "dockflow-services"`, `serviceVersion: "13.3.0"`, `protocolVersion: 1`, applications `["dockflow","power-tool"]`, echoed nonce, hexadecimal `proof`, runtime diagnostics and request ID.

Verify the echoed nonce, service, protocol and application list. Compute the expected proof:

```js
createHmac('sha256', key)
  .update(`dockflow-services:1:${nonce}:dockflow,power-tool:${serviceVersion}`)
  .digest('hex');
```

Compare with a constant-time function. Both Ubuntu clients implement this automatically and cache successful verification for 30 seconds. Every API request remains independently token-protected. TLS validation is always enabled; the handshake does not replace HTTPS or network routing.

## DockFlow

### `POST /api/v1/dockflow/sap/{area}/{operation}`

`area` is `DRESSINGS` or `SAVOURY`. Body: `{ "args": [...] }`. The positional arguments match the existing repository interface.

| Operation | `args` | Result |
|---|---|---|
| `describe` | `[]` | Mapped columns, formatting support and source metadata |
| `sync` | `[rows]` | Synchronizes changed system fields; `null` result |
| `page` | `[offset, limit, search, options]` | `{rows, hasMore, columns, canFormat, source, sort}` |
| `byKeys` | `[[recordKey, ...]]` | Matching rows |
| `all` | `[]` | All existing rows; prefer `page` for normal browsing |
| `forShipment` | `[shipmentId]` | Rows linked through an existing `shipment_id` column |
| `forClearance` | `[shipment]` | Source records matched using the existing shipment/item/invoice rules |
| `add` | `[values, actorName, sourceKey]` | Newly inserted worksheet row |
| `save` | `[rows, actorName, role]` | Saved `{key, revision}` results |

`sync`, `add` and `save` write production records. `role` uses the existing Ubuntu worksheet roles. Repository permissions and revisions still determine which fields can change. Reads do not need actor arguments.

A page request:

```json
{"args":[0,25,"",{"direction":"desc","column":"description","filters":{},"receivingValues":{}}]}
```

Options retain the existing contract: `column`, `direction`, `filters`, `exclude`, `order` and `receivingValues`. Savoury supplementary values supplied by Ubuntu may be used for searching, filtering and sorting where the actual company table lacks those columns. They are bound only when SQL references them, avoiding the earlier `42P18` error.

A successful response:

```json
{"ok":true,"result":{"rows":[],"hasMore":false,"columns":[],"canFormat":false,"source":{"area":"SAVOURY","worksheetVersion":"13.2","serviceVersion":"13.3.0"},"sort":{"column":"description","direction":"desc"}}}
```

Actual column and row contents depend on your source schema. Columns use `[fieldKey, label, width, databaseColumn, role]`. Rows retain the existing `key`, `revision`, `values`, formatting and grouping fields. Never send SQL or substitute a table name in the route.

## Power Tool

### `POST /api/v1/power-tool/read`

Send `{}`. Returns `{ "ok": true, "result": state }`. The state has `meta`, `usage`, `categories`, `legacyCategories`, `staffAccounts`, `requests` and `items`. This is a backend-only snapshot; staff account password hashes remain part of the existing storage contract and must not be exposed to browser clients.

### `POST /api/v1/power-tool/write`

Send `{ "before": originalState, "after": modifiedState }`. Both states must contain all seven fields above; each of the five collections is an array with unique, nonempty string IDs. Use the exact snapshot returned by `read` for `before`.

The repository commits changes in one transaction, updates changed records, merges usage counters and retains final inspection conflict checks. A competing final approval returns 409 / `APPROVAL_CONFLICT`; Ubuntu reloads the completed result rather than creating another QR/equipment item. Expiry validation and QR generation remain in the existing Ubuntu approval handler.

Do not use fabricated empty snapshots to test write connectivity. A successful write returns the existing saved snapshot in `{ok, result}`.

### `POST /api/v1/power-tool/log`

Body `{ "entry": { "eventType": "qr_open", "eventKey": "session:event:item", ... } }`. Persists the existing business audit event with duplicate handling. If the optional `power_tool_logs` table is absent, returns a successful result with `stored:false` and a reason. Runtime logs still omit the audit entry body.

## Endpoint summary

| Method | Path | Authorization |
|---|---|---|
| GET | `/health`, `/ready` | Open |
| GET | `/docs/`, `/openapi.json`, `/openapi.yaml` | Open unless docs disabled |
| POST | `/api/v1/handshake` | Integration token |
| GET | `/api/v1/dockflow/health` | Integration token |
| POST | `/api/v1/dockflow/sap/{area}/{operation}` | Integration token |
| GET | `/api/v1/power-tool/health` | Integration token |
| POST | `/api/v1/power-tool/read`, `/write`, `/log` | Integration token |
