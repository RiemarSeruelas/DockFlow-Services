# Workstation API 11.1.1 — request and bridge logging

This package contains only `workstation-api`. It includes the 11.1 source-column mapping fixes and adds structured JSON console logging to the worker, DockFlow database API, and Power Tool database API. No Ubuntu frontend or deployment files are included.

## Install on the AI workstation

1. Back up the existing workstation `.env` and keep its database credentials, `COMPANY_API_KEY`, and `UBUNTU_BRIDGE_URL`.
2. Extract this package and copy that existing `.env` into this `workstation-api` directory.
3. Optionally add `WORKSTATION_ID` with a recognizable label for this actual machine. Logging defaults to `LOG_LEVEL=info`; set `LOG_LEVEL=debug` to include idle bridge polls and individual result-part transfers.
4. From this folder, use the same Compose project name as the running workstation installation:

```bash
docker compose -f compose.yaml --project-name dockflow-company-api config --quiet
docker compose -f compose.yaml --project-name dockflow-company-api up -d --build --force-recreate --remove-orphans
docker compose -f compose.yaml --project-name dockflow-company-api ps
```

A git pull updates source files. The build and recreate command is necessary to run the new code. If the active installation uses another project name, substitute that exact name in every command. Keep a single intended worker polling this Ubuntu bridge; extra old workers can still answer requests using their old database services.

## Watch the console output

```bash
docker compose -f compose.yaml --project-name dockflow-company-api logs --follow --tail=100 worker dockflow-db power-tool-db
```

Press Ctrl+C to stop watching; the containers continue running.

To collect recent logs for review:

```bash
docker compose -f compose.yaml --project-name dockflow-company-api logs --no-color --since=15m worker dockflow-db power-tool-db > workstation-api-logs.txt
```

Docker console logs rotate at 10 MB per file, with three retained files per service. Application code writes to stdout/stderr; it requires no writable directory or database log table.

## What is logged

Every log line has a UTC timestamp, severity, event, service name, version `11.1.1`, source-code build fingerprint, container hostname, process ID, workstation label, and unique process instance ID.

| Fields/events | Purpose |
| --- | --- |
| `request.received`, `request.completed`, `request.failed`, `request.aborted` | Method, recognized path, area/operation, socket peer IP, declared caller/worker, request/job ID, HTTP status, timing, byte counts, result counts, and errors. |
| `bridge.connected`, `bridge.loop_failed` | Ubuntu bridge address, connection recovery, authentication/HTTP failures, timeouts, and underlying network error codes. |
| `job.received`, `job.forward.started`, `job.forward.completed` | Job ID, operation, local API target, upstream service version/instance, page controls, row counts, and failures. |
| `job.result.*`, `job.replayed`, `job.completed` | Delivery completion, multipart counts, retries, expired jobs, and reuse of a cached outcome without executing it again. |
| `sap.schema_inspected`, `sap.schema_inspection.failed` | Actual database/schema/table, existing and mapped column names, optional columns omitted, stable row identifiers, and schema errors. |
| `failure.code`, `failure.message`, optional `schema`/`table`/`column` | SQLSTATE and diagnostic identifiers, including missing-column errors such as `42703`, without dumping SQL parameters or row contents. |

The worker forwards the same UUID in `X-Request-ID` and `X-Bridge-Job-ID` to the database API. Search the logs for `bridgeJobId` to follow one job across both services. `declaredWorkerId` identifies the sending worker instance; `peerIp` is the immediate socket peer, not the user's browser address.

### Who made the request

The existing Ubuntu bridge supplies the job method, path, and operation arguments. It does **not** supply the original browser user ID, browser IP, or username for ordinary read/page requests. Those requests are identified as originating from the Ubuntu bridge and the workstation worker; this package does not invent an end-user identity.

For SAP `add` and `save`, the existing arguments include an analyst name, and `save` includes a role. These appear as `declaredActor` with an explicit note that the identity was forwarded in the operation arguments and is not independently authenticated by this API. Fully identifying readers requires a separate Ubuntu bridge change; no such change is bundled here.

### Redaction

Authorization/cookie headers, keys, passwords, tokens, request/response bodies, search text, complete SAP/Power Tool records, SQL values, PostgreSQL `detail`, and encoded result chunks are not logged. Known configured secrets are scrubbed from diagnostic strings. Quoted input values in data errors are redacted; schema identifiers remain visible for debugging. Analyst names supplied with edits and database account names are intentionally diagnostic metadata.

## Verify the running version and source tables

```bash
docker compose -f compose.yaml --project-name dockflow-company-api exec -T dockflow-db node -e 'fetch("http://127.0.0.1:8081/api/dockflow/health").then(async r=>{console.log("HTTP",r.status,await r.text());if(!r.ok)process.exitCode=1;}).catch(e=>{console.error(e.message);process.exitCode=1;})'
docker compose -f compose.yaml --project-name dockflow-company-api exec -T power-tool-db node -e 'fetch("http://127.0.0.1:8082/api/power-tool/health").then(async r=>{console.log("HTTP",r.status,await r.text());if(!r.ok)process.exitCode=1;}).catch(e=>{console.error(e.message);process.exitCode=1;})'
```

Health responses include `serviceVersion: "11.1.1"` and `diagnostics` containing build and instance IDs. Every HTTP response also includes `X-Request-ID`, `X-Service-Version`, and `X-Service-Instance-ID`. Successful DockFlow health checks report both areas as `ok: true`; Power Tool can be healthy with `loggingAvailable: false` when the optional log table is absent.

Run the existing Ubuntu bridge health request or Postman test afterward. If local health shows 11.1.1 but Ubuntu still receives older migration requirements, compare logs and look for another worker/service installation still answering the same bridge.

## Validation

```bash
npm ci
npm test
```

Tests cover the supplied Dressings/Savoury schemas and 30,991-row paging fixture, missing optional columns, native edits and stale revisions, Power Tool without its optional log table, concurrent HTTP correlation and actor labeling, error/credential redaction, preserved response data, worker forwarding, cached replay, multipart ordering, retries, expiry, and underlying network errors. Production Docker builds install only runtime dependencies. No automatic database migration is added.
