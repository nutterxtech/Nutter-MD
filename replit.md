# NUTTER-XMD Workspace

## Project Overview

NUTTER-XMD is a WhatsApp multi-device bot platform. It has two deployment targets:
- **Deployment A** (admin's Render.com web service): Pairing page, deploy page (fork verification), admin dashboard — Express serves both API and built React frontend
- **Deployment B** (each deployer's Heroku): Baileys-based bot engine using SESSION_ID from Heroku config vars

## Architecture

- **Frontend** (`artifacts/nutter-xmd/`): React + Vite, dark theme with WhatsApp green, 3 pages: Pairing (`/`), Deploy (`/deploy`), Admin (`/admin`)
- **API Server** (`artifacts/api-server/`): Express 5, Baileys bot engine, pair/admin routes, DB-backed group & user settings
- **Database** (`lib/db/`): PostgreSQL + Drizzle ORM — stores only `group_settings` and `user_settings` (never WhatsApp credentials)
- **Bot** (`artifacts/api-server/src/bot/`): `botEngine.ts`, `pairingSession.ts`, `session.ts`, `handler.ts`, `commands/`

## Key Design Decisions

- SESSION_ID = base64-encoded Baileys creds JSON — stored as Heroku config var ONLY, never in DB
- Bot starts automatically on server startup if `SESSION_ID` env var is present
- `@whiskeysockets/baileys` and `protobufjs` are externalized in esbuild (not bundled) due to dynamic imports
- `lib/api-zod/src/index.ts` must only export `./generated/api` (not `./generated/types`) — fixed after each codegen run

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **WhatsApp**: @whiskeysockets/baileys (multi-device)
- **Validation**: Zod, drizzle-zod
- **API codegen**: Orval (from OpenAPI spec at `lib/api-spec/openapi.yaml`)
- **Build**: esbuild (ESM bundle, Baileys externalized)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Environment Variables

- `SESSION_ID` — base64-encoded Baileys credentials (set on Heroku for each deployer's bot instance)
- `ADMIN_PASSWORD` — password for the admin dashboard
- `DATABASE_URL` — PostgreSQL connection string
- `PORT` — server port (auto-assigned by Replit)

## Deployment

### Deployment A — Admin's Render.com web service
`render.yaml` at the repo root configures a single Render web service that:
1. Installs deps, builds the React frontend (`artifacts/nutter-xmd/dist/public`), then builds the Express API bundle
2. Runs `node artifacts/api-server/dist/index.mjs` — Express serves `/api/*` routes and static React files at `/*`
3. Handles SPA routing via a wildcard `GET *` → `index.html` fallback (production only)

Required env vars on Render: `ADMIN_PASSWORD` (set as secret in Render dashboard).  
Do NOT set `SESSION_ID` on Render — bot engine must not start on the admin server.

### Deployment B — Deployer's Heroku dyno
Procfile: `worker: node --enable-source-maps artifacts/api-server/dist/bot-standalone.mjs`  
Required Heroku config vars: `SESSION_ID`, `OWNER_NUMBER`, `DATABASE_URL`, `BOT_NAME`, `PREFIX`.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
