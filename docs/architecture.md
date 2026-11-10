# StockSync Backend Architecture

Maintained in this independent Git repository at **docs/architecture.md**. Updated **2026-11-09**. The guide covers the implemented stack, interfaces, data model, operational limits, and release requirements.

## Contents

1. [Scope, users, and repository boundary](#1-scope-users-and-repository-boundary)
2. [Context, containers, and trust boundaries](#2-context-containers-and-trust-boundaries)
3. [Source ownership and module map](#3-source-ownership-and-module-map)
4. [Screens, navigation, and lifecycle](#4-screens-navigation-and-lifecycle)
5. [Primary workflows and recovery](#5-primary-workflows-and-recovery)
6. [Domain, persistence, and data ownership](#6-domain-persistence-and-data-ownership)
7. [API and internal contracts](#7-api-and-internal-contracts)
8. [Security, privacy, and egress](#8-security-privacy-and-egress)
9. [Design, accessibility, and platform adapters](#9-design-accessibility-and-platform-adapters)
10. [Build, checks, and deployment](#10-build-checks-and-deployment)
11. [Architecture decisions and tradeoffs](#11-architecture-decisions-and-tradeoffs)
12. [Requirements traceability](#12-requirements-traceability)
13. [Dated verification and limitations](#13-dated-verification-and-limitations)
14. [Extension rules and companion repository](#14-extension-rules-and-companion-repository)

## 1. Scope, users, and repository boundary

Multi-location inventory operations for associates, managers, and auditors.

Inventory lookup, receiving, transfers, cycle counts, reservations, stock ledger, and authenticated Socket.IO updates.

This repository owns the NestJS / TypeScript API and PGlite state. UI rendering belongs to the separate frontend. The service validates and executes the domain operations described below.

There are two independent Git roots for this application, each with its own README and architecture guide. A parent app/workspace folder is a checkout convenience. Use synthetic records; current local services remain on loopback.

### Scope

StockSync is APP-03, a local portfolio demonstration for multi-location synthetic inventory. The React frontend and NestJS API are separate Git repositories. The parent StockSync folder is a VS Code multi-root workspace, not a combined Git repository.

The current implementation uses an embedded PGlite database so local development works without Docker or a separate PostgreSQL server. It preserves PostgreSQL SQL semantics for this demo; this is not a production database deployment.

the relevant configuration or validation section in this guide documents the selected
API origins and isolated E2E commands for mock and live-selection modes.

## 2. Context, containers, and trust boundaries

```mermaid
flowchart LR
  U["StockSync user"] --> F["React and Vite frontend - port 5401"]
  F -->|"API requests across an untrusted browser boundary"| A["NestJS / TypeScript API - port 5402"]
  A --> D["PGlite - app-owned local persistence"]
  M["Validated public content model"] --> F
```

The API is the data authority, but only the identity/ownership controls actually implemented below can be relied on. CORS is not authentication.

### Containers

```mermaid
flowchart LR
  Staff[Associate / Manager / Auditor]
  Browser[React + Vite frontend :5401]
  Api[NestJS API :5402]
  Db[(PGlite local data directory)]
  Socket[Authenticated Socket.IO rooms]

  Staff --> Browser
  Browser -->|same-origin /api/v1 proxy| Api
  Browser -->|same-origin /socket.io proxy| Socket
  Api --> Db
  Api --> Socket
```

Trust boundaries:

- The browser is an untrusted client. Search, filters, role selection, location IDs, quantities, and notes are validated or authorized by the API.
- The local API binds to loopback. Vite proxies browser calls to the API, avoiding a browser-held service key.
- The API owns inventory state. The browser never calculates authoritative balances or prices.
- Socket.IO uses the same server-side session as HTTP and assigns room subscriptions based on the authenticated role and home location.
- PGlite files remain local under `stocksync-backend/data/stocksync/` unless `STOCKSYNC_DATA_DIR` is set.

## 3. Source ownership and module map

| Owner/path                                                                                                                                                                                                                                                       | Responsibility                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [src/main.ts](../src/main.ts)                                                                                                                                                                                                                                    | Process bootstrap, HTTP composition, and configuration                       |
| [src/app.controller.ts](../src/app.controller.ts)<br>[src/auth/auth.controller.ts](../src/auth/auth.controller.ts)<br>[src/inventory/inventory.controller.ts](../src/inventory/inventory.controller.ts)                                                          | HTTP route and request-adapter owners                                        |
| [src/app.service.ts](../src/app.service.ts)<br>[src/auth/auth.service.ts](../src/auth/auth.service.ts)<br>[src/common/stock-events.service.ts](../src/common/stock-events.service.ts)<br>[src/database/database.service.ts](../src/database/database.service.ts) | Application workflow/state-machine owners                                    |
| [src/database/migrations/001_initial_schema.ts](../src/database/migrations/001_initial_schema.ts)<br>[src/inventory/inventory.schemas.ts](../src/inventory/inventory.schemas.ts)                                                                                 | Validation/schema and migration authority                                    |
| [src/auth/auth.controller.ts](../src/auth/auth.controller.ts)<br>[src/auth/auth.module.ts](../src/auth/auth.module.ts)<br>[src/auth/auth.service.ts](../src/auth/auth.service.ts)                                                                                | Existing session/role/limiter modules; their presence is not a hosting claim |
| [src/common/api-exception.filter.ts](../src/common/api-exception.filter.ts)                                                                                                                                                                                      | Safe errors, origin handling, or request correlation as implemented          |
| [docs/openapi.yaml](../docs/openapi.yaml)                                                                                                                                                                                                                        | Published request/response contract source                                   |
| [test](../test)                                                                                                                                                                                                                                                  | Existing test/support directory; configured does not mean rerun              |
| [.github/workflows](../.github/workflows)                                                                                                                                                                                                                        | Configured CI; hosted outcomes require separate verification                 |
| [src/app.controller.spec.ts](../src/app.controller.spec.ts)<br>[src/auth/auth.controller.spec.ts](../src/auth/auth.controller.spec.ts)                                                                                                                           | Examples of existing colocated tests                                         |

The source map follows the existing framework directories and test placement.

## 4. Screens, navigation, and lifecycle

This repository has no rendered screens. It supports the frontend through the HTTP/domain contracts in sections 5–7. Its lifecycle entry, response/error mapping, session behavior where present, and storage ownership are listed in section 3. Startup health is http://127.0.0.1:5402/api/v1/health; that configured address is not evidence of a running service. Persistent state is owned by this backend; preserve existing database files during changes.

## 5. Primary workflows and recovery

### Implemented Design Patterns and Use Cases

- **Layered modular monolith:** NestJS controllers validate/authorize requests, inventory application services implement commands and reads, `InventoryTransactionService` owns transaction/idempotency boundaries, and `DatabaseService` owns PGlite access.
- **Ledger-backed inventory:** receipts, transfers, adjustments, and count variances append stock-ledger movements alongside balance changes. Reservations change available/reserved quantities without pretending to be a completed sale.
- **Optimistic concurrency and idempotency:** cycle counts submit the inventory version they observed; commands store request hashes and replay validated results for the same key. Reusing a key with a different payload is rejected.
- **Commit-before-notify:** allowlisted inventory events publish after a successful, non-replayed command; room membership is assigned from the authenticated server session and location scope.

| Use case         | Actor and server-owned result                                                                                                                                                                      | Failure/recovery behavior                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Receive stock    | Associate or manager records an inbound quantity and ledger movement at an authorized location.                                                                                                    | Unknown inventory/location is rejected; same-key retries do not duplicate stock or publish a second event.                                                         |
| Transfer stock   | Manager creates an in-transit transfer, atomically reducing available source stock; an authorized destination user receives it, increasing destination stock and recording the inbound ledger row. | Same-location, unavailable stock, missing destination inventory, or resolved transfer is rejected; transaction rollback preserves balances and ledger consistency. |
| Cycle count      | Associate or manager records observed stock against the version read from inventory; variance is audited and ledgered.                                                                             | Stale versions or a count below reserved units conflict and require refreshing/recounting. Zero variance is recorded without an unnecessary balance-change event.  |
| Adjust stock     | Manager records a signed manual quantity adjustment with a note.                                                                                                                                   | A change that would reduce on-hand below reserved quantity is rejected without applying the adjustment.                                                            |
| Reserve/release  | Associate or manager reserves available units for a workflow, then releases the active reservation when no longer needed.                                                                          | Insufficient available stock, missing reservation, or an already released reservation is rejected; a retry uses the original idempotency key.                      |
| Review inventory | Authorized users browse location-scoped inventory, overview, ledger, transfers, and reservations; auditor is read-only.                                                                            | Unauthenticated users, out-of-home associates, invalid filters, and auditor mutations are denied before state changes.                                             |

### Receive Sequence

```mermaid
sequenceDiagram
  actor Staff
  participant UI as Browser UI
  participant API as NestJS API
  participant Auth as Session and guards
  participant Tx as Inventory transaction service
  participant DB as PGlite
  participant WS as Socket.IO

  Staff->>UI: Sign in
  UI->>API: POST /api/v1/auth/login
  API->>DB: Verify seeded Argon2id credential
  DB-->>API: User record
  API-->>UI: Session cookie, user, CSRF token
  Staff->>UI: Submit receipt
  UI->>API: POST /api/v1/receipts + CSRF + idempotency key
  API->>Auth: Validate session, origin, role, and request
  Auth-->>API: Authorized user
  API->>Tx: Execute scoped idempotent command
  Tx->>DB: Update balance, append ledger, store replay result
  DB-->>Tx: Commit result
  Tx-->>API: Mutation result
  API->>WS: Publish allowlisted inventory.updated event
  API-->>UI: Validated receipt result
  WS-->>UI: Location-scoped inventory update
```

Invalid authorization or schema input is rejected before the stock transaction. A transaction failure rolls back the balance, ledger row, and idempotency record together; replayed commands do not publish a second stock event.

## 6. Domain, persistence, and data ownership

The API owns the current persistence boundary. Keep database engines, schema/migration order, exact-money rules where applicable, and transaction invariants consistent with executable source.

### Data Model

```mermaid
erDiagram
  LOCATIONS ||--o{ INVENTORY : holds
  SKUS ||--o{ INVENTORY : identifies
  USERS ||--o{ STOCK_LEDGER : records
  LOCATIONS ||--o{ STOCK_LEDGER : scopes
  SKUS ||--o{ STOCK_LEDGER : identifies
  LOCATIONS ||--o{ TRANSFERS : source
  LOCATIONS ||--o{ TRANSFERS : destination
  SKUS ||--o{ TRANSFERS : moves
  USERS ||--o{ RESERVATIONS : creates
  INVENTORY ||--o{ RESERVATIONS : reserves
  USERS ||--o{ CYCLE_COUNTS : records
  INVENTORY ||--o{ CYCLE_COUNTS : counts
```

`inventory` stores on-hand, reserved, and optimistic version values with database checks. `stock_ledger` records movements. Transfers and reservations have explicit state. State-changing operations and their ledger entries are committed transactionally with bounded idempotency records.

## 7. API and internal contracts

The repository contract is [docs/openapi.yaml](../docs/openapi.yaml). Keep public paths, status/error envelopes, headers, payload validation, and compatibility tied to that source.

### HTTP and Event Contracts

All API routes are under `/api/v1`.

| Route                                                                                 | Authorization                                | Purpose                                              |
| ------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| `GET /health`                                                                         | Public, local only                           | Process health contract                              |
| `POST /auth/login`                                                                    | Public, rate limited                         | Argon2id demo login; rotates the session ID          |
| `GET /auth/synthetic-roles`                                                           | Public, development only                     | Active role codes only; no identities or credentials |
| `GET /auth/session`                                                                   | Public                                       | Current server-side session and CSRF token           |
| `POST /auth/logout`                                                                   | Authenticated + CSRF                         | Destroy session                                      |
| `GET /locations`, `/inventory`, `/overview`, `/ledger`, `/transfers`, `/reservations` | Authenticated                                | Read models with associate location scope            |
| `POST /receipts`, `/transfers`, `/cycle-counts`, `/adjustments`, `/reservations`      | Authenticated, CSRF, role gated              | Validated idempotent state changes                   |
| `PATCH /transfers/:id/receive`, `/reservations/:id/release`                           | Authenticated, CSRF, role and resource scope | Resolve transfer or reservation                      |

All request bodies, query objects, IDs, and idempotency keys are parsed against strict Zod schemas. State changes use the `Idempotency-Key` header and return stable error codes with request IDs.

The source default is `isMock=true` in `stocksync-frontend/src/config/mock-mode.ts`;
`VITE_IS_MOCK` is a build/development-server override. The mode selects the API endpoint
only. In both modes, role codes come from `GET /auth/synthetic-roles`, credentials are
validated by `POST /auth/login`, and session/role/ownership checks remain backend-owned.
No client-selected role or user ID authorizes an API request, and the content model contains
no password. The API hides synthetic-role discovery and refuses startup in production until
production identity/session controls are implemented.

Mock mode uses `VITE_MOCK_API_BASE_URL` when configured; local Vite development may use the
loopback `/api/v1` proxy or legacy `VITE_API_BASE_URL`. Production mock deployment requires
an explicit test API base URL. Live mode requires `VITE_REAL_API_BASE_URL` and never falls
back to the mock endpoint. These Vite variables are public build-time settings, not secrets.
The isolated E2E runner tests both modes against a seeded API on ports 5403/5404 with
in-memory PGlite and makes the unselected endpoint unreachable; live-selection E2E verifies
routing, not a real database integration.

Stock-change events contain only location ID, SKU ID, version, and event type. Associates subscribe only to their home-location room; managers and auditors subscribe to the global read room. Events publish to the affected location and global readers after the database operation commits.

The versioned [OpenAPI 3.1 contract](openapi.yaml) documents HTTP request/response shapes, cookie authentication, CSRF, idempotency headers, and common error responses. Strict Zod schemas remain the runtime enforcement boundary; the OpenAPI file is a maintained contract, not generated from those schemas.

## 8. Security, privacy, and egress

Current release limitation: **The OpenAPI duplicate mapping is corrected. Archived npm start scripts still use Unix syntax. Production sessions, persistence, retry safety, and WebSocket hosting require separate validation.**

Only the local simulator controls in the current source are implemented. CORS, a role label, and mode selection do not provide a new production identity boundary.

Keep private credentials out of public models, browser bundles, logs, URLs, and source archives. No additional runtime network destination or external service is configured. Keep logs limited to the source-defined request/trace and safe aggregate fields. Backups, retention, deletion, and real-user ownership need explicit product/operations decisions before external exposure.

## 9. Design, accessibility, and platform adapters

There is no visual rendering or native package in this API repository. Preserve safe errors and stable contracts so the frontend can present accessible recovery states. Hardware scanning, banking/payment rails, shipping providers, and native integrations remain limited to what the current source actually implements; simulator behavior is not device/provider integration.

## 10. Build, checks, and deployment

Configured npm scripts, from this repository with Node **24.15.0**; use `npm.cmd` in PowerShell:

| Command                    | Actual manifest definition                                       |
| -------------------------- | ---------------------------------------------------------------- |
| `npm.cmd run build`        | `nest build`                                                     |
| `npm.cmd run deploy`       | `nest deploy`                                                    |
| `npm.cmd run format:check` | `prettier --check "src/**/*.ts" "test/**/*.ts" "docs/**/*.yaml"` |
| `npm.cmd run start`        | `STOCKSYNC_START_SERVER=true nest start`                         |
| `npm.cmd run start:dev`    | `STOCKSYNC_START_SERVER=true nest start --watch`                 |
| `npm.cmd run start:prod`   | `STOCKSYNC_START_SERVER=true node dist/main`                     |
| `npm.cmd run lint`         | `oxlint --type-aware src/ test/ && eslint src test`              |
| `npm.cmd run test`         | `vitest run`                                                     |
| `npm.cmd run test:cov`     | `vitest run --coverage`                                          |
| `npm.cmd run test:e2e`     | `vitest run --config ./vitest.config.e2e.ts`                     |

Install with `npm.cmd ci` and retain [package-lock.json](../package-lock.json). Registry access is required for a clean dependency installation. These commands describe the configured checks; execution results are listed in section 13.

The API remains loopback-only. Direct-start storage is `data/stocksync` relative to this repository. On Windows, build, set $env:STOCKSYNC_START_SERVER='true', and run node dist/main.js rather than the preserved Unix npm scripts.

CI configuration is listed in section 3. Run the configured checks before merging or releasing. Deployment requires separate verification of the selected hosting environment.

## 11. Architecture decisions and tradeoffs

### Implemented Design Patterns and Use Cases

- **Layered modular monolith:** NestJS controllers validate/authorize requests, inventory application services implement commands and reads, `InventoryTransactionService` owns transaction/idempotency boundaries, and `DatabaseService` owns PGlite access.
- **Ledger-backed inventory:** receipts, transfers, adjustments, and count variances append stock-ledger movements alongside balance changes. Reservations change available/reserved quantities without pretending to be a completed sale.
- **Optimistic concurrency and idempotency:** cycle counts submit the inventory version they observed; commands store request hashes and replay validated results for the same key. Reusing a key with a different payload is rejected.
- **Commit-before-notify:** allowlisted inventory events publish after a successful, non-replayed command; room membership is assigned from the authenticated server session and location scope.

| Use case         | Actor and server-owned result                                                                                                                                                                      | Failure/recovery behavior                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Receive stock    | Associate or manager records an inbound quantity and ledger movement at an authorized location.                                                                                                    | Unknown inventory/location is rejected; same-key retries do not duplicate stock or publish a second event.                                                         |
| Transfer stock   | Manager creates an in-transit transfer, atomically reducing available source stock; an authorized destination user receives it, increasing destination stock and recording the inbound ledger row. | Same-location, unavailable stock, missing destination inventory, or resolved transfer is rejected; transaction rollback preserves balances and ledger consistency. |
| Cycle count      | Associate or manager records observed stock against the version read from inventory; variance is audited and ledgered.                                                                             | Stale versions or a count below reserved units conflict and require refreshing/recounting. Zero variance is recorded without an unnecessary balance-change event.  |
| Adjust stock     | Manager records a signed manual quantity adjustment with a note.                                                                                                                                   | A change that would reduce on-hand below reserved quantity is rejected without applying the adjustment.                                                            |
| Reserve/release  | Associate or manager reserves available units for a workflow, then releases the active reservation when no longer needed.                                                                          | Insufficient available stock, missing reservation, or an already released reservation is rejected; a retry uses the original idempotency key.                      |
| Review inventory | Authorized users browse location-scoped inventory, overview, ledger, transfers, and reservations; auditor is read-only.                                                                            | Unauthenticated users, out-of-home associates, invalid filters, and auditor mutations are denied before state changes.                                             |

The two Git repositories remain separate. Each owns one maintained README and this repository-local architecture guide. Shared application behavior may be described here for contract context, but implementation changes belong to the owning source module.

## 12. Requirements traceability

| Capability                       | Acceptance                                                        | Owner/path                         | Current status                                                | Evidence                               | Risk                                                                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository-local architecture    | Guide available in this checkout and linked from README           | docs/architecture.md; README.md    | Documented and validated                                      | File, link, and diagram checks         | Keep documentation consistent with source changes                                                                                                                                                |
| API composition and domain state | Preserve existing workflows and failure states                    | src/main.ts and source map         | Implemented; application verification limits are listed below | Current source and existing app design | The OpenAPI duplicate mapping is corrected. Archived npm start scripts still use Unix syntax. Production sessions, persistence, retry safety, and WebSocket hosting require separate validation. |
| Public deployment                | Verified identity, data durability, recovery, and hosted behavior | Existing deployment/API boundaries | Needs separate hardening/verification                         | No new hosted evidence                 | Local checks do not establish production readiness                                                                                                                                               |

## 13. Dated verification and limitations

Last documentation review: **2026-11-09**. The checks below distinguish documentation validation from application and deployment testing.

- Repository-local guide, README link, source-path references, section/contents anchors, and Mermaid syntax: passed documentation validation.
- New application tests/builds, coverage, dependency audits, browser/device accessibility/performance, hosted CI, and Vercel deployment: **not rerun for the documentation updates**.
- Frontend production builds passed on 2026-11-09 with Node 24.15.0. Build success does not establish that all application quality gates pass.
- Outstanding baseline limit: The OpenAPI duplicate mapping is corrected. Archived npm start scripts still use Unix syntax. Production sessions, persistence, retry safety, and WebSocket hosting require separate validation.

The baseline results below record earlier validation. Re-run the listed commands against the current revision before release.

Previously recorded application verification:

### Local Verification

Run the API from `stocksync-backend` with `npm run start:dev`, then the frontend from `stocksync-frontend` with `npm run dev`. The frontend binds to `5401`, the API to `5402`, and both are loopback-only.

Use these checks from the corresponding repository:

```sh
# stocksync-frontend
npm run format:check
npm run lint
npm run test:cov
npm run test:e2e
VITE_IS_MOCK=false npm run test:e2e
npm run build

# stocksync-backend
npm run format:check
npm run lint
npm run test:cov
npm run test:e2e
npm run build
npm audit --audit-level=high
```

Latest frontend coverage passed 91 tests: 95.54% statements, 91.36% branches,
91.80% functions, and 96.59% lines. Latest backend coverage passed 68 tests:
97.17% statements, 91.63% branches, 96.09% functions, and 97.78% lines. The
aggregate 90% gates pass. Additional 95% frontend file gates cover mode
selection, role mapping, login, and inventory-operation mapping; backend
per-file 95% gates cover inventory reads, stock changes, and transfers.
Coverage data does not include CSS. `src/main.tsx` is excluded as bootstrap
wiring and is exercised by the browser tests.

Playwright ran two selected-API flows per mode: seeded-user login/workspace and
manager stock receipt. The API E2E suite passed 10 workflows, including transfer,
cycle count, adjustment, reservation, and release. Browser E2E is not source
coverage. The E2E runners use separate 5403/5404 ports and in-memory PGlite;
the persistent local PGlite directory and already-running 5401/5402 services
were not reused or modified. The browser suite is not run by the standalone
frontend CI because its sibling API repository is not checked out there.

Some individual auth and inventory service branch ratios remain below the
95% critical-module target because one V8 branch maps to each Nest decorator;
the actual request, role, concurrency, and transaction branches are covered.
This is recorded as an unmet per-file threshold, not a coverage pass. A
multi-client Socket.IO deployment test, full workflow through the browser,
Core Web Vitals, and a complete WCAG/axe audit remain outstanding.

## 14. Extension rules and companion repository

Start with [README.md](../README.md) and this guide. The companion repository is [stocksync-frontend](https://github.com/gopichand-retail-apps/stocksync-frontend); clone the pair as siblings when using the existing local integration/model contract. This guide is inside the current repository and does not depend on a parent-folder architecture file to exist.

Update this guide when owned source, routes, persistence, identity, UI states, egress, or deployment behavior changes. Coordinate public contract changes with the companion repository and tests. Preserve existing data, run isolated checks with synthetic records, record failures, and review release and infrastructure changes before publication.
