# DockFlow 13.2 workstation update

Upgrade the existing supplied 13.1 company API source. Full updated source is in `source/`; use the guarded deployer instead of overwriting the project folder. Keep the existing .env and Compose.

Read **DockFlow-13.2-Release-Notes.md** for all changes, data mapping, test results, deployment and rollback steps. Install this workstation update first, then the matched Ubuntu update.

Windows PowerShell, in this extracted folder with Docker running:

```powershell
py -3 verify_package.py
py -3 deploy.py --discover
```

Linux:

```bash
python3 verify_package.py
python3 deploy.py --discover
```

An existing workstation-api folder can replace --discover. The installer validates source/checksums, backs up changed source/config/data/images, rebuilds and replaces only dockflow-db and power-tool-db, and verifies company database/version health. The worker remains running. It prints the actual rollback command. No database/volume deletion or automatic migrations are performed. Unknown source changes or custom Compose overrides are refused before applying source.
