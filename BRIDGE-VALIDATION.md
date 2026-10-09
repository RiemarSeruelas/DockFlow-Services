# Outbound bridge repair — validation

Build marker: `2026-10-09-outbound-bridge-1`. Express version 13.3.0, protocol 1; paired Ubuntu 13.3.1. No live production deployment or real Docker build was performed.

| Check | Result | Scope |
| --- | --- | --- |
| Shared Express/API/DB/OpenAPI/actual Ubuntu integrations | **27 tests passed; 0 failed/cancelled/skipped** | Includes exact old 13.2 bridge, repaired queue, both SAP areas, Power Tool reads, request IDs into SQL, timeout phases, auth, owner checks, multipart retries, persistent mutation replay guard, read-only application backup and complete approval/expiry/QR behavior through the outbound relay. PGlite fixtures, not company production data. |
| DockFlow supplied backend regression suite | **82 passed; 0 failed/skipped** | Existing delivery/import/receiving/account/private-trial/SDS and 13.3.1 behavior. |
| Configuration/diagnostic Python tests | **6 passed** | Per-caller legacy addresses, HTTPS/direct profile, key mismatch rejection, redaction and Nginx history. |
| Installer/rollback simulations | **18 deployment cases passed** | Plus source/reinstall/CRLF/exact rollback guards against supplied 13.2, 13.3 and 13.3.1 sources, and a read-only preflight case with no source/config/image/container mutations. Includes invalid/truncated-backup-decode rejection. Mock Docker and pg_restore only. |
| Power Tool supplemental checks | **Passed** | PostgreSQL-only server outage behavior, AgileWifi webhook and path-prefixed page/assets/API/direct QR routes. |
| Power Tool production build | **Passed** | Vite with production `/power-tool/` base/API prefix. |
| Scope comparison | **Passed** | Ubuntu frontend files, manifests, database schemas and business repositories match uploaded 13.3.1 byte-for-byte. Express business repositories retain the supplied standalone implementation. |

The final paired suite used Node 24.19.0 and `--test-concurrency=1`, also set in the package's `npm test`. Production Dockerfile remains Node 22. Reused installed dependencies match the supplied manifests; dependencies/runtime build output are excluded from the ZIPs. The exact old bridge test fixture is copied from the uploaded 13.2 Ubuntu source; HTTPS transport is routed to a local test server through an injected fetch function only in tests. Production still requires HTTPS and certificate validation.

Reproduce after `npm ci`, from `dockflow-services`, with the paired Ubuntu package beside it:

```bash
UBUNTU_SOURCE="$(cd ../DockFlow-13.3.1-Ubuntu-Update/source/apps && pwd)" npm test
```

In the Ubuntu package:

```bash
python3 verify_package.py
python3 tests/test_diagnostics.py
python3 tests/test_configuration.py
# Pass the actual source roots of the supplied earlier ZIPs:
python3 tests/test_installer.py --baseline /absolute/path/old-release/source
cd source/apps/dockflow
node --test tests/*.test.mjs
```

Remaining machine checks: actual company PostgreSQL schemas/permissions, authenticated worker polling/results, TLS/network route, real Docker builds, live backup/storage, guarded deployment, production app/read/browser checks and rollback readiness. A PostgreSQL backup header/catalog/full decode is not a trial restore. No database restore, migration bypass, image/volume pruning or production restart happened in this workspace.
