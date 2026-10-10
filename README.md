# ServerDeck

Desktop SSH and server manager. Save servers once, connect in one click, and have them on every
device. Server passwords and SSH keys are encrypted on your computer before they sync, so the API
never sees them.

```
apps/api           Node.js REST API (Express 5, Mongoose, MongoDB) — accounts + sync
apps/desktop       Electron shell (electron/) + Next.js UI (web/, static export)
packages/shared    zod schemas, types, vault crypto, IPC contract — used by both apps
DECISIONS.md       Where and why the build differs from the spec
```

## Requirements

- Node.js 20+ (developed on 24) and pnpm 9 (`npm i -g pnpm@9`)
- A MongoDB replica set (MongoDB Atlas works). Tests use an in-memory one, nothing to install.

## Run it locally

```bash
pnpm install

# 1. API — copy the env file and fill in MONGODB_URI, JWT_SECRET, SERVER_SECRET
cp -n apps/api/.env.example apps/api/.env   # -n: never overwrite an existing .env
pnpm dev:api                       # http://localhost:4000

# 2. Desktop app (second terminal): Next.js dev server + Electron
pnpm --filter @serverdeck/desktop dev
```

Without SMTP settings, password reset codes are printed in the API log (development only).

## Checks

```bash
pnpm check        # lint + type-check + all tests (shared, api, desktop)
```

## Build

```bash
# API → apps/api/dist/index.js, start with: node --env-file=.env dist/index.js
pnpm --filter @serverdeck/api build

# Desktop installer → apps/desktop/release/
# SERVERDECK_API_URL is baked in at build time; point it at your deployed API.
SERVERDECK_API_URL=https://api.example.com pnpm --filter @serverdeck/desktop dist
```

Build the Windows installer on Windows, the `.dmg` on macOS and the AppImage on Linux.
Installers are not code-signed yet.

### Deploying the API

Any Node host works (VPS, Railway, Render). Set the variables from `apps/api/.env.example`, with
`NODE_ENV=production` and SMTP settings (production refuses to start without `SMTP_HOST`). Put it
behind HTTPS and set `TRUST_PROXY=1` when there is a proxy in front, so rate limits see real IPs.

## How it works

- **Vault**: at sign-up the app makes a random vault key. The password derives (Argon2id) an
  `authKey` sent to the API and a `wrapKey` that encrypts the vault key; the vault key encrypts
  each server secret (AES-256-GCM). A recovery key is shown once and can unlock the vault after
  a password reset. See `packages/shared/src/crypto.ts`.
- **Sync**: every change is written to a local SQLite database and an outbox first, then pushed.
  Pull uses a per-user change counter as a cursor. Conflicts keep the newer edit and save the other
  one in "Recently changed". See `apps/desktop/electron/sync.ts` and `apps/api/src/services/sync.ts`.
- **SSH** runs in the Electron main process (`apps/desktop/electron/ssh.ts`). The UI never receives
  decrypted secrets or the vault key.

## Milestones

**M1 — API and accounts**
- [x] Monorepo, schema (MongoDB, D-001), local database for tests
- [x] Auth routes, refresh rotation with reuse detection, rate limits, password reset email
- [x] Tests for auth routes

**M2 — Client and servers**
- [x] Electron + Next.js shell, design tokens, login / sign-up / recovery screens
- [x] Vault key creation and unlock; server list and add/edit drawer

**M3 — Sync**
- [x] Local SQLite + outbox, `/sync/push` and `/sync/pull`, conflict history, trash
- [x] Acceptance: add offline on PC A → online → appears on PC B within 60 s; reinstall A → log in → all servers back

**M4 — Terminal and release**
- [x] ssh2 with password and key, host-key check, xterm.js tabs, reconnect
- [x] Settings, export/import, installers (Windows built and tested; macOS/Linux configured)
