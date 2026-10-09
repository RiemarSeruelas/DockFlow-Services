# Deployment and cutover

## Workstation

Use a new folder for this standalone Express service. Configure `.env` using the example and existing company database connection details. Start with `docker compose up -d --build`. The one `api` container runs both modules on port 5230. Database data stays in existing company PostgreSQL installations; this Compose file creates no database container/volume.

Check `http://localhost:5230/health`, `/ready` and `/docs/`. A live process can return `/health` 200 while `/ready` returns 503 because WiFi/database access or schemas are unavailable. Fix readiness before updating Ubuntu.

## Approved HTTPS route

Your senior developer/network administrator must supply a stable HTTPS endpoint that the Ubuntu containers can reach. This can be a company-approved VPN route plus reverse proxy, or another approved reverse proxy connection. Do not assume a private WiFi address is reachable from the server.

Bind the local API only to the interfaces required by that route. The Compose default host binding is `127.0.0.1`; set `API_BIND_HOST` only when your approved proxy/network design needs another interface. Port 5230 is HTTP behind the proxy. The Ubuntu integration rejects plaintext remote HTTP and invalid TLS certificates.

A same-host Nginx configuration example is in `nginx-example.conf`. Replace the hostname/certificate paths and install it in your approved proxy; it is not automatically provisioned by this ZIP. The proxy must forward `/api/v1/*`, `/health`, `/ready` and optionally docs to this Node service. Set body and request timeout limits sufficient for the existing Power Tool snapshots.

If the workstation is offline or outside the approved network, company data operations return an explicit unavailable error. No API can create network access solely from an outbound IP webhook.

## Ubuntu update order

1. Start the new workstation API, configure the approved HTTPS route and verify both modules.
2. Extract the companion Ubuntu update into a staging folder, separate from production.
3. Set `COMPANY_API_BASE_URL` / `COMPANY_API_KEY` in both existing backend services' resolved Compose environment. Keep the integration key out of frontend services.
4. Run `python3 verify_package.py` then `sudo bash deploy.sh` from the extracted Ubuntu update.
5. The deployer checks the supplied baseline, new API handshake/schema compatibility, backups and source delta before rebuilding the existing application services.
6. Use the new admin connection check and open Receiving Records / Power Tool approvals through the existing applications.
7. Stop the old workstation worker/per-app API containers using their old Compose project after cutover is confirmed. Keep their files and existing data for the rollback window. Do not delete database volumes or company tables.

## Rollback

The Ubuntu installer prints a private backup path with `rollback.sh`. Run that script to restore the previous source and images. Its Compose override restores the previous running integration URL/key so older images can still reach the old bridge. If rolling back to a worker release, restart the old workstation worker first. A source-only rollback occurs automatically if a build fails; running containers remain on their original runtime settings.

This workstation service is a new directory, so rollback is stopping this `api` container and restarting the old workstation stack. It does not migrate company data or delete old files. Keep approved database backups under your existing database procedures.

## Git handoff

Commit `dockflow-services` to the senior developer's chosen repository. The format and code are ready; no remote URL was supplied, so this package does not invent a `git pull` destination. Ignore `.env`, `node_modules` and runtime data. Once committed, teammates can pull that repository and run `docker compose up -d --build` after configuring private environment values.
