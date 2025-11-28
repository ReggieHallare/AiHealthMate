Clearing and re-initializing the analysis_history table

This repository uses MySQL for persistence. If you want to clear all saved analysis history and start fresh, you can either run SQL directly (see `init_tables.sql`) or use the protected admin endpoint.

Option A — run SQL (recommended if you have direct DB access)
1. Open a MySQL client and run the statements in `init_tables.sql`.

Option B — use the admin HTTP endpoint (requires ADMIN_KEY)
1. Set an `ADMIN_KEY` environment variable before starting the backend. Example (PowerShell):

```powershell
$env:ADMIN_KEY = 'your-secret-key'
node server.js
```

2. Call the admin endpoint with the header `x-admin-key` set to the same value:

```powershell
Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/admin/clear-history' -Headers @{ 'x-admin-key' = 'your-secret-key' }
```

Notes
- The admin endpoint will `DELETE FROM analysis_history` and attempt to reset the auto-increment counter. It is intended for development and maintenance only.
- For production systems, secure the server properly and prefer migrations and backups rather than blind deletions.
