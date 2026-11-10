# APP-03 StockSync - Agent Instructions

This repository owns the StockSync backend. Before changes, read `~/Downloads/PORTFOLIO_COMPLETE_AGENT_PLAYBOOK.md` and `~/Downloads/APP-03_STOCKSYNC.md`; those are the full architecture, UX, security, and delivery requirements.

## Mandatory code quality
- TypeScript strict mode. Avoid `any`, unsafe assertions, unchecked promises, silent error swallowing, and broad lint disables.
- Keep TS/JS/Java lines at or below 120 characters, except documented URLs, schemas, and generated code. Enforce with ESLint `max-len`, Prettier `printWidth`, or Java Checkstyle as applicable.
- Cognitive complexity is at most 15 per function. Control-flow nesting is at most 3 where feasible.
- Target at most 50 logical lines per function, 400 lines per source file except justified compositions/generated code, and 4 positional parameters. Prefer named parameter objects.
- No unused or duplicate code, unreachable branches, hard-coded credentials, production `console.log`, magic business constants, or circular dependencies.
- New-code gate: zero new blocker/critical issues, at most 3% duplication, all security hotspots reviewed, and no high-confidence leaked secrets. Verify actual Sonar rule/edition support; do not assume defaults match.

## Testing and CI
- Enforce at least 90% for each of lines, statements, functions, and branches; at least 95%
  for critical domain logic and 90% changed-code coverage. Below-gate exceptions must be
  owner-approved, timeboxed, and reported as unmet; do not blanket-exclude UI or business logic.
- Test domain invariants, valid/invalid input, database transactions/rollback, permissions and cross-user ownership, idempotency/replay, concurrency, dependency failure, and safe logs as applicable.
- CI must block on formatting, lint, typecheck, unit/integration/E2E, coverage, security/secret/dependency scans, migration validation, build, and configured quality-gate failures. Report skipped checks distinctly.

## Security, logging, and documentation
- Enforce server-side authentication, role and resource ownership; validate all untrusted inputs; use parameterized persistence; apply rate limits, bounded request sizes, and transaction-safe stock invariants.
- Never log credentials, tokens, raw payloads, or identifying financial data. Use structured success/failure logs with request and trace IDs; verify redaction.
- Maintain canonical `docs/architecture.md` with C4, trust-boundary data flow, ERD/data
  ownership, implemented patterns, use cases, failures/recovery, API/events, test commands,
  and deployment boundaries. Architecture diagrams, design patterns, and engineering
  roadmaps belong in Markdown, never product UI. README covers purpose, roles, local setup,
  limits, and versioned integrations.
- Use synthetic data. Never claim security or compliance based only on checklists or automated scans.
