# DockFlow and Power Tool package

This is a **new standalone service** using the teammate's People Accounting service structure. It does not modify that service's attendance, presence, emergency or workforce modules.

## Format mapping

| People Accounting format | DockFlow service equivalent |
|---|---|
| `index.js` → `src/app.js` | One shared Express listener and graceful shutdown |
| `src/config.js`, `src/db.js` | Validated configuration, separate injected PostgreSQL pools |
| `src/middleware/*` | Token authorization, request IDs, structured logs, safe errors |
| `src/routes/v1.routes.js` | Handshake, DockFlow and Power Tool routers |
| `src/modules/<feature>/*` | `dockflow` and `power-tool` validators, controllers, services and repositories |
| `src/openapi/*`, `docs/API.md` | Same OpenAPI/Swagger documentation mechanism |
| `postman/*`, `test/*` | Request collection and automated contract/database checks |
| `Dockerfile`, `docker-compose.yml` | One Node 22 container, port 5230 |

## Retained behavior

Receiving Records use the supplied company source tables, stable `id` / `record_key`, existing optional field mapping, row revisions, role permissions and clearance matching. Savoury supplementary fields remain managed by Ubuntu where absent from the company source table. The lazy supplementary JSON parameter binding retains the PostgreSQL `42P18` fix.

Power Tool retains PostgreSQL-only storage, exact before/after snapshot change tracking, transactions, usage counter merges and final approval conflict checks. The existing Ubuntu application still validates expiry dates, generates QR codes and applies inspection rules. This service supplies its existing repository through API calls.

The existing production schemas must already contain data. Startup does not create tables, reset data, seed accounts or enable automatic migrations. Missing schemas or unreviewed normalization changes return unavailable; complete a reviewed database migration separately.

`serviceVersion` is `13.3.0`; `protocolVersion` is `1`. `worksheetVersion` and `approvalSafetyVersion` intentionally remain `13.2` because those retained business contracts have not changed.

## Review locations

- Shared authorization: `src/middleware/apiKeyAuth.js` and `src/routes/handshake.routes.js`.
- DockFlow: `src/modules/dockflow/`.
- Power Tool: `src/modules/power-tool/`.
- Logs: `src/utils/logger.js`, `database-logging.js`, request middleware.
- API docs: `src/openapi/openapi.yaml`, `docs/API.md`.
- Ubuntu transport changes are in the companion ZIP, in each app's `server/company-api-client.js` and `company-integration-logging.js`.

This folder is ready to add to the senior developer's own Git repository. No repository URL was supplied, so no remote repository or branch was created. Commit the project files while keeping `.env` and `node_modules` excluded. Use the committed lockfile with `npm ci` / Docker builds.
