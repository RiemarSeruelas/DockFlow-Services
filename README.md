# DockFlow 13.1 — COMPLETE workstation package

This ZIP contains the complete `workstation-api` project, already upgraded to **13.1.0**. Older workstation ZIPs are unnecessary. The separate Ubuntu 13.1 ZIP remains required for the Ubuntu upgrade.

Included: DockFlow database API, bridge worker, existing Power Tool database API, structured logging, all supporting modules, Dockerfile, Compose, dependency manifest/lock, environment template, tests, source/configuration recovery, guarded deployment and rollback helpers. Docker installs dependencies during its build; `node_modules` is intentionally excluded. Real credentials and company database records are not packaged.

The complete supported `workstation-api-11.1.1-logging.zip` supplies the unchanged project files omitted by the incremental 13.0 ZIP. The supplied 13.0 cumulative manifest and verified 13.1 installer were applied directly to it. Only the SAP repository and package/lock version fields changed in application source. The final SAP repository is byte-identical to the delivered 13.1 update. This is the legitimate company API architecture, with no temporary/mock application or spreadsheet integration.

## Recover the files you deleted and deploy

First follow the Ubuntu 13.1 README's production backup instructions and retain the company database owner's normal backup. Open Docker Desktop. Extract this full ZIP and open PowerShell in `DockFlow-13.1-Workstation-Full`, where `restore_workstation.py` is located.

If the previous Docker containers are still present, run:

```powershell
py -3 restore_workstation.py --deploy
```

The script finds the original folder/project from the retained containers, restores the complete source there, preserves an existing `.env` or recovers it from the retained worker/DockFlow/Power Tool container settings, and verifies connection values with Compose without printing passwords or API keys. It saves a private recovery backup before replacing surviving source files. The recovery step does not recreate containers.

It then runs the included guarded deployer: tags the previous image, builds and recreates **only dockflow-db**, checks company DB connectivity and both 13.1 mappings, and prints an image rollback command. The existing worker and Power Tool containers remain in place. Their unchanged full source is included for future rebuilds; services retain the version of their running image until rebuilt.

To restore files/configuration first and review the printed folder before deploying:

```powershell
py -3 restore_workstation.py
# Run the exact deployment command printed by the script afterward.
```

Linux equivalents use `python3`. If containers exist but are stopped, configuration can still be recovered; the guarded deployer needs the original dockflow-db running before it can tag/replace its live image. Start the existing containers in Docker Desktop first. Keep `.env` and the recovery backup private; do not send their contents in chat.

Recovery stops on ambiguous/missing containers, different shared DB settings, inaccessible folder labels, custom Compose overrides or connection-value differences. It does not guess credentials or an installation folder.

## If the previous containers were also deleted

The full source still rebuilds independently. Restore the previous `.env` from your own backup, or obtain the original values from the database/bridge owner. The template contains placeholders, not your credentials:

```powershell
cd .\workstation-api
Copy-Item .env.example .env
# Fill .env with the original values, including the same COMPANY_API_KEY as Ubuntu.
```

Only after confirming that no previous worker is still polling the same bridge, use the **original project name** (the standard package uses `dockflow-company-api`):

```powershell
docker compose --project-name dockflow-company-api -f compose.yaml config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Configuration is incomplete; stop here' }
docker compose --project-name dockflow-company-api -f compose.yaml build worker dockflow-db power-tool-db
if ($LASTEXITCODE -ne 0) { throw 'Build failed; stop here' }
docker compose --project-name dockflow-company-api -f compose.yaml up -d worker dockflow-db power-tool-db
if ($LASTEXITCODE -ne 0) { throw 'Startup failed; stop here' }
```

There is no rollback image if you removed it too. This starts company API services only; it does not create/reset company tables. Existing automatic migration flags remain disabled.

## Verify and continue the Ubuntu upgrade

From the restored `workstation-api` folder, substitute the actual project name printed during recovery:

```powershell
$dfProject = 'dockflow-company-api'
@'
const r=await fetch('http://127.0.0.1:8081/api/dockflow/health');
const h=await r.json();
console.log(JSON.stringify({ok:h.ok,serviceVersion:h.serviceVersion,areas:h.areas},null,2));
if(!r.ok||!h.ok||h.serviceVersion!=='13.1.0'||['DRESSINGS','SAVOURY'].some(a=>h.areas?.[a]?.worksheetVersion!=='13.1'))process.exitCode=1;
'@ | docker compose --project-name $dfProject -f compose.yaml exec -T dockflow-db node --input-type=module
if ($LASTEXITCODE -ne 0) { throw 'Workstation verification failed; stop here' }
docker compose --project-name $dfProject -f compose.yaml ps
```

After workstation verification succeeds, follow the already supplied Ubuntu 13.1 README to deploy Ubuntu, verify the bridge, and smoke-test Receiving Records and Monitoring. For code/image rollback, use the exact command printed by the guarded deployer. If source was previously deleted, rollback restores the previous running image; the newly recovered full source remains available. A database restore is separate from an image rollback.

## Verification

The complete project passes all 18 tests: real supplied receiving/network/logger/worker/Power Tool modules, 30,991-row PostgreSQL sorting/filtering/paging, source mappings, native edits, stale writes, HTTP correlation/redaction, worker forwarding/replay/multipart/retry/expiry and optional Power Tool logs. No omitted-module test doubles are needed for this full project. The recovered 11.1.1 source passed the guarded direct upgrade to 13.1; repository bytes match the verified incremental release. Recovery helper checks include configuration preservation, missing containers and private connection validation. Docker is unavailable in the preparation environment: the actual production image build and company connection check happen on your workstation. This preparation did not access your workstation or change its database.

The recovery helper uses Docker's documented [environment-file syntax](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/) and verifies the resulting values privately before deployment.
