# DockFlow and Power Tool standalone Express service

One Express service, separate DockFlow and Power Tool modules/database pools, separate from People Accounting. Service 13.3.0, protocol 1; this build adds the compatible outbound bridge worker.

**Use the existing outbound architecture:** enable `OUTBOUND_WORKER_ENABLED=true`, retain `PORT=5063` if currently installed, set `UBUNTU_BRIDGE_URL` to your existing public Ubuntu company-bridge endpoint and reuse Ubuntu's `COMPANY_API_KEY` (also in `API_KEYS`). Keep Ubuntu in `legacy` mode with its existing per-container local queue URLs. The worker calls this Express service locally; Ubuntu does not need to reach the workstation's private IP.

The worker runs inside the existing `api` process/container. Its named worker-state volume guards against replaying an uncertain write after restart. Run only one worker during cutover. Default `.env.example` leaves the worker disabled until the correct URL/key is configured; startup logs explicitly report that state.

Read [the recovery guide](docs/BRIDGE-RECOVERY.md) for findings, safe Ubuntu diagnostics, exact PowerShell setup, key recovery, guarded deployment and rollback. Read [API.md](docs/API.md) for repository contracts/Swagger. `/health` is Express liveness; authenticated module health checks verify database access; `/api/v1/diagnostics` reports worker state. Use `docker compose exec -T api node diagnostics.mjs` for redacted independent checks.

Direct Express mode still exists for an already provisioned reachable HTTPS route. It is optional and is not required for the outbound repair.

Keep existing company schemas/data/credentials. Startup does not create tables, seed users or enable migrations. Preserve your private `.env`; never commit it, database snapshots or diagnostic secrets. `npm ci` uses the supplied lockfile. `npm test` runs local tests; set `UBUNTU_SOURCE` to the paired package's `source/apps` to run its actual client/approval tests. See `BRIDGE-VALIDATION.md` for performed checks and limits.
