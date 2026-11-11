# StockSync Backend

![CI](https://github.com/gopichand-retail-apps/stocksync-backend/actions/workflows/ci.yml/badge.svg)

[Architecture guide](docs/architecture.md) — source map, workflows, contracts, data, security, and checks.

## Repository layout and deployment boundary

This independent repository owns StockSync's NestJS / TypeScript API and authoritative PGlite state. The UI is the separate [stocksync-frontend](https://github.com/gopichand-retail-apps/stocksync-frontend) repository. Keep the current directory names, Git histories, origins, and independent builds.

The Vercel configuration belongs to the frontend only. This API has no verified Vercel deployment adapter. The local file database is not shared durable storage for stateless function instances. Socket.IO also requires a compatible persistent connection host. Do not deploy the local simulator as a public API or point it at real records.

Use Node **24.15.0**, npm, and the committed package-lock.json. From the full Retail Apps workspace, `./scripts/Start-Apps.ps1 -App StockSync` uses the correct built/native entry after setup. From this repository alone, build with npm.cmd run build, set $env:STOCKSYNC_START_SERVER='true', then run node dist/main.js.

Health: http://127.0.0.1:5402/api/v1/health. Direct startup stores data under `data/stocksync`; the workspace launcher can select a separate app-owned path. The [API contract](docs/openapi.yaml) and [canonical architecture](docs/architecture.md) describe the existing routes and trust boundaries. The architecture guide is inside this repository.

Known release gaps: The OpenAPI duplicate mapping is corrected. Archived npm start scripts still use Unix syntax. Production sessions, persistence, retry safety, and WebSocket hosting require separate validation.

NestJS API for the StockSync multi-location inventory demo. This is a separate Git repository from the React frontend.

## Run locally

```sh
npm ci
npm run start:dev
```

The API listens on `http://127.0.0.1:5402/api/v1`. The frontend runs on port `5401` and proxies API and Socket.IO requests to this service. The API binds to loopback and is intended for local development.

## Local data and demo accounts

The database uses PGlite, an embedded PostgreSQL-compatible engine; Docker and a separate PostgreSQL server are not required. Data persists under `data/stocksync/` by default and is ignored by Git. Set `STOCKSYNC_DATA_DIR` to use another local directory, or set it to `memory://` for an isolated in-memory server. Seed records are synthetic.

Seeded users are `associate@stocksync.test`, `manager@stocksync.test`, and `auditor@stocksync.test`. Their demo password is `stock-demo-only`; set `STOCKSYNC_DEMO_PASSWORD` before the first seed to choose another local demo password. Passwords are stored as Argon2id hashes.

The development-only `GET /api/v1/auth/synthetic-roles` endpoint returns active role codes only.
It does not return account identities or credentials and responds with 404 in production.
Selecting a role does not bypass login: the API still authenticates credentials and owns the
server-side session and all inventory authorization checks.

## Configuration

- `PORT`: API port; defaults to `5402`.
- `WEB_ORIGIN`: optional browser-origin override. When unset or set to either StockSync local origin, both `http://127.0.0.1:5401` and `http://localhost:5401` are allowed; any other configured origin is matched exactly.
- `SESSION_SECRET`: optional session signing secret. Local mode generates a process-only value when unset; restarting the API may require signing in again.
- `STOCKSYNC_DATA_DIR`: optional local PGlite data directory.
- `STOCKSYNC_DEMO_PASSWORD`: optional password used when demo users are first seeded.

Production mode is intentionally disabled until production session storage, deployment security, and the complete operational controls are configured. This demo does not connect to real inventory systems or collect analytics.

## Checks

```sh
npm test
npm run test:e2e
npm run build
npm run lint
npm run format:check
npm run test:cov
```

Unit and HTTP e2e tests are both included in coverage runs. Test apps use isolated in-memory PGlite databases; bootstrap checks use an ephemeral loopback port and HTTP e2e requests use ephemeral test servers. The API emits JSON request logs with request/trace IDs, hashed user identifiers, duration, outcome, and safe error codes; cookies, authorization headers, and request bodies are not logged. Inventory mutations are validated server-side, role-gated, idempotency-keyed, and recorded in the stock ledger.

## API contract

The OpenAPI 3.1 contract is maintained in [`docs/openapi.yaml`](docs/openapi.yaml). Runtime request validation remains enforced by the API's strict Zod schemas.

Latest combined unit/e2e coverage passed 68 tests and measured 97.17% statements, 91.63% branches, 96.09% functions, and 97.78% lines. Per-file 95% gates cover inventory reads, stock mutation, and transfer operations. Stock mutation and transfer services now cover their conditional-update concurrency failures. Reservation/transaction services and auth guard/controller files remain below 95% branches because V8 attributes one uncovered branch to Nest decorators; this remains an explicit critical-coverage gap, not an approved exception. Full-development and production-only dependency audits report zero vulnerabilities for this repository.
