# Check-In reference

Everything beyond the basics: configuration, Docker details, HTTPS, users and sign-in, the API, the dashboard, the agents and performance. For getting started, see the [README](../README.md).

## Contents

- [Quick start](#quick-start)
- [Configuration (environment variables or `.env`)](#configuration-environment-variables-or-env)
- [Running in Docker](#running-in-docker)
- [Built-in HTTPS](#built-in-https)
- [Users, roles and sign-in](#users-roles-and-sign-in)
- [API](#api)
- [Dashboard](#dashboard)
- [Performance](#performance)
- [Agents (Windows and Linux)](#agents-windows-and-linux)
- [Tests](#tests)
- [Project layout](#project-layout)
- [Running as a service on Windows](#running-as-a-service-on-windows)

## Quick start

Requires **Node.js 22.13 or newer** (Node 24 LTS recommended). The database is the SQLite engine built into Node, so there's nothing native to download or compile, and no C++ build tools are needed.

```bash
npm install
cp .env.example .env      # optional (on Windows: copy .env.example .env)
npm start
```

Open http://localhost:3000. The first time, the login page asks you to **create the admin account** (or set `ADMIN_USERNAME` / `ADMIN_PASSWORD` to create it automatically).

To load some sample data, run `API_KEY=<key> npm run seed` (PowerShell: `$env:API_KEY="<key>"; npm run seed`). Check-ins need the API key; see it on the Add Device page, or start the server with your own `API_KEY` the first time.

## Configuration (environment variables or `.env`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Interface to bind |
| `DB_PATH` | `data/checkin.db` | SQLite file (created automatically) |
| `HISTORY_LIMIT` | `100` | History entries kept **per record**. `0` turns history off, `-1` keeps everything. If you lower it, existing history is trimmed at the next startup. |
| `API_KEY` | *(empty)* | The API key to use on **first start** (otherwise one is generated). If a key saved by an older version matches it, that key becomes viewable. After that, manage it on the Add Device page or in **Admin → API key** |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | *(empty)* | Creates the first admin automatically if no users exist |
| `APP_SECRET` | *(generated)* | Encrypts the stored SSO client secret and sign-in cookies. If empty, a random one is saved to `data/.app-secret`. Back that file up with the database |
| `SESSION_TTL_HOURS` | `12` | Browser sign-in lifetime, extended while in use |
| `TRUST_PROXY` | *(empty)* | Set (`true`, a hop count, or proxy IPs) when behind a reverse proxy / load balancer, so HTTPS and client IPs are detected |
| `HTTPS_PORT` | `3443` | Port for the built-in HTTPS server (only used when HTTPS is turned on in Admin → HTTPS) |
| `TLS_DIR` | `data/tls` | Where certificates are stored (next to the database by default, so inside the Docker volume) |
| `TLS_DISABLE` | `false` | Break-glass: `true` forces HTTP only, ignoring saved HTTPS settings |
| `COOKIE_SECURE` | `auto` | `auto` marks cookies Secure on HTTPS requests; or force `true` / `false` |
| `CORS_ORIGIN` | *(empty)* | Set to an origin (or `*`) to allow calls from browsers on other sites |
| `MAX_BATCH` | `5000` | Maximum writes per transaction |
| `MAX_FIELDS` | `500` | Maximum fields per record |
| `BODY_LIMIT_MB` | `10` | Maximum size of a JSON or form body |
| `IMPORT_LIMIT_MB` | `200` | Maximum size of an uploaded CSV |
| `LOG_LEVEL` | `warn` | `silent`, `error`, `warn`, `info` or `debug` |

## Running in Docker

The image is based on `node:24-alpine` and runs as the unprivileged `node` user. It has a health check on `/health` and shuts down cleanly on `docker stop`, flushing pending writes. Data (the database, its WAL files and the generated app secret) lives in the `/app/data` volume.

```bash
docker compose up -d --build
docker compose logs -f
```

Then open http://localhost:3000 (change the host port with `PUBLISH_PORT` in `.env`). Every setting in the configuration table can go in a `.env` file next to `docker-compose.yml`; compose passes it to the container. `HOST`, `PORT` and `DB_PATH` are fixed inside the container.

Without compose:

```bash
docker build -t check-in-api .
docker run -d --name check-in --init -p 3000:3000 -v checkin-data:/app/data \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD='change-me-please' check-in-api
```

Things to know:

- **Run one container only.** SQLite is a single-writer file database. Don't scale to more than one replica or point two containers at the same volume.
- **Use a named volume, not a Windows folder bind mount.** SQLite's WAL file locking is unreliable on host folders bind-mounted through Docker Desktop. The compose file already uses the named volume `checkin-data`.
- **Set `APP_SECRET`** in production. Otherwise a secret is generated in the volume (`/app/data/.app-secret`) and must be backed up with the database, or the stored SSO client secret can't be decrypted.
- **No reverse proxy?** Use [built-in HTTPS](#built-in-https) and publish port 3443 too.
- **Behind a reverse proxy or load balancer** (nginx, Traefik, Azure App Gateway and so on) that terminates HTTPS: set `TRUST_PROXY=true` (or the hop count), and set **Public URL** in Admin → Single sign-on, so cookies are marked Secure and the Entra redirect URI uses your public `https://` address. Server-Sent Events (live updates) need response buffering turned off for `/api/events`. The app sends `X-Accel-Buffering: no` for nginx.
- **Backups:** stop the container (or accept a crash-consistent copy), then archive the volume:
  ```bash
  docker compose stop
  docker run --rm -v check_in_checkin-data:/data -v "$PWD":/backup alpine tar czf /backup/checkin-backup.tgz -C /data .
  docker compose start
  ```
  The volume name is `<project>_checkin-data`; `docker volume ls` shows it.
- **Moving existing data into the container:** copy your current `data/checkin.db` (stop the app first so the WAL is merged) and `data/.app-secret` into the volume, for example with `docker cp`.

### Prebuilt images and publishing to Docker Hub

`.github/workflows/docker-publish.yml` builds the image for **linux/amd64 and linux/arm64** (for example Intel/AMD servers, Apple silicon, AWS Graviton and 64-bit Raspberry Pi OS) and pushes it to Docker Hub. It runs the tests first.

| Trigger | Tags pushed |
|---|---|
| Push to `main` | `latest`, `sha-<commit>` |
| Push a tag like `v1.2.3` | `1.2.3`, `1.2`, `1`, `sha-<commit>` |
| Run it manually (Actions → Publish Docker image → Run workflow) | `sha-<commit>` (plus `latest` when run on `main`) |

One-time setup:

1. On Docker Hub, create an **access token** with *Read & Write* scope (Account settings → Personal access tokens).
2. In the GitHub repository, go to **Settings → Secrets and variables → Actions** and add:
   - **Repository secret** `DOCKERHUB_USERNAME`: your Docker Hub user or organization.
   - **Repository secret** `DOCKERHUB_TOKEN`: the access token.
   - *(Optional)* **Repository variable** `DOCKERHUB_IMAGE`: the full image name. The default is `<DOCKERHUB_USERNAME>/check-in`.

   Use *Repository* secrets. Ones saved under an *Environment* aren't visible to this workflow. Because the username is a secret, GitHub shows it as `***` in the workflow logs.
3. Push to `main`, or tag a release: `git tag v1.0.0 && git push origin v1.0.0`.

To run a published image instead of building locally, replace `build: .` in `docker-compose.yml` with `image: <user>/check-in:1.0.0`.

`.github/workflows/ci.yml` runs the tests on Node 22 and 24 and does a Docker build and smoke test on every push and pull request.

## Built-in HTTPS

If the app can't sit behind a reverse proxy or load balancer, it can serve HTTPS itself. Everything is configured in **Admin → HTTPS** (admins only), and certificates are saved in the data volume (`data/tls`), so they survive container rebuilds.

1. **Install a certificate**, in one of three ways:
   - **PEM files:** the certificate (with intermediates after it, as a full chain) plus the private key. Encrypted keys are accepted with their password and stored decrypted, as nginx does.
   - **PFX / P12:** the usual export from Windows certificate stores and many CAs. The password is stored encrypted with the app secret.
   - **Generate self-signed:** for testing or internal use. Clients warn until they trust it; use **Download certificate** to install it as trusted.

   The upload is checked before anything is saved: wrong passwords, a key that doesn't match the certificate, and unreadable files are all rejected with a clear message.
2. **Choose a mode:**
   - **Off:** HTTP only (the default).
   - **HTTPS and HTTP:** both work, which is handy while moving devices over.
   - **HTTPS only:** HTTP gets a `307` redirect to HTTPS. A 307 keeps POST bodies, so check-ins that follow redirects still work. `/health` stays on HTTP for container health checks.
3. Optionally turn on **HSTS**, and set **Public HTTPS port** if clients reach the server on a different port than it listens on (for example `443` mapped to `3443`).

Notes:

- Changes apply immediately, with no restart. Replacing a certificate swaps it on the running server. If HTTPS can't start (for example, the port is in use), the mode change is rolled back so HTTP never redirects to a dead port.
- The status panel shows the certificate's names, issuer, expiry (with a warning under 30 days) and SHA-256 fingerprint. The startup log also warns when the certificate is close to expiry.
- **Automated renewals:** copy `cert.pem` and `key.pem` into `data/tls` (for example from certbot or another ACME client). Changes are picked up within a minute.
- Minimum protocol is TLS 1.2.
- **Locked out?** Start with `TLS_DISABLE=true` to force HTTP only, fix the settings, then remove the variable.
- **Docker:** the container listens for HTTPS on `3443`. Publish it with `PUBLISH_HTTPS_PORT=443` in `.env` (compose maps `443:3443`). The container runs as a non-root user, so it can't bind port 443 itself. Set **Public HTTPS port** to `443` so redirects point at the right port.
- Using Entra sign-in over HTTPS? Set **Public URL** in Admin → Single sign-on to your `https://` address, and register that redirect URI in Entra.

## Users, roles and sign-in

### Roles

| | Reader | User | Power user | Admin |
|---|:-:|:-:|:-:|:-:|
| View records, history and activity | ✓ | ✓ | ✓ | ✓ |
| Save personal views; use team views | ✓ | ✓ | ✓ | ✓ |
| Check in (API) | | ✓ | ✓ | ✓ |
| Import CSV, export CSV | | ✓ | ✓ | ✓ |
| Delete records (single or multi-select) | | ✓ | ✓ | ✓ |
| **Clear all**, pause/resume check-ins, change the active threshold, create/edit/delete team views, set up status boxes | | | ✓ | ✓ |
| See and regenerate the API key | | | ✓ | ✓ |
| Manage users and single sign-on; use a custom API key or stop requiring one; turn port checks on or off | | | | ✓ |

The active threshold is now a shared, server-side setting. When a power user changes it, every open dashboard updates. Permissions are enforced by the server; the dashboard also hides what your role can't do.

### Ways to authenticate

| Method | Who uses it | How |
|---|---|---|
| **Password sign-in** | People, in the dashboard | Login page. Creates an HttpOnly session cookie. Writes also need the session's CSRF token, which the dashboard sends for you |
| **Microsoft Entra ID (SSO)** | People, in the dashboard | **Sign in with Microsoft** on the login page |
| **HTTP Basic** | Scripts that should act as a specific user | `curl -u alice:password …`. The script gets that user's role |
| **API key** | Devices and services | `X-API-Key: <key>`, `Authorization: Bearer <key>` or `?api_key=<key>`. The key acts as a **User** |

Check-ins **require the API key** by default (or a user with at least the User role). A key is generated on first start and stored encrypted. **Power users and admins** can see and regenerate it on the **Add Device** page, which fills it into the install command, and in **Admin → API key**. Only **admins** can use their own key or turn the requirement off. Reading data always requires sign-in, Basic auth or the key.

Upgrading from a version where check-ins were open: if the database already has records and no key, check-ins stay open so your devices keep working, and a key is generated so an admin can turn the requirement on. A key saved by an older version can't be shown (only its hash was stored); start once with `API_KEY` set to it, or regenerate it.

Failed sign-ins are rate-limited (10 attempts per 15 minutes per IP and username). Passwords are hashed with scrypt, the API key is stored as a SHA-256 hash, and the SSO client secret is encrypted with AES-256-GCM.

### Managing users (Admin → Users)

- **Add user**: give them a username, role and password. Or choose *Single sign-on only*: the account is linked on their first Microsoft sign-in when their Entra sign-in name (UPN) matches its username or email. From then on the account is tied to their Entra object ID.
- **How accounts are linked:** only *single sign-on only* accounts (no password) that aren't already linked are ever linked automatically. Accounts with a password are never linked, guests from other tenants are never linked, and the user-editable `email` claim is never used for matching. A Microsoft sign-in that doesn't match gets its own new account (if auto-create is on) instead. To move an existing password user to Microsoft sign-in, remove their password in **Reset password**.
- Change a role from the drop-down, reset or set a password, disable or enable, or delete.
- You can't delete or disable yourself, or remove the last active admin.
- Anyone signed in can change their own password from the account menu.

### Setting up Microsoft Entra ID SSO

1. In the **Microsoft Entra admin center**, go to **App registrations → New registration** and choose *Single tenant*.
2. Under **Authentication**, add a **Web** platform with the redirect URI shown in **Admin → Single sign-on**. It looks like `https://your-host/auth/oidc/callback`.
3. Under **Certificates & secrets**, create a **client secret** and copy its *value*.
4. *(Recommended)* Under **App roles**, create roles with these values, allowed member type *Users/Groups*:
   `CheckIn.Admin`, `CheckIn.PowerUser`, `CheckIn.User`, `CheckIn.Reader`.
   Then assign people or groups to them in **Enterprise applications → (your app) → Users and groups**.
   *Alternative:* add a groups claim (**Token configuration → Add groups claim**) and map group object IDs to roles.
5. In the dashboard, open **Admin → Single sign-on**. Enter the **Directory (tenant) ID**, **Application (client) ID** and **client secret**, turn on **Allow sign-in with Microsoft Entra ID**, then select **Save**. **Test connection** checks the tenant.
6. If the app runs behind a proxy or load balancer, set **Public URL**, for example `https://checkin.contoso.com`, so the redirect URI is correct. Also set `TRUST_PROXY`.

SSO behaviour (configurable in the same screen):

- **Role mapping:** the token's `roles` (app roles) and `groups` claims are matched to roles. If several match, the highest role wins.
- **Create users automatically on first sign-in:** on by default. Turn it off to allow only users an admin has already added.
- **Update role from Entra on every sign-in:** on by default. Turn it off if you'd rather manage roles in the dashboard.
- **Role when no mapping matches:** `Reader` by default, or *No access* to deny sign-in.
- **Password sign-in:** *Everyone*, or *Admins only*. With *Admins only*, the login page shows only Microsoft sign-in, plus a small **Administrator sign-in** link as a break-glass way in.

Signing out ends the session in this app only. It doesn't sign the person out of Microsoft.

## API

### Check in (create or update): `POST /api/checkin`

Fields can come from the query string, a form body, a JSON body, or a mix (body values take priority). `id` is matched in any case (`id`, `ID`, `Id`).

```bash
# Query string
curl -X POST "http://localhost:3000/api/checkin?id=device-1&status=ok&fred=red"

# Form body
curl -X POST http://localhost:3000/api/checkin -d "id=device-1&status=warn"

# JSON body (keeps types: numbers, booleans, objects)
curl -X POST http://localhost:3000/api/checkin \
  -H "Content-Type: application/json" \
  -d '{"id":"device-1","cpu":42,"tags":["edge","east"]}'

# PowerShell
Invoke-RestMethod -Method Post "http://localhost:3000/api/checkin?id=device-1&status=ok"
```

Response (`201` when created, `200` when updated):

```json
{
  "ok": true,
  "action": "updated",
  "changed": ["status"],
  "record": { "id": "device-1", "created": "2026-10-06T20:00:00.000Z", "modified": "2026-10-06T20:05:00.000Z",
              "_version": 2, "_rev": 17, "status": "warn", "fred": "red" }
}
```

How updates work:

- Fields you send are added or overwritten. Fields you don't send stay as they are.
- To **remove** a field, send it as JSON `null`, for example `{"id":"device-1","fred":null}`.
- `created` and `modified` are ignored if a caller sends them.
- A check-in that changes no values still updates `modified` and adds a history entry, with an empty change list.

**Bulk:** POST a JSON array to check in many records in one request. Valid items are saved even if some items fail.

```bash
curl -X POST http://localhost:3000/api/checkin -H "Content-Type: application/json" \
  -d '[{"id":"a","status":"ok"},{"id":"b","status":"down"}]'
```

### Read

| Method & path | Description |
|---|---|
| `GET /api/records` | All records. Optional parameters: `q` (text search), `f.<field>=<value>` (exact match; several are combined with AND, or with OR when you add `match=any`), `sort=<field>`, `order=asc\|desc`, `limit`, `offset`, `sinceRev=<n>` (only records changed since that revision), `status=active\|aging\|stale` (comma-separate for several), `createdAfter`, `createdBefore`, `modifiedAfter`, `modifiedBefore` (an ISO date/time such as `2026-10-01T09:00:00Z`, or a relative age such as `15m`, `2h`, `7d`, `1w`). Status and date parameters always combine with AND, even with `match=any` |
| `GET /api/records?idsOnly=1` | Just the id of every record, plus the current `rev` |
| `GET /api/records/:id` | One record |
| `GET /api/records/:id/history?limit=500` | One record and its history, newest first. Each entry includes `changes: { field: [old, new] }` and a full snapshot in `data` |
| `GET /api/history?limit=200` | Recent activity across all records, newest first. `before=<hid>` pages back, `after=<hid>` returns only newer entries, and `data=0` leaves out each entry's full snapshot (just the changes) |
| `GET /api/fields` | Every field name in use, with how many records have it |
| `GET /api/stats` | Counts and write statistics |
| `GET /api/events` | Server-Sent Events stream (`change`, `delete`, `clear`) that the dashboard uses for live updates |

### Delete

| Method & path | Description |
|---|---|
| `DELETE /api/records/:id` | Delete one record and its history (User role or higher) |
| `POST /api/records/delete` | Delete many records: body `{ "ids": ["a", "b", ...] }` (User role or higher). The dashboard's multi-select **Delete** uses this |
| `DELETE /api/records?confirm=true` | **Clear all records and all history** (Power user or higher). This is what the dashboard's *Clear all* button calls |

### Auth and admin

| Method & path | Role | Description |
|---|---|---|
| `GET /api/auth/status` | public | Whether setup is needed and which sign-in options are on |
| `POST /api/auth/setup` | public | Create the first admin (only works while there are no users) |
| `POST /api/auth/login` · `POST /api/auth/logout` | public | Password sign-in and sign-out (session cookie) |
| `GET /api/auth/me` | any | The current identity, role, capabilities and CSRF token |
| `POST /api/auth/password` | any user | Change your own password: `{ "current", "next" }` |
| `GET /api/settings` · `PUT /api/settings` | Power user (threshold) / Admin (password sign-in) | `{ "staleMinutes": 15, "passwordLogin": true \| "admins" }` |
| `GET/POST /api/admin/users` · `PATCH/DELETE /api/admin/users/:id` | Admin | Manage users: `{ username, name, email, role, password, disabled, removePassword }` |
| `GET/PUT /api/admin/sso` · `POST /api/admin/sso/test` | Admin | Entra SSO settings and discovery test |
| `GET /api/admin/apikey` | Power user or Admin | The key and its status: `{ "set", "required", "key", "prefix", "created", "createdBy", "revealable" }` |
| `POST /api/admin/apikey` | Power user or Admin | `{ "action": "generate" }` makes a new key. Admins only: `{ "action": "set", "key" }` uses your own, `{ "action": "require", "required": false }` stops requiring it |
| `GET /auth/oidc/login` · `GET /auth/oidc/callback` | public | The Entra sign-in redirect flow |
| `GET/PUT /api/admin/tls` | Admin | HTTPS status and settings: `{ "mode": "off" \| "both" \| "redirect", "hsts": false, "publicPort": 443 }` |
| `POST /api/admin/tls/certificate` | Admin | Install a certificate: `{ "type": "pem", "cert", "key", "passphrase" }`, `{ "type": "pfx", "pfx": "<base64>", "passphrase" }` or `{ "type": "self-signed", "hostnames": "host, 10.0.0.5", "days": 365 }` |
| `GET /api/admin/tls/certificate.pem` · `DELETE /api/admin/tls/certificate` | Admin | Download the public certificate · remove it (HTTPS must be off) |

### Accepting check-ins (pause / resume)

| Method & path | Role | Description |
|---|---|---|
| `GET /api/views` | any signed-in user | `{ "personal": [...], "team": [...] }`. Each view has `id`, `scope`, `name`, `state`, `updated` and `updatedBy` |
| `POST /api/views` | any signed-in user (team: Power user or Admin) | `{ "scope": "personal" \| "team", "name": "…", "state": {…} }`. Saving under an existing name in the same scope overwrites that view. Personal views need a user account, not the API key |
| `PUT /api/views/defaults` | any signed-in user (team: Power user or Admin) | `{ "mine": "p:<id>" \| "t:<id>" \| "builtin" \| null, "team": "t:<id>" \| null }`, either or both. `GET /api/views` returns the current ones as `defaults` |
| `PUT /api/views/:id`, `DELETE /api/views/:id` | owner (personal) or Power user/Admin (team) | Rename or update `state`, or delete |
| `GET /api/boxes` | any signed-in user | `{ "boxes": [...] }`: the status boxes, in order. Each has `id`, `name`, `field`, `op` (`gt`, `gte`, `lt`, `lte`, `eq`, `neq`, `contains`, `ncontains`, `empty`, `nempty`), `value`, `minutes`, `tone` (`bad`, `warn`, `info`, `neutral`), `ignoreStale` and `enabled` |
| `PUT /api/boxes` | Power user or Admin | `{ "boxes": [...] }` replaces the whole list (up to 24). Records then carry `_boxes: { "<box id>": "<since>" }`: when each box's condition started holding for that record |
| `GET /api/status` | public | `{ "accepting": true, "paused": false, "since": "…" }`. Signed-in callers also get `by` (who paused it) |
| `PUT /api/status` | Power user or Admin | `{ "paused": true }` to stop accepting check-ins, `{ "paused": false }` to resume |

While paused, `POST /api/checkin` and `POST /api/import` return **503** with `Retry-After: 30` and `{"ok": false, "accepting": false, "paused": true, ...}`. Nothing is queued, so devices should retry. Reads, exports and deletes keep working. `/health` also includes `accepting`, but stays HTTP 200 so Docker doesn't restart a paused container. The pause survives restarts.

```bash
curl http://localhost:3000/api/status
curl -u admin:password -X PUT http://localhost:3000/api/status -H "Content-Type: application/json" -d '{"paused":true}'
```

```powershell
(Invoke-RestMethod http://localhost:3000/api/status).accepting
```

### Port checks

Off until an admin turns them on in **Admin → Port checks**. A device asks the server to try a TCP connection back to it on a few ports. The server only ever checks **the address the request came from** (there's no way to name another host), so it can't be used to scan other machines. "Open" means reachable from the server: firewalls in between count, and a device behind NAT, a VPN gateway or a proxy is checked at that gateway's address. Behind a reverse proxy, set `TRUST_PROXY` so the server sees each device's real address.

| Method & path | Role | Description |
|---|---|---|
| `GET` or `POST /api/portcheck?ports=22,443` | User role or the API key | Checks those ports and returns `{ "ip": "10.0.0.15", "ports": { "22": "open", "443": "closed" }, "ms": 3 }`. Nothing is saved |
| `POST /api/checkin` with `check_ports=3389` | as a check-in | Checks the ports first and saves `port_3389` = `open` or `closed` with the check-in (`check_ports` itself isn't stored). The reply includes `ports` with the details, `portCheck: "off"` when port checks are off (the check-in is still saved), or `portCheckError` |
| `GET` / `PUT /api/admin/portcheck` | Admin | `{ "enabled": true, "timeoutMs": 2000, "maxPorts": 5 }` |

Each port comes back as `open` (connected), `closed` (refused), `filtered` (no answer within the wait, 2 seconds by default) or `error`. Saved fields use just `open` / `closed`, where `closed` is anything but open. Limits: up to 5 ports per request (an admin can change this), 300 ports a minute per address, and 5,000 checks waiting at once across the server. The cost is small: under 0.1 ms of CPU per port, so thousands of checks a minute add a percent or two of one core.

The Status box presets include **RDP open / closed** (`port_3389`) and **SSH open / closed** (`port_22`).

### CSV

| Method & path | Description |
|---|---|
| `GET /api/export.csv` | Every record. Columns are `id,created,modified`, then every field. Use `?fields=id,status,site` to choose columns |
| `GET /api/history/export.csv` | Every stored history entry |
| `POST /api/import` | Upload CSV as the raw body with `Content-Type: text/csv`. Each row is processed as a check-in (create or update, with history). An `id` column is required. Empty cells are skipped so they don't overwrite existing values. `created` and `modified` columns are ignored |

```bash
curl -X POST http://localhost:3000/api/import -H "Content-Type: text/csv" --data-binary @devices.csv
```

The dashboard's export menu can also download the **current view**: only the filtered rows, with the visible columns in their current order.

## Dashboard

- **Status cards:** Active, Aging and Stale are based on time since the last check-in. The threshold is set in Settings (default 15 minutes; Aging runs up to 2× the threshold). Click a card to filter by that status.
- **Status boxes** (optional): extra cards under Active / Aging / Stale that count devices matching a rule, for example **High CPU**: `cpu_pct > 90` for at least 10 minutes. Power users and admins set them up from the account menu → **Status boxes** (or the sliders button at the end of the row); everyone sees them. There are presets for high CPU, high memory, high disk activity, low disk space, reboot required and not domain joined, or build one on any field with the same conditions as filters. Each box has:
  - **For at least N minutes:** every check-in for that long matched (0 = the latest one matches). The server records when each device started matching and keeps it across restarts. When you create or change a box it works this out from the stored history, so with a short `HISTORY_LIMIT` it can only look back that far.
  - **Don't count stale devices** (on by default): a device that stopped checking in keeps its last reading, which is out of date.
  - A color, and a switch to hide it without deleting it.

  Click a box to show just those devices (click again to clear); the box filter is saved with views. A device's details show which boxes it's in, since when, or how far along it is (for example "4 min of 10 min").
- **Search** across every field. Press `/` to jump to the search box.
- **Filters:** use the **Filter** button or the funnel icon on any column header. The conditions offered depend on the field:
  - **Text fields** (custom fields, ID, Any field): contains, does not contain, is, is not, starts with, greater/less than, matches regex, is empty, is not empty. The panel shows the most common values for one-click filtering.
  - **Status:** is / is not Active, Aging or Stale, with live counts. If your data has its own `status` field, the built-in one is labelled **Status (check-in)**.
  - **Created and Modified:** in the last N minutes, hours or days, more than N ago, after or before a date and time, or on a given day, plus presets such as "Last 15 min" and "Over a day ago". Relative conditions move with the clock.

  Click a filter chip to edit it. With two or more filters, switch between **Match all** (every filter must match) and **Match any** (at least one must match). Search, the status cards and the time filter always narrow the results further. An invalid filter (for example a broken regex in an old saved view) is shown in red and ignored.
- **Time filter:** for example "Last 15 min" or "Not in last 24 hours".
- **Group by** any field or by status. Click a group header to collapse it.
- **Layouts:** Table, Cards, or an Activity feed of recent changes.
- **Columns:** show or hide, drag to reorder (in the header or the Columns panel), and drag a column edge to resize it (double-click the edge to reset).
- **Sort:** click a header to sort. Shift+click adds a secondary sort.
- **Phones and tablets:** on a phone the header shrinks to the logo and your account menu, which also holds Pause, Import, Export, Clear all and dark mode. The status counts sit in one compact row, and the less-used toolbar controls scroll sideways under the search box. Menus, filters and dialogs open as bottom sheets, and Admin opens full screen with users shown as cards. The first visit on a phone starts in card view. Held sideways, the page scrolls so the list gets nearly the whole screen.
- **Graph tab:** in a record's details, **Graph** plots CPU %, RAM %, disk space used % and disk activity % over the record's stored history (the last `HISTORY_LIMIT` check-ins), with hover details, per-line toggles and a min / avg / max / latest table. It reads `cpu_pct`, `ram_pct`, `disk_pct` and `disk_busy_pct` (what the agents send) or common alternatives such as `cpu`, `mem_pct`, `disk` and `disk_util_pct`. The tab is greyed out for records without any of these.
- **Saved views:** save the current filters, search, sort, grouping, columns and layout under a name. Views are stored on the server:
  - **My views** belong to your account. Only you can see them, and they follow you to any browser.
  - **Team views** are visible to everyone. Only power users and admins can create, overwrite or delete them, and changes show up on every open dashboard straight away.

  A dot on the save button means you've changed the view since it was saved. Readers and users can open a team view, adjust it, and save their own copy under **My views**. Views saved in the browser by older versions are moved to your account the first time you sign in. Deleting a user also deletes their personal views.

  **Default view** (the star next to the views menu) picks the view that opens when the page loads:
  - **My default** is stored on your account, so it follows you to any browser. It can be one of your views, a team view, or the **Default View** (the standard layout).
  - **Team default** (power users and admins) is a team view that opens for everyone who hasn't picked their own.
  - With neither set, the dashboard reopens the way you left it in that browser. In the views menu, a star with one person marks your default and a star with two people marks the team default (hover for a description). Deleting a view clears any default that pointed to it.
- **Record drawer:** click a row to see every field and a timeline of changes.
- **Multi-select:** tick the checkboxes in the table (Shift+click selects a range) or on cards. The header checkbox selects every matching row. A bar appears where you can **Delete** or **Export** the selection; the Delete key works too. Esc clears the selection.
- **Live updates:** changes stream in as they happen.
- **Pause check-ins** (power users and admins): the server stops accepting check-ins and CSV imports until resumed. Every open dashboard shows a banner saying who paused it and when.
- **Import:** use the button, or drag a `.csv` file onto the page.
- Light and dark themes, plus compact and comfortable row density.

## Performance

- SQLite runs in WAL mode with `synchronous=NORMAL`. Concurrent check-ins are queued and committed together, up to `MAX_BATCH` per transaction.
- The store alone sustains about 40,000+ upserts per second. Over HTTP, a 2-vCPU test machine (also running the load generator) handled about 6,000 check-ins per second with 300 to 1,000 simultaneous connections, with no errors. A dedicated server will do better.
- The dashboard loads all records once, then fetches only changed records (`sinceRev`), at most once a second however fast devices check in, and re-sorts at most that often. After a reconnect it fetches only what changed plus the list of ids (to drop deleted records) instead of everything. Rows and cards are virtualised, so tens of thousands of records stay smooth.
- Responses are compressed with Brotli or gzip: the full list for 10,000 devices is about 11 MB as JSON and about 0.4 MB compressed. If your reverse proxy also compresses (Caddy `encode`), that's fine; it leaves already-compressed responses alone.

Run the load test yourself while the server is running:

```bash
API_KEY=<key> npm run loadtest                         # 500 connections, 10s, 5000 ids
node scripts/loadtest.js http://localhost:3000 1000 30 20000
```

From PowerShell (Windows PowerShell 5.1 or PowerShell 7), this fires 500 simultaneous check-ins:

```powershell
.\scripts\loadtest.ps1                                   # 500 at once
.\scripts\loadtest.ps1 -Count 2000 -Rounds 5 -ApiKey ck_xxx
```

### Simulating a fleet (continuous load test)

`scripts/loadtest-fleet.ps1` (Windows PowerShell 5.1 or PowerShell 7) runs a simulated fleet until you press Ctrl+C. Every device sends its own check-in with agent-like fields, and you choose how many show up in each state:

```powershell
.\scripts\loadtest-fleet.ps1 -Url https://checkin.example.com -ApiKey ck_xxx `
  -Active 5000 -Aging 200 -Stale 100 -IntervalSeconds 60 `
  -HighCpu 50 -HighMemory 40 -HighDiskActivity 20 -LowDiskSpace 30 -RebootRequired 120 -NotDomainJoined 10 -FailedServices 25
.\scripts\loadtest-fleet.ps1 -Active 10000 -IntervalSeconds 30 -Burst -Minutes 10   # all at once every 30 s, for 10 minutes
.\scripts\loadtest-fleet.ps1 -DryRun                                                 # show the plan and a sample check-in
.\scripts\loadtest-fleet.ps1 -Cleanup                                                # delete the simulated records
```

- **Active** devices check in every `-IntervalSeconds`, spread over the interval like real agents (`-Burst` sends them all at once). The interval must be shorter than the active threshold.
- **Aging** devices check in just before they'd turn stale. The script runs enough of them, staggered, that about `-Aging` are aging at any moment; the others in that group are in the active part of their cycle and count towards `-Active`.
- **Stale** devices check in once (only if they don't exist yet), then never again.
- **Problems** (`-HighCpu`, `-HighMemory`, `-HighDiskActivity`, `-LowDiskSpace`, `-RebootRequired`, `-NotDomainJoined`, `-FailedServices`) go to that many active devices and hold on every check-in, with values that trip the Status box presets (for example `cpu_pct` 92-99).
- The script reads the active threshold from the server. Status comes from the time of the last check-in, so aging settles after about twice the threshold and new stale devices turn stale after twice the threshold; for a quick demo, set the threshold to 1 or 2 minutes in Settings first.
- Every few seconds it prints check-ins sent, failures by HTTP status, and latency (p50 / p95 / p99 / max); totals when it stops. Simulated ids start with `-Prefix` (default `LT-`) and carry `sim_group` (active, aging, stale), so they're easy to filter.

## Agents (Windows and Linux)

Two ready-made agents report a machine to the server: `scripts/checkin-agent.ps1` for Windows (Windows PowerShell 5.1 or PowerShell 7) and `scripts/checkin-agent.sh` for Linux (bash and curl). Each run:

1. asks `GET /api/status` whether check-ins are being accepted, and stops if not (exit code `2`, nothing is gathered or sent);
2. gathers the selected details (the CPU reading takes one second);
3. sends them to `POST /api/checkin` with the computer name as the ID.

The server hosts both scripts at `/agent/checkin-agent.ps1` and `/agent/checkin-agent.sh`, plus one-line installers at `/install.ps1` and `/install.sh` (no sign-in needed; none of them hold secrets). The dashboard's **Add Device** page builds the install command for you.

### Field groups

Both agents use the same field names, so filters and saved views work across Windows and Linux. Pick groups with `-Fields` / `--fields` (default: everything except `updates` and `security`; `all` for everything; `default,security` to add one) and drop some with `-Exclude` / `--exclude`.

| Group | Fields |
|---|---|
| `system` | hostname, fqdn, os, os_version, arch, vendor, model, serial, virtualization (+ `os_build`, `os_release` on Windows; `kernel` on Linux) |
| `cpu` | cpu_pct, cpu_cores, cpu_model (+ load_1m/5m/15m on Linux) |
| `ram` | ram_pct, ram_used_mb, ram_total_mb, swap_pct (page file on Windows) |
| `disk` | Disk **activity**: disk_busy_pct (how much of a one-second sample the busiest physical disk was busy, like `iostat` %util on Linux or 100 − % Idle Time on Windows; taken in the same second as cpu_pct, so it adds no extra wait). Disk **space**: disk_pct (% of the system drive / root filesystem in use), disk_free_gb, disk_size_gb, disk_max_pct and disk_max_mount (the fullest drive) |
| `time` | system_time, timezone, time_synced, time_source |
| `uptime` | boot_time, uptime, uptime_h |
| `network` | ip, interface, mac, gateway, dns_servers |
| `domain` | domain_joined, domain, domain_type (`active-directory`, `entra`, `hybrid`, `ipa`, `none`). Windows adds domain_role, entra_joined, entra_tenant, secure_channel_ok (trust with the domain is healthy), workgroup. Linux adds join_software (sssd/winbind) and dns_domain |
| `users` | users_logged_in, logged_in_users |
| `health` | processes, failed_services, failed_service_names, reboot_required |
| `updates` | pending_updates, security_updates, last_update (+ last_hotfix on Windows, package_manager on Linux). Slower |
| `security` | firewall_enabled, disk_encrypted, secure_boot. Windows adds firewall_profiles, av_product, av_enabled, av_realtime, av_signature_age_days. Linux adds firewall, selinux, apparmor |

Every agent also sends `agent_version` and `agent_os`. Anything a machine can't provide is left out, and if one group fails the rest are still sent, with the problem noted in `agent_errors`. Run as administrator/SYSTEM (Windows) or root (Linux) for the fields that need it (serial, secure channel, BitLocker, firewall).

### Options

| Windows | Linux | |
|---|---|---|
| `-Url` | `--url` | Server URL |
| `-ApiKey` | `--key` | API key |
| `-Id` | `--id` | Record ID (default: computer name) |
| `-Fields` | `--fields` | Groups to send, e.g. `cpu,ram,disk,domain` |
| `-Exclude` | `--exclude` | Groups to skip |
| `-Extra` | `--extra` | Extra fields, e.g. `"site=Dallas,owner=it-infra"`. Values can use environment variables (see below) |
| `-CheckPorts 3389` | `--check-ports 22` | With each check-in, have the server test these ports on this machine and save `port_3389` = open / closed (needs port checks turned on) |
| `-PortCheck 3389,443` | `--port-check 22,443` | Just ask the server whether these ports are reachable, print the answer and exit (exit code 0 = all open, 3 = some not). No check-in |
| `-Insecure` | `--insecure` | Accept a self-signed certificate |
| `-Proxy` | `https_proxy` env var | Web proxy |
| `-DryRun` | `--dry-run` | Print the JSON instead of sending it |
| `-Force` | `--force` | Send even when the server is paused |
| `-List` | `--list` | Show the field groups |
| `-Install -Every 5` | `--install --every 5` | Install and run every N minutes (`--cron` forces cron instead of a systemd timer) |
| `-Uninstall` | `--uninstall` | Remove it again; add `-RemoveRecord` / `--remove-record` to also delete its record on the server |

**Environment variables in extra fields.** A value can refer to an environment variable on the machine. It's read on every run, so one install command can serve many machines:

- `${NAME}`, e.g. `site=${SITE}`
- `${NAME:-fallback}`, e.g. `team=${TEAM:-it-ops}`
- `%NAME%`, e.g. `owner=%USERNAME%`

All three forms work on both Windows and Linux. A field whose value comes out empty is left out.

Scheduled runs see few variables, so put them where the agent can find them:

- **Windows:** System environment variables (System Properties, or `setx NAME value /M`). The agent reads them straight from the registry each run, so new and changed ones apply without a reboot. User variables and ones set only in a console window aren't seen, because the task runs as SYSTEM.
- **Linux:** `/etc/environment`, or lines like `SITE=Dallas` in `/etc/check-in/agent.conf`. Both are re-read every run. Variables exported in your shell or `~/.bashrc` aren't seen by cron or the systemd timer.

On a command line, wrap the value in single quotes (`--extra 'site=${SITE}'`) so your shell doesn't replace it with today's value.

Settings can also come from environment variables (`CHECKIN_URL`, `CHECKIN_API_KEY`, `CHECKIN_FIELDS`, `CHECKIN_EXCLUDE`, `CHECKIN_EXTRA`, ...) or the config file that `-Install`/`--install` writes. That file is readable only by administrators/SYSTEM (`C:\ProgramData\CheckIn\agent.json`) or root (`/etc/check-in/agent.conf`), and you can edit it later without reinstalling.

Exit codes: `0` sent, `2` server paused (nothing sent), `1` error. On Windows the last result is written to `C:\ProgramData\CheckIn\last-run.txt`; on Linux it goes to the system log (`journalctl -t checkin-agent`).

### One-line install

The easiest way: in the dashboard, open your account menu → **Add Device**. Pick Windows or Linux, the interval, the field groups and any extra fields, and copy the command. For power users and admins the API key is already filled in; other users paste it. Run it on the machine:

```powershell
# Windows: elevated PowerShell ("Run as administrator")
$env:CHECKIN_API_KEY='ck_xxx'; irm 'https://checkin.example.com/install.ps1' | iex
```

```bash
# Linux
curl -fsSL 'https://checkin.example.com/install.sh' | sudo CHECKIN_API_KEY=ck_xxx bash
```

`/install.ps1` and `/install.sh` are small installers that the server generates with **its own address filled in**. They download the agent from the same server, save the settings on the machine and schedule it:

- **Windows:** the scheduled task **Check-In Agent**, running as SYSTEM every 5 minutes, at startup and on battery.
- **Linux:** a systemd timer, or cron where there's no systemd. Add `CHECKIN_CRON=1` to always use cron.

Leave out `CHECKIN_API_KEY` only if an admin has turned off the API key requirement.

When port checks are on, Add Device also offers **Check that Remote Desktop / SSH is reachable** (port 3389 on Windows, 22 on Linux; you can change or add ports). It adds `?ports=3389` to the install URL, so each check-in saves `port_3389` = open / closed. The option is greyed out while port checks are off.

Options go on the install URL and become that machine's settings: `?every=10&fields=default,security&exclude=users&extra=site=Dallas,owner=it&insecure=1`. Add `&url=https://...` if machines should use a different address from the one in your browser. Open an install URL in the browser to read exactly what it will run. The address comes from the request, so behind a reverse proxy set `TRUST_PROXY`; otherwise the installer may say `http://` instead of `https://`. The Add Device page warns you when that happens.

### Where to change things

| To change... | Edit |
|---|---|
| One installed machine (server, key, fields, extra fields) | `C:\ProgramData\CheckIn\agent.json` (Windows) or `/etc/check-in/agent.conf` (Linux). Used on the next run, no reinstall |
| Its schedule | Run the install command again with a new interval (reinstalling also updates the agent) |
| Defaults for all future installs | `INSTALL_DEFAULTS` in `src/agents.js`, or pick options on the Add Device page (they ride along in the command) |
| The installers themselves | `linuxInstaller()` / `windowsInstaller()` in `src/agents.js` |
| What the agents collect, and their built-in defaults | The **SETTINGS - change these** block at the top of `scripts/checkin-agent.ps1` and `scripts/checkin-agent.sh`, and the field groups below it. Keep the field names the same in both so filters work across Windows and Linux |

Because the server hands out the agent scripts, an edited script reaches machines the next time the install command runs on them.

### Removing a machine

The bottom of the **Add Device** page has the commands. On the machine:

```powershell
# Windows (elevated)
powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\CheckIn\checkin-agent.ps1 -Uninstall -RemoveRecord
```
```bash
# Linux
sudo checkin-agent --uninstall --remove-record
```

This removes the scheduled task, timer or cron job, the agent and its settings, including the saved API key. With `-RemoveRecord` / `--remove-record` it also deletes the machine's record on the server, using the saved URL and key; leave the flag off to keep the record.

If the agent file is already gone, remove the pieces directly, then delete the record in the dashboard:

```powershell
# Windows (elevated PowerShell)
schtasks /Delete /TN 'Check-In Agent' /F; Remove-Item C:\ProgramData\CheckIn -Recurse -Force
```
```bash
# Linux
sudo sh -c 'systemctl disable --now checkin-agent.timer 2>/dev/null; rm -f /etc/systemd/system/checkin-agent.service /etc/systemd/system/checkin-agent.timer /etc/cron.d/checkin-agent /usr/local/bin/checkin-agent; rm -rf /etc/check-in'
```

Records are never deleted automatically: a machine that stops checking in turns **stale**. To clear out several at once, click the **Stale** card, tick the retired machines, and choose **Delete**.

### Scheduling it yourself

If you'd rather place the script and schedule it by hand:

```powershell
# Windows Task Scheduler: every 5 minutes as SYSTEM (elevated prompt)
schtasks /Create /TN "Check-In Agent" /RU SYSTEM /RL HIGHEST /SC MINUTE /MO 5 /F /TR "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Scripts\checkin-agent.ps1 -Url https://checkin.example.com -ApiKey ck_xxx"
```

```bash
# Linux system cron: every 5 minutes as root
sudo curl -fsSL https://checkin.example.com/agent/checkin-agent.sh -o /usr/local/bin/checkin-agent && sudo chmod 755 /usr/local/bin/checkin-agent
echo '*/5 * * * * root /usr/local/bin/checkin-agent --url https://checkin.example.com --key ck_xxx >/dev/null 2>&1' | sudo tee /etc/cron.d/checkin-agent

# ...or the current user's crontab
(crontab -l 2>/dev/null | grep -v checkin-agent; echo '*/5 * * * * /usr/local/bin/checkin-agent --url https://checkin.example.com --key ck_xxx >/dev/null 2>&1') | crontab -
```

A key typed on these command lines is visible to other administrators in the task or cron entry. The `-Install`/`--install` route keeps it in the protected config file instead. Note that a task created with `schtasks /SC MINUTE` uses Windows' defaults: it won't start on battery and doesn't stop a hung run, which is why `-Install` sets those explicitly.

## Tests

```bash
npm test
```

## Project layout

```
src/
  server.js   entry point
  app.js      HTTP routes, auth, SSE, CSV endpoints
  store.js    batched write queue, upsert/history logic, queries
  db.js       SQLite (built-in node:sqlite) schema, pragmas, transaction helper
  csv.js      CSV helpers
  tls.js      built-in HTTPS: certificate storage, validation, hot reload, redirects
  views.js    saved views (personal and team)
  boxes.js    status boxes: rules, per-device "since" tracking, routes
  portcheck.js port checks: TCP probes back to the caller, limits, routes
  compress.js Brotli / gzip response compression
  agents.js   agent downloads and the /install.sh, /install.ps1 one-line installers
  config.js   env/.env loading
  auth/
    plugin.js    identity resolution, permissions, CSRF, auth + admin routes
    accounts.js  users, sessions, settings, roles, SSO user provisioning
    oidc.js      Microsoft Entra ID (OIDC, code flow + PKCE)
    security.js  scrypt hashing, encryption, rate limiting
public/       dashboard and login page (index.html, login.html, app.js, admin.js, agents.js, chart.js, viewstate.js, login.js, styles.css; no build step)
scripts/      seed.js, loadtest.js, loadtest.ps1, loadtest-fleet.ps1, checkin-agent.sh, checkin-agent.ps1 (agents served at /agent/...)
test/         API tests (node:test)
```

## Running as a service on Windows

The simplest option is [NSSM](https://nssm.cc/) or `pm2`:

```bash
npm i -g pm2
pm2 start src/server.js --name check-in
pm2 save
```
