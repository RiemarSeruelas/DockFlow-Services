# Ubuntu integration

The companion Ubuntu update changes both existing backend clients from worker-bridge requests to the new direct workstation API. Public browser API URLs and existing user authorization remain in the Ubuntu applications.

## Configuration

Set the same `COMPANY_API_BASE_URL` and `COMPANY_API_KEY` in both resolved Compose backend service environments. The URL must be an HTTPS address reachable **from the Ubuntu Docker containers**. The key must match one workstation `API_KEYS` entry. Do not put it in Next/Vite public environment variables or frontend source.

The client internally maps existing repository paths such as `api/dockflow/sap/SAVOURY/page` to `api/v1/dockflow/sap/SAVOURY/page`. Existing callers keep their method/argument contract. The old company bridge is not used.

Both clients:

1. Generate a random nonce and call the token-protected handshake.
2. Verify echoed nonce, HMAC proof, service, application list and protocol.
3. Cache successful verification for up to 30 seconds.
4. Send the token and correlated request ID with every real operation.
5. Forward bounded diagnostic actor metadata from the existing request context.
6. Distinguish bad key, bad proof, invalid configuration, unreachable API and database errors.

GET and POST fetches have bounded timeouts and reject redirects. HTTPS certificate validation remains enabled. HTTP is allowed only for explicitly enabled localhost test fixtures, never for arbitrary Agile/private network addresses.

## Check from Ubuntu

From the existing production Compose folder, after deploying the companion package:

```bash
docker compose exec -T dockflow-api node server/verify-company-api.mjs --local-dockflow
# Replace power-tool with your actual Power Tool Compose service name.
docker compose exec -T power-tool node server/verify-company-api.mjs --local-power-tool
```

The guarded installer resolves the Power Tool service automatically. An existing signed-in DockFlow admin can call `GET /api/integrations/company-api/status`; it forces a handshake and checks both workstation database modules. `/api/health` shows cached company API configuration/authorization state, while the admin check actively probes connectivity.

## IP webhook

The existing `POST /api/integrations/agile-wifi/webhook` and admin `GET /api/network/agile-wifi/workstation` remain available. They report/store the private workstation IP and forward the existing event to Power Tool. Their `AGILE_WIFI_WEBHOOK_SECRET` is separate from the new API token.

A successful webhook response proves Ubuntu received an outbound report. It does not prove Ubuntu can connect back to the workstation. Configure a reachable HTTPS route and run the active connection check. The webhook does not rewrite `COMPANY_API_BASE_URL`, database hosts or TLS settings.

## Logs

Ubuntu HTTP → authenticated workstation API → database query summaries use one request ID. Only initialization, user request and connection runtime records are printed. Existing business/audit database records are preserved. Workstation auth failures become Ubuntu integration errors (503) to avoid browser logout caused by an unrelated backend key.
