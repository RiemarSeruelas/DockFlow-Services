# AI workstation company service 11.1

This service receives work through the existing Ubuntu HTTPS bridge and runs the company PostgreSQL queries locally. Database credentials stay in this workstation folder. Update this folder together with the Ubuntu apps.

## Preserve configuration

Copy the existing workstation `.env` into this folder. Keep the shared `COMPANY_API_KEY`, `UBUNTU_BRIDGE_URL`, company database host and both database logins. The shared key must match Ubuntu.

The optional name settings in `.env.example` default to:

- DockFlow database `DockFlow`, schema `Analysis`, tables `SAPAnalysisDressings` and `SAPAnalysisSavoury`.
- Power Tool database `confirmation_powertool_machine`, schema `power_tool`.

Database and quoted table names are case sensitive. Use the names of your existing databases. No SAP schema migration command is required for the supplied table structures.

## Replace the old services

Run in the new `workstation-api` folder, using Docker Desktop on the workstation or its existing Docker installation:

```bash
docker compose -f compose.yaml --project-name dockflow-company-api config --quiet
docker compose -f compose.yaml --project-name dockflow-company-api up -d --build --remove-orphans
docker compose -f compose.yaml --project-name dockflow-company-api ps
```

Keep the same Compose project name as the existing service. If its old project has a different name, use that exact name in these commands so the active worker and database services are replaced together.

## Check the local databases

These checks call the database containers directly and print no credentials:

```bash
docker compose -f compose.yaml --project-name dockflow-company-api exec -T dockflow-db node -e 'fetch("http://127.0.0.1:8081/api/dockflow/health").then(async r=>{console.log("HTTP",r.status,await r.text());if(!r.ok)process.exitCode=1;}).catch(e=>{console.error(e.message);process.exitCode=1;})'
docker compose -f compose.yaml --project-name dockflow-company-api exec -T power-tool-db node -e 'fetch("http://127.0.0.1:8082/api/power-tool/health").then(async r=>{console.log("HTTP",r.status,await r.text());if(!r.ok)process.exitCode=1;}).catch(e=>{console.error(e.message);process.exitCode=1;})'
docker compose -f compose.yaml --project-name dockflow-company-api logs --tail=80 worker dockflow-db power-tool-db
```

Expected: HTTP 200, `ok: true`, version `11.1.0`. DockFlow lists both source tables and their existing columns. Power Tool can return `loggingAvailable: false`; it skips the optional company log inserts while keeping the existing app data available.

After these checks pass, run the outbound health commands in the ZIP's root README from Ubuntu. Those checks verify the shared key, outbound worker and relay together.

## Source behavior

Each SAP area is inspected separately through `information_schema.columns`. Only `id` and `record_key` are required for stable row identity; existing optional fields are selected when present. Errors for inaccessible or missing source tables remain visible. Savoury reads its SDS columns, edits their native data types and uses PostgreSQL row revisions to reject stale changes. Booking synchronization targets the Dressings table; it does not insert booking records into the Savoury import.

Power Tool still requires its existing metadata, usage and application collection tables. Its optional log table does not gate access. JSON content comparison ignores object key order, which PostgreSQL JSONB can change.

## Tests

```bash
npm ci
npm test
```

The PostgreSQL test engine is a development dependency. Production Docker builds install only the runtime dependencies.
