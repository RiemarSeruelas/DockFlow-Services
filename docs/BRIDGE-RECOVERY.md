# DockFlow 13.3.1 — outbound bridge recovery

Prepared 9 October 2026. This guide accompanies the repaired standalone `DockFlow-13.3-Workstation-Express.zip` and `DockFlow-13.3.1-Ubuntu-Update.zip`. Express still reports service version **13.3.0**, protocol **1**; Ubuntu reports **13.3.1** after a successful deployment. `BRIDGE_FIX_VERSION` and package checksums distinguish these corrected builds from the earlier ZIPs.

## What the investigation established

**The earlier standalone Express package cannot replace the outbound worker by itself.** Its `index.js` starts only Express and database pools; Compose starts only `api`; configuration has no polling URL or worker startup. Its README explicitly says no worker is needed. The older workstation package starts a separate `worker` alongside `dockflow-db` and `power-tool-db`. Removing that worker removes the only demonstrated route for Ubuntu's company requests.

**The Ubuntu 13.3.1 installer also has a real legacy compatibility defect.** `resolve_company_api.py`, `verify_company_api.mjs` and both application clients demand HTTPS even for the legacy local queue. The live DockFlow configuration supplied in your notes is `http://127.0.0.1:3001`. The installer additionally demands identical URL strings for both callers and uses DockFlow's settings inside the Power Tool container. Power Tool can legitimately use Docker DNS to reach that same queue. Its actual live URL remains to be checked; the repair preserves each caller's existing value and tests from its own container.

These are confirmed source defects. **We have not established that the Express installation stopped the old worker at exactly 08:10:05 UTC.** That remains a hypothesis until Windows container/process history and Ubuntu logs are compared.

| Supplied runtime evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| Worker GET/POST HTTP 200 on 8 Oct, around 08:09 UTC | Jobs and results crossed the authenticated bridge routes in the known implementation. | Every database operation succeeded. A result acknowledgement can contain an upstream error. |
| Last observed poll at 08:10:05 UTC, HTTP 499 | The client closed that request. This is 16:10:05 in the Philippines/Taipei. | Why it closed, or that the process stopped permanently at that instant. |
| No later successful polls in the supplied search | No later activity was found in that log set. | Complete history across every rotated log or a currently restarted worker. |
| Ubuntu 504, “AI workstation did not answer in time” | The queue's 55-second deadline expired without a complete result. | A PostgreSQL outage specifically. The job may never have been claimed. |
| Ubuntu → `172.27.0.159:5063` timed out | That attempted direct route failed. | Express is down locally. The outbound design does not require this connection. |
| Manual AgileWifi webhook accepted/forwarded | Webhook credentials and report delivery worked. | Automatic reporting, database access, or the company-data bridge worked. |
| 13.3.1 preflight failed before changes | The supplied deployment did not replace production. | That 13.3.1 is live. Production remains **13.2** according to the supplied evidence. |

The production machines were not accessed, restarted or modified during this work. The network evidence above is from your supplied findings; local source tests are reported separately below.

## Architecture and compatibility

| Item | Original workstation 13.2 | Earlier standalone Express ZIP | Repaired standalone Express ZIP |
| --- | --- | --- | --- |
| Startup | Three services: worker and two company APIs | One Express `api` service | One Express `api` service, with an optional worker in that same process |
| Ubuntu traffic | Workstation initiates HTTPS to Ubuntu | Ubuntu must reach Express directly | Workstation initiates HTTPS to Ubuntu; Express is called locally |
| Public worker endpoints | `GET /dockflow/api/integrations/company-bridge/next`; `POST /.../result/:id/part` | None | Same endpoints and gzip/base64 part format |
| Local API | DockFlow 8081; Power Tool 8082 | Shared `/api/v1/*`, default 5230 | Same shared API; retains `PORT=5063` in an existing `.env` |
| Authentication | Bridge Bearer key, at least 32 bytes | Express Bearer or X-API-Key; HMAC handshake | Existing bridge Bearer key; local Express authentication and HMAC verification |
| Queue ownership | 35-second lease; 55-second job deadline | No worker queue | Old 13.2 protocol supported; repaired Ubuntu adds owner checks and avoids re-leasing writes |
| Repeated jobs | Short in-memory result cache | No worker | Bounded result cache plus persistent mutation markers; ambiguous writes are not executed again after restart |
| People Accounting | Separate | Separate | Separate; no changes to People Accounting |

For the preferred outbound configuration:

| Location | Setting | Value |
| --- | --- | --- |
| Ubuntu DockFlow | `COMPANY_API_MODE` | `legacy` |
| Ubuntu DockFlow | `COMPANY_API_BASE_URL` | Keep its existing local queue root, currently `http://127.0.0.1:3001` |
| Ubuntu Power Tool | `COMPANY_API_BASE_URL` | Keep its separately verified existing queue root; often `http://dockflow-api:3001`, but confirm with diagnostics |
| Both Ubuntu backends | `COMPANY_API_KEY` | Same existing bridge key |
| Workstation | `PORT` | Keep `5063` if that is the installed port |
| Workstation | `API_BIND_HOST` | `127.0.0.1` |
| Workstation | `OUTBOUND_WORKER_ENABLED` | `true` |
| Workstation | `UBUNTU_BRIDGE_URL` | `https://dockflow.myvnc.com/dockflow/api/integrations/company-bridge` |
| Workstation | `COMPANY_API_KEY` | Existing Ubuntu bridge key; also included in `API_KEYS` |
| Workstation Docker | `WORKER_STATE_DIR` | `/app/worker-state`, backed by the included named volume |

“Legacy” describes Ubuntu's queue transport. It can relay requests to the new Express APIs. It does not require the old workstation database services. The worker verifies Express's nonce/HMAC protocol locally; Ubuntu's legacy client reports that it has no direct Express handshake. Bridge auth and successful relayed reads are the end-to-end checks in this mode.

`--express` remains available for an already configured direct HTTPS route. Do not select it for the outbound bridge, and do not change Ubuntu's URL to the private workstation IP. No new VPN, tunnel, inbound listener exposure or PostgreSQL exposure is needed for this repair.

**Can Ubuntu upgrade before changing the workstation?** Yes, if the old worker is still functioning and both company reads pass. In the currently reported state they fail. Restore the old worker or enable the corrected Express worker first; the guarded Ubuntu installer will continue refusing deployment while the dependency fails.

## Implemented diagnostics and failure handling

The three log categories remain `INITIALIZATION`, `USER_REQUEST` and `CONNECTION`.

- Express records startup, shutdown, database availability and query failures; SQL logs contain statement fingerprints and counts, not SQL values or credentials.
- The worker records enabled/disabled state, lifecycle, verified local protocol, authenticated/rejected polls, last successful poll/result/read, job and request IDs, application, duration, upstream status, failure phase and retry delay.
- Ubuntu records queued/claimed jobs, worker identity, queue wait, processing time, parts received, validated results, completion, upstream failure and timeout phase. Authenticated `/api/integrations/company-bridge/status` reports queue counts, oldest age and last poll. A 13.2 server does not have this new status route; diagnostics report that limitation.
- Power Tool records initialization outcome, failed dependency/code, reconnect attempts, next delay, recovery and last company-data read. Its health reports the reason code instead of equating a running process with available company data.
- Updated Ubuntu carries the original request ID through the job, worker, Express and SQL. With unmodified 13.2, the worker uses the job ID because the old queue does not send the original ID. Nginx result URLs contain the job ID; request-ID correlation additionally depends on its configured log format.

Only one active worker should serve this bridge during cutover. A cached outcome can be resubmitted without executing the database operation again. Persistent markers contain job IDs/timestamps, never database snapshots. If a write's outcome is uncertain, reload the records before deciding whether to retry. HTTP cancellation alone cannot prove a write did not commit. Do not remove the worker-state volume during recovery.

## Ubuntu Bash — read-only investigation now

Copy the corrected Ubuntu ZIP to your existing server login using SFTP/WinSCP, or run this **PowerShell** command on a computer holding the ZIP:

```powershell
$DF_UbuntuUser = 'YOUR_EXISTING_SSH_USERNAME'
scp .\DockFlow-13.3.1-Ubuntu-Update.zip "${DF_UbuntuUser}@174.138.21.21:/mnt/volume_sgp1_1789540146734/dockflow-releases/"
```

On **Ubuntu Bash**:

```bash
DF_RELEASES=/mnt/volume_sgp1_1789540146734/dockflow-releases
DF_REPAIR=$(mktemp -d "$DF_RELEASES/bridge-repair-XXXXXXXX")
unzip -q "$DF_RELEASES/DockFlow-13.3.1-Ubuntu-Update.zip" -d "$DF_REPAIR"
cd "$DF_REPAIR/DockFlow-13.3.1-Ubuntu-Update"
python3 verify_package.py
sudo python3 diagnose_ubuntu.py --output "$DF_REPAIR/ubuntu-diagnostics.json"
```

This collects deployed versions, container health/restarts, safe per-container integration settings, key presence/equality, local health, queue status if available, worker history by date, recent correlated logs, disk space and the known backup's existence/catalog validation. It does not restart containers or edit production configuration. Read-only diagnostics do not require workstation access.

To add actual company reads, still without application writes:

```bash
sudo python3 diagnose_ubuntu.py --company-reads \
  --output "$DF_REPAIR/ubuntu-diagnostics-with-reads.json"
```

A missing worker can take about 55 seconds to fail each caller's first read. Do not repeatedly run these probes while jobs are timing out. Custom Nginx access-log locations can be supplied with repeated `--nginx-log /absolute/path/access.log` arguments. Only access-log summaries and allowlisted log fields are included; raw environment, SQL parameters, credentials and account/database snapshots are excluded.

The existing API key is in the production backends' private environment/Compose configuration. It is not supplied by an external “Company API” provider. Do not generate a replacement key during this recovery. If a trusted operator needs to transfer it to the workstation, save it privately without printing it:

```bash
umask 077
DF_API=$(sudo docker ps -q \
  --filter label=com.docker.compose.project=dockflow-ubuntu \
  --filter label=com.docker.compose.service=dockflow-api)
sudo docker exec "$DF_API" node -e \
  'process.stdout.write(process.env.COMPANY_API_KEY || "")' \
  > "$DF_REPAIR/company-bridge-key.private.txt"
chmod 600 "$DF_REPAIR/company-bridge-key.private.txt"
```

Transfer that file only through your existing trusted private channel. It is not part of the diagnostic bundle. Never paste its contents into chat, source control or a ticket.

## Windows PowerShell — workstation recovery when access returns

Use the **existing standalone `dockflow-services` folder**, not People Accounting. Extract the corrected ZIP into a temporary location, review it, then replace project files in that existing folder while retaining its private `.env` and its Compose project name. Keep a private backup of the old project files and `.env`. The ZIP contains no `.env`.

Before replacing the running container, tag its old image for rollback:

```powershell
Set-Location 'C:\YOUR_EXISTING_PATH\dockflow-services'
$DF_OldApi = docker compose ps -q api
$DF_OldImage = docker inspect --format '{{.Image}}' $DF_OldApi
$DF_Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$DF_BackupTag = "dockflow-services-before-bridge:${DF_Stamp}"
docker image tag $DF_OldImage $DF_BackupTag
$DF_BackupTag | Set-Content .\bridge-previous-image.private.txt
```

Edit the retained `.env` privately. Preserve all existing company database settings, existing API keys and `PORT=5063`. Add the old bridge key to `API_KEYS` if absent, and set `COMPANY_API_KEY` to that same key. Set the worker settings shown in the configuration table. Do not include literal `<...>` placeholders in the final `.env`.

```powershell
notepad .env
docker compose build api
```

Build first while the existing containers remain running. Stop the previous worker only after this build succeeds and immediately before starting the replacement. Check whether an old worker is still running before enabling the new one:

```powershell
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
docker compose ps -a
```

If the previous 13.2 Compose project is present, open PowerShell in its actual folder, run `docker compose ps -a`, and review only the `worker` service's recent history. Stop **that worker service only** during the scheduled cutover (`docker compose stop worker` in the old project's folder). Retain its files, images and database services for rollback. If the old worker is absent, compare its stopped-container `FinishedAt`, restart count and private startup logs with the 8 October 08:10 UTC event. A matching time supports the hypothesis; a 499 by itself does not prove it.

Back in the existing standalone Express folder:

```powershell
docker compose up -d --no-deps api
docker compose ps
Invoke-RestMethod http://127.0.0.1:5063/health
docker compose exec -T api node diagnostics.mjs
```

The diagnostics independently show Express HTTP, both company databases, actual SAP/Power Tool reads and worker polling/result timestamps. A 200 from `/health` alone is insufficient. For safe logs:

```powershell
docker compose logs --no-color --since 2h --tail 400 api |
  docker compose exec -T api node diagnostics.mjs --logs-stdin |
  Set-Content -Encoding utf8 .\workstation-bridge-diagnostics.jsonl
```

Confirm worker `enabled=true`, `running=true`, `localHandshakeVerified=true`, `bridgeAuthorization=authenticated`, and a recent `lastSuccessfulPollAt`. Then run Ubuntu's company-read diagnostics and confirm `lastSuccessfulResultAt` advances. This validates authenticated outbound polling without manually taking a queued job away from the worker. Do not separately curl `/next` while another worker is active.

## Ubuntu Bash — guarded deployment after reads recover

Stay in the corrected extracted package root. Confirm the source baseline and run read-only preflight:

```bash
DF_API=$(sudo docker ps -q \
  --filter label=com.docker.compose.project=dockflow-ubuntu \
  --filter label=com.docker.compose.service=dockflow-api)
DF_LIVE=$(sudo docker inspect --format \
  '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$DF_API")
python3 verify_package.py
sudo python3 apply_update.py "$DF_LIVE"
sudo bash deploy.sh --legacy --preflight-only
df -h / "$DF_LIVE" /mnt/volume_sgp1_1789540146734
sudo docker system df
```

`apply_update.py` without `--apply` validates hashes and reports the plan. Unknown local edits are refused. `--preflight-only` performs reads and checks storage without backups, source edits, image tagging or container replacement. Both callers are tested from their own containers. The installer requires at least 1 GiB free on Docker storage and the source filesystem; this is a minimum guard, not a guarantee that the actual images/builds fit. The previously reported root-space shortage must be resolved through reviewed storage allocation or targeted cleanup of known expendable files. Do not use unrestricted prune or delete volumes.

Check the existing backup without restoring it:

```bash
sudo python3 verify_backup.py \
  /mnt/volume_sgp1_1789540146734/dockflow-releases/backups/dockflow-before-13.3.1-20261008T183157Z.dump
```

This checks the archive header, `pg_restore --list` table-data catalog, and a full archive decode to `/dev/null` without a database connection. It is not a trial restore. Use a compatible installed `pg_restore`; do not bypass a failure. Prefer a fresh backup immediately before the maintenance window. The supplied running PostgreSQL name was `dockflow-poc-server-postgres-1`; verify that name, its database and credentials privately before using this command:

```bash
DF_PG=dockflow-poc-server-postgres-1
sudo docker inspect --format '{{.State.Status}}' "$DF_PG"
umask 077
DF_DUMP="$DF_RELEASES/backups/dockflow-before-13.3.1-$(date -u +%Y%m%dT%H%M%SZ).dump"
DF_DUMP_TMP="${DF_DUMP}.tmp"
sudo docker exec "$DF_PG" sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$DF_DUMP_TMP" && mv "$DF_DUMP_TMP" "$DF_DUMP"
chmod 600 "$DF_DUMP"
sudo python3 verify_backup.py "$DF_DUMP"
```

These environment names must describe the actual DockFlow application database. If that container uses different configuration, use the existing reviewed backup procedure instead. Do not guess another database. Verify the command succeeded and `DF_DUMP` names a complete validated archive before continuing.

Deploy with the validated backup path:

```bash
sudo DOCKFLOW_POSTGRES_BACKUP="$DF_DUMP" bash deploy.sh --legacy
```

The deployer verifies package/baseline, per-container company reads, storage and PostgreSQL backup before mutation. It privately saves running image references, source/configuration/uploads, a DockFlow application-state snapshot and a Power Tool company-state snapshot; builds with existing containers running; replaces only DockFlow API, DockFlow web and Power Tool; then checks version, local health and real company reads. It preserves the portal and database volumes.

This bridge repair introduces **no schema migration** and no automatic company-table creation. The existing 13.3.1 application's reviewed initialization remains unchanged. The application-state backup now uses a read-only transaction and does not invoke that initialization. Missing company schemas or unreviewed normalization changes must be resolved through the existing reviewed migration process before preflight can pass. Never force migration past integrity failures.

Save the installer output and its exact rollback path. Do not consider deployment successful until it prints the completion message and the checks below succeed.

## Validate recovery and regression on the machines

```bash
sudo python3 diagnose_ubuntu.py --company-reads \
  --output "$DF_REPAIR/after-13.3.1-diagnostics.json"
```

Confirm both local apps report version 13.3.1 and healthy availability. Both company-read checks must pass. Check actual SAP Receiving Records in **DRESSINGS and SAVOURY**; confirm Power Tool loads existing requests/items with `provider=postgresql` and a recent successful company-data read. No local fallback should substitute for company records.

Have authorized users verify existing delivery creation/booking, receiving and clearance, exports and QR scans, plus 13.3.1 account/private-trial/SDS comparison behavior. Validate Power Tool expiry/approval/QR behavior with the normal approved workflow or dedicated test records; the diagnostic scripts deliberately perform no writes. Supplied source tests cover these behaviors locally, but production data/schema/browser checks still require the real machines.

## Rollback

For Ubuntu, use the **exact path printed by the installer**:

```bash
sudo bash '/ACTUAL_PRINTED_BACKUP_PATH/rollback.sh'
```

Build failure restores prior source/configuration while existing containers continue running. Failed replacement or post-deployment checks restore prior source and tagged images with the old running integration settings. Then rerun read-only diagnostics and confirm the previous version/health/company reads. The additive 13.3.1 schema behavior is not reversed by image rollback. Do not automatically restore a database dump after users have made new records; that can discard data. A database restore is a separate reviewed recovery action.

For the workstation, set `OUTBOUND_WORKER_ENABLED=false` in its private `.env` and restore the saved project files/`.env`. Pin the saved image temporarily using a private Compose override:

```powershell
$DF_BackupTag = (Get-Content .\bridge-previous-image.private.txt -Raw).Trim()
$DF_Override = @{services=@{api=@{image=$DF_BackupTag}}} | ConvertTo-Json -Depth 8
$DF_Override | Set-Content -Encoding utf8 .\bridge-rollback.private.json
docker compose -f docker-compose.yml -f bridge-rollback.private.json up -d --no-build --no-deps api
```

Restore the old worker in its original Compose project (`docker compose start worker`) only after the new worker is stopped/disabled. Verify new authenticated polls and Ubuntu company reads. Keep the worker-state volume and backups. When leaving rollback, remove the temporary image override deliberately and use the reviewed normal Compose configuration.

## Verification evidence and remaining work

Local verification uses actual uploaded source, authenticated HTTP exchanges and PostgreSQL-compatible PGlite fixtures. It does not simulate success by returning arbitrary canned database rows for the end-to-end read/approval tests.

The corrected builds are verified against the exact 13.2 bridge and the corrected 13.3.1 queue. Coverage includes direct Express compatibility, both company reads, request-ID propagation into SQL, owner checks, queue timeout phases, multipart results, replay protection, and the complete Ubuntu Power Tool approval/expiry/QR flow through the outbound relay. The DockFlow suite checks existing workflows and the 13.3.1 changes. Installer fixtures check source guards, exact rollback, local legacy addresses, unknown/custom configuration rejection and preflight/build/restart/backup failure behavior. The final test counts and package hashes are in each ZIP's `BRIDGE-VALIDATION.md`.

Still required on your machines: identify why the original worker stopped; enable one working outbound worker; verify actual company schemas/permissions/TLS; run real Docker builds; validate current storage and backup; execute guarded deployment; and confirm production recovery/rollback readiness. Without access to the machines, production upgrade and live database recovery cannot be claimed complete.
