# DockFlow 13.2

The two ZIPs contain the complete updated application source and guarded deployment scripts for the supplied production 13.1 release. The fresh live-source export is the Ubuntu baseline. Existing Docker/Compose configuration, credentials, uploaded files, production images/assets and data remain in their current folders. No live deployment was performed during preparation.

**Workstation source changed: YES.** Its company API needs full-dataset handling of supplemental receiving fields, exact clearance queries without a 10,000-row cutoff, a qualified PostgreSQL revision expression, transactional protection against repeated approval, and the matching 13.2 compatibility markers. Install the workstation update first, then Ubuntu in the same maintenance window. Receiving Records can be temporarily unavailable between these matched upgrades.

## Implemented fixes

| Area | Final behavior |
| --- | --- |
| Monitoring Active/Archive | Search, reason filter and date controls share a responsive layout; cards keep consistent spacing. The original `MISSED_BOOKING_24H` and `OVER_24H_ONSITE` rules and labels remain. |
| Header/sidebar Settings | Header order is clock, role, theme, notifications, Settings, avatar. The sole sidebar Settings item sits at the bottom of navigation above the account area. Other navigation retains its order. |
| Worksheet actions | Fill down, hide/unhide, show hidden rows, delete, swap and clear filters appear in the existing Worksheet tools control. The original standalone copies were removed. Add row and Download Excel remain primary actions. |
| Cell/range selection | The outline is drawn inside the selected cell. The offset pseudo-element background and its edge variants were removed. Selection does not increase row height. |
| Column menus | Filter typing is inside the arrow menu. One controlled menu opens at a time; another arrow, outside click or Escape closes it. Text, quantity and date columns use the corresponding sort labels. |
| Sorting/filtering | The workstation sorts and filters the full dataset before pagination, including supplemental values stored in DockFlow. Whole records move together; keys, grouping and values are retained. |
| Formatting toolbar | Row height uses a compact 38px box; Middle is compact; border colour is inside its control; font/fill swatches are inside their labelled controls. Shared control heights and margins align the toolbar. |
| Worksheet dimensions/sticky header | Column widths determine table width. The obsolete fixed minimum widths were removed. Opaque sticky headers, the corner and row numbers have explicit layers; focused input text stays underneath them. |
| Updated status | A subtle relative-time status appears below the title and uses the actual successful refresh/save time. The old saved clock timestamp was removed. |
| Inbound Clearance Open | Open navigates to the matching Dressings/Savoury Receiving Records view, includes all related rows, selects the first matching row and identifies the group. Hidden related rows are included. Show all records returns to the whole dataset. |
| Clearance form | Prepare form retains the normal editable form and auto-fill workflow. Redundant complete-details PDF pages were removed. The original Dressings form and Savoury pallet tag remain. |
| Savoury pallet fields | Weight (kg), foil weight and type/allergen are exposed as separate receiving fields and auto-fill the existing tag. Native fields are used when present; otherwise values persist per row in existing metadata. Zero weights remain visible. |
| DR/PO/batch/lot rows | Add row clones the selected source into a distinct record with the same stable group. Every row can keep its own DR, PO, quantity, batch, lot and dates. No batch/lot cross-product or first-row collapse is introduced. |
| Clearance associations | Matches use shipment/source identity or material plus DR/PO. Once matched, the source association is saved in existing worksheet metadata, so editing all DR numbers does not detach the delivery group. |
| Monitoring Site time | The existing timer is beside status/Booked at the card's top right. A browser comparison of cards with and without Site time passed the equal-height check. Timer calculations are unchanged. |
| Supplier settings | Original containers allow content to grow, use a zero minimum width and retain visible overflow. Expanded appearance/materials and saved-driver sections were checked on mobile. Supplier permissions are unchanged. |
| Power Tool expiry | Validity / Expiry Date sits directly above final approval. A valid request, equipment or relevant category/question date prefills it and remains editable. An inspection/start date is not assumed to be expiry. |
| Power Tool validation | Missing, invalid or expired dates stop final approval. The UI shows “Please select a validity/expiry date before final approval.” beside the highlighted field, stays on the review and clears the error for a valid selection. This validation does not use a browser alert. |
| Approval integrity | Validation and QR preparation happen before final state changes. The request, equipment, expiry and approval history commit together. PostgreSQL locks the existing request and checks its expected status; a stale concurrent final approval rolls back. Successful retries return the existing equipment and QR. Earlier approval stages remain intact. |
| Dark worksheet | Unformatted text inherits the original theme/section colours. Saved explicit formatting remains honoured. Row-number and hover colours follow the theme. |

## CSS cleanup

Changes are in the original components and their existing stylesheet. No new patch stylesheet, duplicate toolbar or hidden replacement component was added. The selected-cell `::after` layer and selection-edge variants were removed; batch/actual-receipt backgrounds were consolidated into their existing table rules; conflicting stripe/read-only selectors exclude those sections; related `!important` overrides were removed. The redundant cell-position rule and forced 2,300/5,600px table minimum widths were removed. Controls reset the inherited form margins in their original worksheet rules. Existing responsive layouts and unrelated styles remain.

## Verified data path

SAPAnalyst calls Ubuntu's authenticated `/api/sap/rows` and edit endpoints. In the supplied production architecture, Ubuntu's existing company API client sends `describe`, `page`, `byKeys`, `add`, `save`, `sync` and `forClearance` operations through the HTTPS company bridge. The existing workstation worker forwards them to `dockflow-db`, which reads/writes the configured PostgreSQL source tables:

| Area | Default company table | Row handling |
| --- | --- | --- |
| Dressings | `Analysis.SAPAnalysisDressings` in the configured DockFlow company database | Native source IDs and columns; optional fields are selected/written only when present. |
| Savoury | `Analysis.SAPAnalysisSavoury` in the configured DockFlow company database | Native source IDs and Savoury mappings; the original combined `batch_no_lot_no` field remains. |

Existing environment variables can override these defaults. The update does not change the configured host, schema, table, credentials or bridge route. Queries retain line identities and do not group records by material. Sorting/filtering precede pagination; clearance matching has no arbitrary first-page cap.

Ubuntu's existing PostgreSQL application-state payload retains bookings, accounts, delivery lines, clearance drafts and worksheet metadata. Worksheet metadata contains formatting, hidden/deleted state, order, stable groups, saved clearance links and **only missing supplemental receiving values**. In Savoury, separate PO, SAP batch, supplier lot, manufacturing date, breakdown, pallet weight (kg), foil weight and type/allergen use native columns when available; otherwise they persist per source key in this existing payload. They are searchable, sortable, editable and included in exports/clearance. Native values take precedence over supplemental metadata, including a real native blank. No company-table columns are added. The old combined batch/lot value is preserved without guessing how to split it. Aggregate total weight and the existing generic type/classification fields are retained independently; they are not assumed to mean pallet weight or allergen.

Inbound Clearance obtains all real matching source rows through `forClearance` plus `byKeys` for saved associations/group copies. It auto-fills the following available fields into the normal record/form model:

| Form fields | Source mapping |
| --- | --- |
| Supplier, material code/description, quantity/UOM, DR, PO, SAP batch, supplier lot | Dressings native names; Savoury aliases include `supplier`, `itemCode`, `scheduledQty`, and separate supplemental fields when needed. |
| Manufacturing/expiry dates, breakdown, week, date | Native Dressings fields; Savoury `expirationDate`, `week`, scheduled date/date and available supplemental manufacturing/breakdown values. |
| Truck, driver, arrival/departure, helpers | Native receiving fields and existing booking values where the normal workflow uses them. Savoury plate/time fields are mapped to the standard model. |
| Actual receipt, pallets, remarks, unloading, QA and controllers | Available source receiving fields; Savoury `actualQty`, unloading times and remarks use the standard aliases. Existing manual clearance fields/revision rules are retained. |
| Savoury weight/foil/type | Explicit `palletWeightKg`, `foilWeight` and `palletType` values, using optional native fields or the per-row metadata described above. |

Each matching source row creates its own clearance record keyed by its source identity. Legacy aggregate actual receipts are distributed using the existing row-quantity logic, rather than repeated on every line. Native zero quantities/receipts and leading-zero material/batch codes remain valid. Company unavailability returns the existing unavailable/error response and preserves the draft; it does not invent SAP records.

**Savoury SDS:** the supplied production code already uses the shared matrix/header detection algorithm for Dressings and Savoury PM. No obsolete special Savoury detector remained to remove. That single implementation was retained and its Savoury PM recognition and separate area destination were covered by regression tests.

**Power Tool `expiresAt`:** the UI submits the chosen date as `expiresAt`; the backend validates a real calendar date, persists it on request and equipment, and treats a selected date as valid through the end of that date in Asia/Manila. Equipment validity/expiry, QR checks, Quick List and existing next-check display use the saved equipment expiry. Pending legacy requests and multi-stage histories are supported without recreation. Approved items include the existing empty renewal-history structure required by the strict workstation datastore.

## Exact changed application files

Paths below are relative to the existing Ubuntu Compose folder, or the workstation-api folder.

Ubuntu DockFlow production files:

```text
apps/dockflow/app/admin-ui.tsx
apps/dockflow/app/dockflow-app.tsx
apps/dockflow/app/dockflow-features.tsx
apps/dockflow/app/globals.css
apps/dockflow/app/sap-workbook.tsx
apps/dockflow/server/clearance.js
apps/dockflow/server/extensions.js
apps/dockflow/server/index.js
apps/dockflow/server/sap-postgres.js
apps/dockflow/shared/worksheet.js
```

Ubuntu Power Tool production files:

```text
apps/power-tool/server/approval-validity.js  (new)
apps/power-tool/server/dataStore.js
apps/power-tool/server/index.js
apps/power-tool/src/App.jsx
apps/power-tool/src/styles.css
```

Workstation production/version files:

```text
package.json
package-lock.json
server/dockflow/sap-postgres.js
server/power-tool/dataStore.js
server/power-tool-api.js
```

Updated/new regression files:

```text
Ubuntu:
apps/dockflow/tests/release-13.test.mjs
apps/dockflow/tests/release-13.2.test.mjs
apps/dockflow/tests/september-update.test.mjs
apps/dockflow/tests/workflow.test.mjs
apps/dockflow/tests/fixtures/pdf-template.mjs        (new, test-only)
apps/dockflow/tests/fixtures/workflow-clock.mjs      (new, test-only)

Workstation:
tests/sap-schema.test.mjs
tests/sap-fetch.test.mjs
tests/approval-13.2.test.mjs                        (new)
```

New release tooling is `apply_update.py`, `verify_package.py`, `changes-13.2.json`, `SHA256SUMS`, `VERSION`, `README.md` and these release notes in both ZIPs; Ubuntu also includes `deploy.sh`, `backup_live.sh`, `resolve_services.py` and `write_rollback.py`; workstation includes `deploy.py`. The Ubuntu backup helper is retained from 13.1 with the backup directory labelled 13.2.

## Data/configuration/version preservation

- **New database migrations: none.** Existing initialization/migration code remains available, and the supplied workstation keeps automatic migrations disabled. Supplemental values/links use the existing JSON payload.
- **Environment variable changes: none.** Existing `.env`, Compose, worker, portal, uploads, credentials and production PDF/image assets stay in place. The ZIPs do not contain live credentials or generated substitutes for production assets.
- **Existing data preserved:** accounts, categories, requests, approvals, equipment, QR identifiers, bookings, archive history and company receiving lines are retained. Source/image rollback retains production activity created after deployment.
- **Docker volumes reset: no.** Installers use build and `up --no-deps`; they do not run `down`, remove volumes or prune images/data.
- **Version:** Ubuntu DockFlow/Power Tool health reports release `13.2`; worksheet compatibility is `13.2` on Ubuntu and both workstation areas; workstation package/service version is `13.2.0`; Power Tool approval safety is `13.2`. Original internal DockFlow and Power Tool npm package versions are retained because those are separate from the release handshake.
- **Direct upgrade:** source hashes are checked against the fresh supplied Ubuntu export and supplied workstation 13.1 source. The entire delta is validated before writing. Reinstallation is idempotent and CRLF files retain their line endings. Unknown changes are refused before applying source; no intermediate release is needed. Unchanged earlier migration/configuration files remain in the existing deployment.

## Build/test results and limits

| Check | Result |
| --- | --- |
| DockFlow complete `node --test tests/*.test.mjs` suite | 70 passed, 0 failed |
| DockFlow Next production build/type check | Passed, all static pages generated |
| Workstation complete `npm test` suite | 22 passed, 0 failed |
| PostgreSQL receiving tests | 30,991 rows; full-dataset native/supplemental sorts, filters and paging; native edits/conflicts; all matching clearance rows; no company schema creation/alteration |
| Clearance integration | Independent DR/PO/quantity/batch/lot lines, Savoury tag-field auto-fill including zero weights, cloning/grouping, deleted rows, persistence/export and associations retained after every DR is edited |
| Power Tool API with PostgreSQL-backed company bridge fixture | Missing/invalid/expired dates block mutation; prefilling, selected expiry, QR/Quick List, automatic/manual approval, legacy pending requests, prior stages, concurrent approval and retry passed |
| Power Tool original `npm run test:postgres` | Passed normalized persistence, concurrent inserts, logs/usage and targeted deletion regression checks |
| Power Tool Vite production build | Passed |
| Chromium UI checks | Passed worksheet menus/actions, sticky layers, selection, controls, relative status, Clearance Open, equal-height Site time cards, Archive desktop/mobile, supplier mobile and dark worksheet; no page errors |
| Power Tool UI checks | Passed inline blank-date validation, no alert/no submission, mobile layout, error clearing, `expiresAt` submission and existing-date prefill |
| Installer checks | Both platforms passed dry-run/direct upgrade, repeat install, drift refusal and rollback; success/build-failure/restart-failure/health-failure fixtures passed |

Browser API fixtures were used for layout checks; PostgreSQL tests used PGlite/pg-mem and the actual application/datastore modules. A real Docker daemon and the live company network were not available in preparation. The deployment scripts perform the actual image builds, live database/bridge compatibility checks and health verification on your machines. The production Dressings PDF background was excluded from the source export: PDF endpoint tests use a test-only image preload, so the original printed form's visual appearance was not audited. That production asset is preserved untouched by the installer. Development screenshots, caches, node_modules, build outputs and installer mock Docker code are excluded from the ZIPs.

## Deploy: workstation first

Save both ZIPs in Downloads. Run workstation commands on the machine/shell that owns the existing company API Docker project, with Docker running and accessible. These steps are for upgrading the existing installation.

Windows PowerShell:

```powershell
Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\DockFlow-13.2-Workstation-Update.zip" -DestinationPath "$env:USERPROFILE\Downloads\dockflow-13.2-workstation"
py -3 "$env:USERPROFILE\Downloads\dockflow-13.2-workstation\DockFlow-13.2-Workstation-Update\verify_package.py"
py -3 "$env:USERPROFILE\Downloads\dockflow-13.2-workstation\DockFlow-13.2-Workstation-Update\deploy.py" --discover
```

If the company project runs in Linux/WSL, use that Linux shell and its local ZIP path:

```bash
python3 -m zipfile -e "$HOME/DockFlow-13.2-Workstation-Update.zip" "$HOME/dockflow-13.2-workstation"
python3 "$HOME/dockflow-13.2-workstation/DockFlow-13.2-Workstation-Update/verify_package.py"
python3 "$HOME/dockflow-13.2-workstation/DockFlow-13.2-Workstation-Update/deploy.py" --discover
```

The deployer discovers the current folder from the running service. An explicit existing `workstation-api` folder can be supplied instead of `--discover`. It checks checksums/source hashes and the existing Compose project; tags both current images; saves `.env`, Compose, changed source and read-only receiving/Power Tool snapshots; applies the delta; builds and replaces only `dockflow-db` and `power-tool-db`; checks company PostgreSQL health and both compatibility markers. The worker stays running. Image builds install dependencies using the existing Dockerfile/lockfile; no host npm install is needed. Record the printed backup and rollback paths. Application snapshots complement the database owner's existing full backups.

For an additional workstation health/log check, PowerShell:

```powershell
$dfSap = docker ps -q --filter label=com.docker.compose.service=dockflow-db
$dfTools = docker ps -q --filter label=com.docker.compose.service=power-tool-db
@'
const response=await fetch('http://127.0.0.1:8081/api/dockflow/health');
const h=await response.json();
console.log(JSON.stringify({ok:h.ok,serviceVersion:h.serviceVersion,areas:h.areas},null,2));
if(!response.ok||!h.ok||['DRESSINGS','SAVOURY'].some(a=>h.areas?.[a]?.worksheetVersion!=='13.2'))process.exitCode=1;
'@ | docker exec -i $dfSap node --input-type=module
@'
const response=await fetch('http://127.0.0.1:8082/api/power-tool/health');const h=await response.json();
console.log(JSON.stringify({ok:h.ok,approvalSafetyVersion:h.approvalSafetyVersion}));
if(!response.ok||!h.ok||h.approvalSafetyVersion!=='13.2')process.exitCode=1;
'@ | docker exec -i $dfTools node --input-type=module
docker logs --since 5m --tail 100 $dfSap
docker logs --since 5m --tail 100 $dfTools
```

## Deploy: Ubuntu

From Windows PowerShell, upload the Ubuntu ZIP:

```powershell
scp "$env:USERPROFILE\Downloads\DockFlow-13.2-Update.zip" reimar@174.138.21.21:~/
ssh -t reimar@174.138.21.21
```

At the Ubuntu `reimar@ubuntu-dockflow` prompt:

```bash
python3 -m zipfile -e "$HOME/DockFlow-13.2-Update.zip" "$HOME/dockflow-13.2-update"
python3 "$HOME/dockflow-13.2-update/DockFlow-13.2-Update/verify_package.py"
sudo bash "$HOME/dockflow-13.2-update/DockFlow-13.2-Update/deploy.sh"
```

Use the interactive SSH terminal for sudo. The earlier export error arose because a noninteractive SSH command had no terminal for the sudo password.

The installer discovers the active `dockflow-ubuntu` project and Power Tool build service from existing Compose. It validates the whole source delta, Compose, the matched workstation and build disk space. It backs up current source/config/uploads, DockFlow application state, Power Tool state and the three running images. It then builds `dockflow-api`, `dockflow-web` and the discovered Power Tool service while current containers remain running, recreates those three services with `--no-deps --wait`, and verifies Ubuntu plus remote workstation health. Other services/volumes are retained. A build failure restores source; a restart/health failure restores source and previous images.

For a full local Ubuntu PostgreSQL dump as an additional backup, use your existing database owner's backup procedure. If the application database is hosted by the local Ubuntu PostgreSQL service, this supplied-release command reads its actual name:

```bash
(
set -euo pipefail
umask 077
DF_DATA_BACKUP="$HOME/dockflow-db-before-13.2-$(date -u +%Y%m%dT%H%M%SZ).dump"
DF_API_ID="$(sudo docker ps -q --filter label=com.docker.compose.project=dockflow-ubuntu --filter label=com.docker.compose.service=dockflow-api)"
DF_DB_NAME="$(sudo docker exec "$DF_API_ID" node -e 'if(!process.env.DB_NAME)process.exit(1);process.stdout.write(process.env.DB_NAME)')"
test -n "$DF_DB_NAME"
sudo -u postgres pg_dump --format=custom --dbname="$DF_DB_NAME" > "$DF_DATA_BACKUP"
test -s "$DF_DATA_BACKUP"
printf 'Full database backup: %s\n' "$DF_DATA_BACKUP"
)
```

Run that additional dump **before** the deploy command if it applies to your DB host. The installer already takes its application snapshots immediately before replacing source.

Verify health/logs after deployment:

```bash
DF_API_ID="$(sudo docker ps -q --filter label=com.docker.compose.project=dockflow-ubuntu --filter label=com.docker.compose.service=dockflow-api)"
DF_ROOT="$(sudo docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$DF_API_ID")"
DF_POWER_SERVICE="$(sudo python3 "$HOME/dockflow-13.2-update/DockFlow-13.2-Update/resolve_services.py" "$DF_ROOT")"
sudo docker exec -i "$DF_API_ID" node --input-type=module <<'NODE'
import {companyApi} from './server/company-api-client.js';
const r=await fetch('http://127.0.0.1:3001/api/health');const local=await r.json();
const sap=await companyApi('api/dockflow/health'),tools=await companyApi('api/power-tool/health');
console.log(JSON.stringify({release:local.version,worksheetVersion:local.worksheetVersion,companyConnected:sap.ok,areas:sap.areas,approvalSafetyVersion:tools.approvalSafetyVersion},null,2));
if(!r.ok||local.version!=='13.2'||local.worksheetVersion!=='13.2'||!sap.ok||['DRESSINGS','SAVOURY'].some(a=>sap.areas?.[a]?.worksheetVersion!=='13.2')||!tools.ok||tools.approvalSafetyVersion!=='13.2')process.exitCode=1;
NODE
cd "$DF_ROOT"
sudo docker compose --project-name dockflow-ubuntu ps dockflow-api dockflow-web "$DF_POWER_SERVICE"
sudo docker compose --project-name dockflow-ubuntu logs --since 5m --tail 100 dockflow-api dockflow-web "$DF_POWER_SERVICE"
```

Open the existing DockFlow/Power Tool URLs and refresh the browser. Check Monitoring Archive controls and reason badges; Settings positions; Receiving Records menus, selection, scrolling, refresh status and Add row; separate DR/PO/lot/batch values after reload; Clearance Open and Prepare form in both areas; supplier settings on mobile; and Power Tool final approval with blank/existing/edited expiry plus an approved QR and Quick List. Review logs for DB/bridge errors. Use normal company-approved test records for any write checks.

## Rollback

Use the exact backup directory printed by each successful installer. Each backup contains its own rollback tooling and previous image tags. If reverting the release, restore Ubuntu first and then both workstation services so their previous compatibility versions match.

Ubuntu:

```bash
sudo bash '/actual/printed/.maintenance-backups/dockflow-13.2-TIMESTAMP/rollback.sh'
```

Workstation Windows PowerShell:

```powershell
py -3 'C:\actual\workstation-api\.maintenance-backups\dockflow-13.2-TIMESTAMP\deploy.py' --rollback 'C:\actual\workstation-api\.maintenance-backups\dockflow-13.2-TIMESTAMP'
```

Workstation Linux:

```bash
python3 '/actual/workstation-api/.maintenance-backups/dockflow-13.2-TIMESTAMP/deploy.py' --rollback '/actual/workstation-api/.maintenance-backups/dockflow-13.2-TIMESTAMP'
```

Replace the example paths with the printed paths. For an interrupted run, use the matching backup containing `rollback.json`. Source rollback restores changed files and removes files added by this release; image rollback recreates only the affected application services. It does not overwrite data with older snapshots, delete databases or remove volumes. Retain both backups/images until verification is complete. Any separate database restore must reconcile production activity with the database owner.
