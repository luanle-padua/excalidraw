# MCM standing dev team — charter

A reusable, always-available "development team" for Canvas M / MCM. The team is a
set of specialist subagents (already installed under `.claude/agents/`) plus skills,
coordinated by a **Lead/Overseer** (the main Claude session) that runs a fixed loop
over the backlog in `docs/plans/TEAM-BACKLOG.md`.

Invoke with **`/team`** (work the top unblocked item) or **`/team <id|topic>`**.

## Roles → installed agents/skills

| Role | Agent(s) `.claude/agents/` | Skills | Scope |
|------|----------------------------|--------|-------|
| **Lead / Overseer** | (main session) | — | Reads backlog, dispatches, serializes writes, makes product calls, keeps user in loop |
| **Backend / Worker** | `backend-architect` | `senior-backend` | `worker/src/index.ts`, R2/D1/DO, Hono routes, Cloudflare limits |
| **Database** | `database-architect`, `database-optimizer` | — | D1 schema + `worker/schema/NNNN_*.sql` migrations |
| **Frontend** | `frontend-developer`, `react-performance-optimization` | `senior-frontend`, `frontend-design` | `excalidraw-app/` React + SCSS |
| **UX / Design** | `ui-ux-designer` | `frontend-design` | Flows, panels, notifications, visual consistency |
| **TypeScript** | `typescript-pro` | — | Strict typing across app + worker |
| **Debugger** | `debugger` | — | Root-cause regressions (recording audio, replay, races) |
| **Reviewer (QA gate)** | `code-reviewer` | `/code-review` | Reviews every diff before deploy |
| **Verifier** | (main session) | `/verify`, Playwright MCP | Runs the app, confirms behavior |
| **Context** | `context-manager` | — | Updates backlog, daily log, session handoff |

## The loop (what `/team` does)

1. **Read** the backlog (`TEAM-BACKLOG.md`) + harness `TaskList`. Pick the top unblocked item, or the one named.
2. **Scope** — dispatch the role's specialist (read-only) to produce an *exact* patch plan (files, edits, reuse). Independent items may be scoped in parallel.
3. **Implement** — apply the edits. **Writes are serialized by the Lead** (see safety). Specialists draft; the Lead applies and keeps changes coherent.
4. **Review** — `code-reviewer` on the diff; fix findings.
5. **Verify** — `yarn test:typecheck`, targeted tests, and `/verify` / Playwright for UI behavior.
6. **Deploy** — *only when the user asks*: see commands below.
7. **Record** — update the backlog row + `docs/logs/<date>.md` + the session handoff (context-manager).
8. **Loop** to the next item (or stop and report).

## Safety rules (non-negotiable)

- **Windows worktree junction footgun.** Never `rm -rf` an agent worktree (it follows the `node_modules` junction and deletes the MAIN repo + tracked files). Use `git worktree remove` only. Do **not** fan out file-*mutating* agents in parallel worktrees on this machine — parallelize **read-only** scoping, **serialize** writes. (memory: `windows-worktree-junction-footgun`.)
- **Cloudflare Worker limits.** Batch D1 in chunks; push heavy R2/DO/Daily work to `waitUntil` background so a delete never blows the subrequest/wall-clock ceiling (the original "delete does nothing" bug).
- **`revoke ≠ delete` moat** for *guest/meeting* data — keep history. Admin *project* force-delete is the deliberate exception (it should free storage).
- **Manual deploy, hard PWA cache.** No git CI; hard-refresh / unregister the service worker after deploy.
- **Production quality.** Simple = scope, not hacky execution. No quick fixes.

## Canonical commands

```bash
# from excalidraw/
yarn test:typecheck                 # tsc (app + packages)
yarn test:app                       # vitest
yarn fix                            # prettier + eslint --fix
yarn build                          # vite build → excalidraw-app/build/

# deploy (manual, only when asked)
wrangler pages deploy ./excalidraw-app/build   # Pages: map-canvasm
cd worker && npm run deploy                     # Worker: mcm-storage
npx wrangler d1 execute mcm-db --remote --file=schema/NNNN_*.sql   # new migration
```

## Memory / handoff

- Daily log: `docs/logs/<YYYY-MM-DD>.md` (Vietnamese). Session resume: `docs/plans/SESSION-<date>-HANDOFF.md`.
- Long-lived specs: `docs/plans/*.md`, `docs/specs/*.md`.
