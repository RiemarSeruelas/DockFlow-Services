# DockFlow services — Express 13.3

A standalone Node.js Express project for **DockFlow and Power Tool in one process**. It follows the supplied `people-accounting-service` layout: `index.js`, app/config/database modules, middleware, versioned routes, controller/service/repository modules, OpenAPI, Swagger, Postman, Docker and tests. People Accounting remains a separate project.

| Module | Workstation endpoints | Existing company database |
|---|---|---|
| DockFlow | `/api/v1/dockflow/*` | `DockFlow`, schema `Analysis` |
| Power Tool | `/api/v1/power-tool/*` | `confirmation_powertool_machine`, schema `power_tool` |
| Shared authorization | `/api/v1/handshake` | Generated integration key; no database dependency |

Both modules listen on **5230** in the same Node process. PostgreSQL pools are independent. No worker, job queue, result chunks, long polling or per-app API containers are needed on the workstation.

## Run on the workstation

Extract this ZIP into a **new folder** such as `C:\DockFlow\dockflow-services`. Open PowerShell in that folder. Docker Desktop must be running with Linux containers. Keep your existing installation available during cutover.

```powershell
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
notepad .env
docker compose up -d --build
docker compose ps
docker compose logs --tail 100 api
```

If Node is not installed on the host, generate a key using:

```powershell
docker run --rm node:22-alpine node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Put the generated key in `API_KEYS`. Fill in the real company PostgreSQL host/user/password and confirm database names, schemas and table names. Use separate `POWER_TOOL_PGUSER` / `POWER_TOOL_PGPASSWORD` when required. Never copy the People Accounting `.env` or its credentials.

Open **http://localhost:5230/docs/** for Swagger. Click **Authorize**, enter your integration token, and start with the handshake and GET health checks. `/health` is liveness; `/ready` checks both database-backed modules. Swagger includes write operations, so choose read operations when testing connectivity.

For development without Docker, install Node 22 or newer, then:

```bash
npm ci
npm test
npm start
```

## Connect Ubuntu

Install the companion `DockFlow-13.3-Ubuntu-Update.zip` after this API is ready. Both existing Ubuntu backend services must receive:

```dotenv
COMPANY_API_BASE_URL=https://YOUR_APPROVED_REACHABLE_WORKSTATION_URL
COMPANY_API_KEY=THE_SAME_GENERATED_KEY_AS_API_KEYS
AGILE_WIFI_ENDPOINT_MODE=fixed
```

The base URL is the **root of this new API**, never the old `company-bridge` URL, `/api/v1`, a webhook URL or the Ubuntu app's own URL. A reverse proxy may add a configured prefix, provided it forwards that prefix to this API. Use an HTTPS route that Ubuntu can reach, such as an approved VPN with a TLS reverse proxy. Node listens using HTTP behind that proxy; TLS terminates at the approved proxy.

The existing IP webhook records the workstation's private address. It does **not** make that address reachable from Ubuntu. The new authenticated connection check distinguishes an address report from a working API connection. See [deployment and network setup](docs/DEPLOYMENT.md).

## Documentation and checks

- [API reference](docs/API.md): every DockFlow and Power Tool operation and argument contract.
- [Ubuntu integration](docs/ubuntu-integration.md): shared key, handshake, correlation and error behavior.
- [Deployment](docs/DEPLOYMENT.md): Windows/Linux setup, network, cutover and rollback.
- [Integration notes](INTEGRATION-NOTES.md): format mapping and retained business rules.
- `src/openapi/openapi.yaml`: contract served at `/openapi.json` and `/openapi.yaml`.
- `postman/dockflow-services.postman_collection.json`: import and set `baseUrl` / `apiKey` privately.
- [Validation](docs/VALIDATION.md): automated checks and production checks still needed.

Runtime logs contain only `INITIALIZATION`, `USER_REQUEST` and `CONNECTION`. Request IDs link Ubuntu requests to workstation/database query summaries. Tokens, SQL parameter values and full request/response bodies are redacted. Existing application audit records remain in the database.
