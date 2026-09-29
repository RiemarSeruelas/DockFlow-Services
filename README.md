# DockFlow + Power Tool: workstation data worker (10.8)

This ZIP contains **two folders**. Give the whole ZIP to the senior developer; put the ubuntu folder on your Ubuntu server. This version replaces the earlier **10.7 company API** package.

## What happens in plain language

1. You sign into DockFlow on Ubuntu and open SAP Analyst / Receiving Records, or use Power Tool.
2. Ubuntu creates a specific read or write job. No raw SQL can be submitted through this bridge.
3. The Docker worker on the AI workstation **calls out** to the existing https://dockflow.myvnc.com site, picks up that job, uses its company PostgreSQL access, and posts the result back.
4. Ubuntu answers the app. Edits go through the same path and are committed to the appropriate company database.

The **existing Agile WiFi webhook remains separate**: it still receives and stores the changing workstation IP. It does not provide a database route and does not need modification. There is no new workstation hostname, inbound workstation port, SSH login, or new public domain. The workstation must be able to reach **dockflow.myvnc.com on HTTPS port 443**, and its Docker containers must be able to reach company PostgreSQL. The Ubuntu site must already be reachable over its existing HTTPS URL.

| What | Where it lives |
| --- | --- |
| DockFlow schedules, users, app audit, uploads | Existing Ubuntu Dockflow DB and uploads volume |
| SAP Analyst / Receiving Records | Company PostgreSQL database DockFlow, schema Analysis; queried on workstation |
| Power Tool business records | Company PostgreSQL database confirmation_powertool_machine, schema power_tool; queried on workstation |
| Power Tool access audit | Existing Ubuntu Dockflow DB |
| Changing workstation IP report | Existing Ubuntu webhook, unchanged |

The company API key is **new and separate** from AGILE_WIFI_WEBHOOK_SECRET. Use the same COMPANY_API_KEY in both new .env files. Database accounts/passwords belong only on the workstation.

## Senior developer: AI workstation

1. Extract the ZIP on the workstation. Open **PowerShell** in the extracted workstation-api folder, with Docker Desktop running.

2. Make a private settings file and open it:

~~~powershell
Copy-Item .env.example .env
notepad .env
~~~

3. Fill COMPANY_DB_HOST with the PostgreSQL host **reachable from the workstation**, COMPANY_DB_PORT (normally 5432), and credentials for each database. The two databases can share the same host and port while using separate names, users, or passwords. Database names and schemas are set in compose.yaml; confirm them with the DBA. Set COMPANY_DB_SSL as required by the DBA. The worker never sends these credentials to Ubuntu.

4. Generate one random key in PowerShell, paste it as COMPANY_API_KEY in the workstation .env, and share that exact key with the Ubuntu administrator over an approved private channel:

~~~powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
~~~

5. Leave UBUNTU_BRIDGE_URL set to the **already existing** HTTPS URL in .env:
https://dockflow.myvnc.com/dockflow/api/integrations/company-bridge

6. Check connectivity from the workstation, then start the three private Docker services:

~~~powershell
Test-NetConnection dockflow.myvnc.com -Port 443
Test-NetConnection YOUR_COMPANY_DB_HOST -Port 5432
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail 60 worker
~~~

No Docker port is published. The worker calls Ubuntu; DockFlow and Power Tool SQL containers are private to this Compose network. It is normal for worker polling to return HTTP 404 in logs until the new Ubuntu API has been started.

**Ask your DBA to back up and verify both company databases first.** The worker has automatic table creation/migration disabled. If tables, permissions, or existing Power Tool data are missing, fix those with a reviewed migration before turning the apps over.

## Ubuntu administrator: your part

1. On your **own Windows PC** (not inside the SSH prompt), copy the same ZIP to Ubuntu, then SSH:

~~~powershell
scp "$env:USERPROFILE\Downloads\DockFlow-Company-API-10.8-Outbound.zip" reimar@174.138.21.21:~/
ssh reimar@174.138.21.21
~~~

2. Extract on the large mounted disk. The install command makes the release directory yours, preventing the earlier permission error:

~~~bash
RELEASES=/mnt/volume_sgp1_1789540146734/dockflow-releases
sudo install -d -o "$USER" -g "$(id -gn)" -m 0755 "$RELEASES/DockFlow-Company-API-10.8-Outbound"
unzip -q ~/DockFlow-Company-API-10.8-Outbound.zip -d "$RELEASES"
cd "$RELEASES/DockFlow-Company-API-10.8-Outbound/ubuntu"
~~~

3. Copy your **existing Ubuntu** .env from your running 10.6 release; do not use the workstation .env. If your active release has a different path, use its .env instead:

~~~bash
cp /mnt/volume_sgp1_1789540146734/dockflow-releases/DockFlow-Ubuntu-10.6-Workstation-IP-Webhook/.env .env
chmod 600 .env
nano .env
~~~

Add **COMPANY_API_KEY=the exact key from the senior developer**. Keep your existing DockFlow local DB password, admin/JWT secrets, webhook secret, Power Tool passwords, mail settings, and DOCKFLOW_UPLOADS_VOLUME. Existing COMPANY_DB_HOST=127.0.0.1 and COMPANY_DB_PORT=15432 entries can remain in .env but are unused by this release. **Do not set a workstation URL in Ubuntu** and do not put company DB passwords there; Compose points both Ubuntu apps to their own local relay.

4. Back up the local database and uploads before switching. The backup directory is inside this release so you can create it:

~~~bash
BACKUP="$PWD/backup-before-10.8"
mkdir -p "$BACKUP"
sudo -u postgres pg_dump -Fc -d Dockflow > "$BACKUP/Dockflow.dump"
pg_restore --list "$BACKUP/Dockflow.dump" >/dev/null
UPLOADS_PATH=$(sudo docker volume inspect "$(sed -n 's/^DOCKFLOW_UPLOADS_VOLUME=//p' .env | tail -n 1)" --format '{{.Mountpoint}}')
sudo tar -C "$UPLOADS_PATH" -czf "$BACKUP/uploads.tgz" .
ls -lh "$BACKUP"
~~~

Check the old Power Tool data source and mounts, and save a backup of its active data as well. If the old container uses a JSON volume or company DB records are not already migrated, leave that container running until its data is migrated; this package will not seed an empty company database.

~~~bash
sudo docker inspect dockflow-platform-power-tool --format '{{range .Mounts}}{{.Type}} {{.Name}} {{.Source}} -> {{.Destination}}{{println}}{{end}}'
curl -sS http://127.0.0.1:5057/api/health
~~~

5. Check settings and build while old containers are still running:

~~~bash
sudo docker compose config --quiet
sudo docker compose build dockflow-api dockflow-web power-tool
~~~

6. Switch DockFlow using the same host ports as before. These commands assume your old container names are still dockflow-poc-server-web-1 and dockflow-poc-server-api-1; check docker ps before stopping them.

~~~bash
sudo docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
sudo docker stop dockflow-poc-server-web-1 dockflow-poc-server-api-1
sudo docker compose up -d --no-build dockflow-api dockflow-web
curl -fsS http://127.0.0.1:3001/api/health
~~~

7. Have the senior developer start the workstation worker if it is not running. Then verify that a **real SAP request** can travel out and back. These checks may take several seconds because they wait for the worker:

~~~bash
sudo docker compose exec -T dockflow-api node server/verify-company-postgres.mjs
sudo docker compose logs --tail 60 dockflow-api
~~~

Open SAP Analyst while signed in and check the actual rows. Opening a protected DockFlow data endpoint without signing in still returns "Authentication required"; that is normal app login, independent of this worker key. An error saying the workstation timed out means the worker has not polled or could not deliver a result.

8. Only after the existing Power Tool data is verified in the company DB, switch Power Tool and check it:

~~~bash
sudo docker stop dockflow-platform-power-tool
sudo docker compose up -d --no-build power-tool
sudo docker compose exec -T power-tool node server/verify-company-postgres.mjs
curl -fsS http://127.0.0.1:5057/api/health
~~~

Power Tool health should show database.provider=postgresql. Test a real read and a small approved edit in each app. If Power Tool fails, return to its old container:

~~~bash
sudo docker compose stop power-tool
sudo docker start dockflow-platform-power-tool
~~~

Keep the old release and volumes for rollback. Do not run docker compose down -v or docker volume prune. If the workstation is offline, company reads/edits wait up to about 55 seconds and fail; Ubuntu's own database stays in place. A request that times out during a write should be checked in the company DB before trying again.

## For the senior developer to inspect

- workstation-api/server/dockflow-api.js: fixed SAP operations, using the existing repository code in server/dockflow/sap-postgres.js.
- workstation-api/server/power-tool-api.js: fixed Power Tool read/write/log operations, using server/power-tool/dataStore.js.
- workstation-api/server/worker.js: outbound HTTPS poll and result delivery.
- ubuntu/apps/dockflow/server/company-bridge.js: authenticated job queue on Ubuntu. This version keeps jobs in memory for the life of a request; a restart interrupts outstanding jobs. It does not accept arbitrary SQL.

The bridge is authenticated independently of DockFlow user login. Only Ubuntu servers hold COMPANY_API_KEY on the app side; browsers never receive it. The already working IP webhook uses AGILE_WIFI_WEBHOOK_SECRET and stays separate.
