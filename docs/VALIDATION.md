# Validation — Express migration 13.3

## Completed automated checks

38 Node test cases passed across the two packages:

| Coverage | Cases |
|---|---:|
| Express configuration, authorization, HMAC handshake, health, validation and redacted request/SQL logs | 7 |
| Real PostgreSQL-compatible Receiving Records SQL, 42P18 regression, permissions/revisions, Power Tool transactions/conflicts and optional business audit table | 4 |
| OpenAPI validation, actual response/schema checks and local Swagger assets | 1 |
| Both actual Ubuntu clients, request/actor forwarding, negative handshake checks, standalone deployment preflight and full Power Tool approval/expiry/QR flow | 5 |
| Existing Ubuntu account security, IP webhook, Receiving Records, clearance, spreadsheet export and booking/scan workflows | 21 |

Two separate temporary PGlite databases run the real repository SQL in one Express process. End-to-end tests start the actual updated Ubuntu Power Tool backend and call it over HTTP, including missing/invalid expiry, existing dates, automatic review, retained multi-stage approval, retry/concurrent clicks, Quick List, QR validity and unavailable-workstation behavior. They verify one committed equipment record for competing final approval attempts.

Eight mocked Ubuntu Docker deployment cases also passed: success; build failure; restart failure; verification failure; preflight failure; mismatched backend configuration; snapshot backup failure; and custom Compose rejection. Source guards/rollback were tested against both the supplied 13.1 and 13.2 baselines, including CRLF line endings, reinstallation, exact source restoration and rejection of unknown edits. Rollback preserves the previous running backend URL/key, and logs omit private fixture secrets.

## Reproduce

For the workstation project alone, Node 22+:

```bash
npm ci
npm test
```

The five joint Ubuntu tests are skipped unless `UBUNTU_SOURCE` points to the companion package's `source/apps` folder with each app's dependencies installed. After installing dependencies in both Ubuntu source app folders:

```bash
UBUNTU_SOURCE=/absolute/path/DockFlow-13.3-Ubuntu-Update/source/apps npm test
```

PowerShell equivalent:

```powershell
$env:UBUNTU_SOURCE = 'C:\absolute\path\DockFlow-13.3-Ubuntu-Update\source\apps'
npm test
```

In `source/apps/dockflow`:

```bash
node --test tests/company-bridge.test.mjs tests/release-13.2.test.mjs tests/company-webhook-separation.test.mjs tests/receiving.test.mjs tests/agile-wifi-webhook.test.mjs tests/account-security.test.mjs tests/workflow.test.mjs
```

In the Ubuntu package root, use a previous supplied source folder for mocked installer checks:

```bash
python3 tests/test_installer.py --baseline /absolute/path/previous-release/source
```

## Target-machine checks

No production deployment or database migration was run. Docker is unavailable in this validation runtime, so real container builds, PostgreSQL server/permissions, approved routing and TLS certificates must be checked on your machines. The guarded Ubuntu installer performs the real handshake/database preflight before source changes, builds the images and validates both deployed APIs. The new standalone workstation must pass `/ready` before cutover.

The frontend files are byte-identical to the supplied 13.2 package; this change modifies backend transport and service packaging. Existing 13.2 UI behavior is exercised by the retained workflow tests. No new CSS or UI workaround was added.
