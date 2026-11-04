# LocalDex Roadmap: Agent Handoff

> **Who this is for:** a coding agent working through this plan for Paris.
> **What it covers:** fixes and features for LocalDex. Some come from an audit of the LocalDex code. Others come from a review of DeepSeek Harness (`deepseek-ai/deepseek-harness`, MIT).
> **Update:** H1 (branch merge) and F5 (Playwright hardening) are already on `main`. Skip H1 and branch from `main`; the rest of the plan stands. Pushing to `main` was a one-off for the merge, so keep using branches and PRs from here.
> **Written:** 2026-11-04. Audited branch: `fix/local-model-tool-calls` @ `b0feac1`. DeepSeek Harness reviewed @ `fcc0ad46` (v0.2.2-rc.1).

---

## 0. Read this first

### 0.1 Ground rules

| Rule | Detail |
|---|---|
| Branching | H1 is already done and the merged work is on `main`. Each task gets its own branch off `main` (`feat/<id>-<slug>`) and a PR into `main`. **Never push to `main` and never merge a PR yourself.** Paris merges. |
| Gate every commit | `npm run typecheck`, `npm run test:council -w server` and `npm run test:local -w server` must all pass. Add tests for each task to the existing suites (mock LM Studio in `server/test/local`, fake vendor CLIs in `server/test/council/fakebin`). |
| Verify, don't trust | Check files on disk and run commands yourself. Do not accept a model's self-report, including your own subagents'. |
| Small model first | The main target is **Gemma 4 12B on an M4 Mac mini with 16 GB RAM, at 32k context, in LM Studio**. New model-facing tools ship **off by default** or with the smallest schema that works, because every extra tool makes small models less reliable. |
| Council billing | Subscriptions only. Never add per-token API usage for Claude, Codex, Gemini or Cursor. |
| Security posture | Keep the existing guarantees: binds to 127.0.0.1, Origin/Host checks, MCP server commands only from the config file, secret redaction, approved folders only. A task that weakens one of these must say so in its PR title. |
| Licensing | DeepSeek Harness is MIT. **Reimplement the patterns** (it is built on the Cordis plugin framework, so its code won't drop in). If you copy any code verbatim, add its notice to `THIRD_PARTY_NOTICES.md`. |
| Docs | Update `README.md` for anything a user can see. For each new model-facing tool, add a short **Model experience** note: what the model sees, the token cost, and any effect on prompt caching. DeepSeek Harness does this for every package, and it's a good habit. |

### 0.2 Repo facts

```
localdex/
├── shared/src/index.ts          # types, settings defaults, WS protocol, MCP defaults
├── server/src/
│   ├── index.ts                 # Hono + ws server, routes
│   ├── lmstudio.ts              # OpenAI-compatible client, tool-mode probe, text-call parser
│   ├── agent/                   # loop.ts, runner.ts, goal.ts, compact.ts, workers.ts, prompts.ts
│   ├── tools/                   # fs.ts, shell.ts, terminal.ts, types.ts (truncate), permissions.ts
│   ├── council/                 # router.ts, orchestrator.ts, worktrees.ts, members/*
│   ├── mcp/client.ts            # stdio MCP client
│   └── skills/                  # skill store + import
├── server/test/{council,local}/ # integration suites (290 + 56 tests, all passing at audit time)
└── web/src/components/          # Chat, Council, Settings, RightPanel, Sidebar, TopBar, …
```

- Dev: `npm run dev` (server on :7331, UI on :5173). Data lives in `~/.localdex/` (override with `LOCALDEX_HOME`).
- Paris's **live copy is `~/localdex-fresh`** on the Mac. It may contain patches that were never pushed, such as a one-line Cursor `systemPrompt` regex fix from the Blackglass session. **Diff it against GitHub before Phase 0** if you have folder access. If you don't, ask Paris to push it or to grant access.
- `node-pty` has no Linux prebuilt binary, so on Linux, `npm ci` fails without build tools. In a Linux sandbox, use `npm ci --ignore-scripts` (H3 fixes this properly).

### 0.3 How to read a task

Each task lists **Why** (the evidence), **Where** (files), **Borrow** (the DeepSeek Harness package to study, under `packages/`), **Do** (steps) and **Done when** (acceptance tests). Effort: S ≈ under ½ day, M ≈ 1–2 days, L ≈ 3+ days.

---

## 1. Priority map

| Phase | ID | Task | Pri | Effort | Status |
|---|---|---|---|---|---|
| 0 | H1 | Merge the drifted branches into `dev/roadmap` | P0 | M | ✅ done: PR #2 and #3 merged to `main` |
| 0 | H2 | CI workflow + LICENSE + THIRD_PARTY_NOTICES | P0 | S |
| 0 | H3 | Make `node-pty` optional (Linux install) | P1 | S |
| 1 | F1 | Fix risk-classifier false positives + per-message override | P0 | S |
| 1 | F2 | Goal/Loop should follow Council mode | P0 | M |
| 1 | F3 | Reviewer grounding gate (no tool calls → no verdict) | P0 | S |
| 1 | F4 | Diff budget sized to each reviewer's context window | P0 | M |
| 1 | F5 | Harden the Playwright MCP defaults | P0 | S | ✅ done (d6d41de) |
| 2 | C1 | Save oversized tool output to a file, show head/tail + path (context-aware budget) | P0 | M |
| 2 | C2 | Trim old tool results before summarizing | P1 | S |
| 2 | C3 | Keep the prompt prefix stable for prompt caching | P1 | S |
| 2 | C4 | Load project instructions (`AGENTS.md` / `CLAUDE.md` / `LOCALDEX.md`) | P1 | S |
| 3 | S1 | Read-before-edit + stale-file check | P0 | S |
| 3 | S2 | Per-turn checkpoints: changed-files card, diffs, **Undo this turn** | P0 | L |
| 3 | S3 | Shell sandbox (macOS Seatbelt / Linux bwrap) + permission presets | P1 | M |
| 3 | S4 | Auto-review for approval prompts (experimental) | P2 | M |
| 3 | S5 | Run existing Claude Code / Codex hooks (experimental) | P3 | M |
| 4 | A1 | Built-in `web_fetch` (+ optional `web_search`) | P1 | M |
| 4 | A2 | Background jobs with completion notices | P1 | M |
| 4 | A3 | Read-only `lsp` tool | P2 | M |
| 4 | A4 | Plan mode with a reviewed exit | P1 | M |
| 4 | A5 | Goal upgrades: goal tools, auto-block, fresh-context rounds | P1 | M |
| 4 | A6 | `@file` mentions in the composer | P2 | S |
| 4 | A7 | Image attachments + `read_image` | P2 | M |
| 4 | A8 | Selectable edit format (`apply_patch` / `str_replace_editor`) | P3 | M |
| 5 | U1 | Sessions: search, rename, auto-title, export | P1 | M |
| 5 | U2 | Stats tab (time to first token, tokens/s, model vs tool time) | P1 | M |
| 5 | U3 | Message thumbs up/down feeding the scorecard | P2 | S |
| 5 | U4 | Fork a session / edit and regenerate | P2 | M |
| 5 | U5 | Unified slash-command palette | P2 | S |
| 5 | U6 | LM Studio request retry with backoff | P1 | S |
| 6 | E1 | MCP manager UI + preset gallery (Playwright, Blender, …) | P1 | M |
| 6 | E2 | Headless CLI: `localdex run "task"` | P2 | M |
| 6 | E3 | "Open PR" from a council worktree (gh CLI) | P2 | S |
| 6 | E4 | Model doctor (tool-calling probe + context-size advice) | P1 | M |
| 6 | E5 | Scheduled goal runs | P3 | M |
| 6 | E6 | Voice input (local speech-to-text) | P3 | M |
| 7 | P1 | Plugin manifest, registry and read-only inventory (built-in features become toggleable plugins) | P1 | M |
| 7 | P2 | **Plugins** tab in Settings: Installed list, enable/disable, config forms | P1 | M |
| 7 | P3 | Install declarative plugin packs from a folder, zip or GitHub, with a consent screen and pinned version | P1 | M |
| 7 | P4 | What a plugin can add: skills, MCP servers, instructions, slash commands, council roles, settings | P1 | M |
| 7 | P5 | Code plugins as separate processes (MCP + hooks), with declared permissions | P2 | M |
| 7 | P6 | Plugin index + Discover tab (static JSON, https only) | P2 | M |
| 7 | P7 | Session presets: a named set of plugins per chat | P2 | S |
| 7 | P8 | Plugin Creator: the agent drafts a plugin, you review and install it, Undo | P2 | M |
| 7 | P9 | Plugin suggestion cards | P3 | S |
| 7 | P10 | `PLUGINS.md` authoring guide + `localdex plugin validate` | P2 | S |

Suggested order: **H2 → F1–F4 → C1 → S1 → S2 → C2–C4 → U6 → A4 → A5 → P1–P4 → the rest by priority.** (H1 and F5 are already done.) Phase 7 comes before E1, E2 and the optional tools in Phase 4, because those can then ship as plugins.

---

## 2. Phase 0: Housekeeping

### H1. Merge the drifted branches · P0 · M
**Why.** `main` has only PR #1 (the council). PR #2 (`feat/onboarding`) and PR #3 (`fix/local-model-tool-calls`) are both unmerged, and they conflict in 3 files.
**Do.**
1. Before you start, diff `~/localdex-fresh` against `origin/fix/local-model-tool-calls`. Make a commit for each live-only patch.
2. `git checkout -b dev/roadmap origin/fix/local-model-tool-calls && git merge origin/feat/onboarding`.
3. Resolve:
   - `server/src/council/members/cursor.ts`: keep **both** sides. Use onboarding's `login(hooks, signal)` signature with `hooks.onUrl(url)`, and the fix branch's `loginBrowser` → `openInApp()` logic and `sdkLoadError` message.
   - `server/src/lmstudio.ts`: keep the fix branch's reasoning-off, text fallback and lenient parsing. Add the model-listing and context helpers that onboarding needs.
   - `web/src/components/Council.tsx`: keep both sets of UI additions (the sign-in browser picker, plus onboarding's changes).
4. Run all three gates, then click through the onboarding flow (local path and cloud path) in a browser.
**Done when.** `dev/roadmap` has both branches merged, the gates pass, onboarding works end to end, and a PR `dev/roadmap → main` is open for Paris.

### H2. CI + license files · P0 · S
**Why.** There's no `.github/` folder, so the 346 tests never run on push. The README says MIT, but there's no `LICENSE` file.
**Do.** Add `.github/workflows/ci.yml`: Node 20 and 22 on `macos-latest` (node-pty prebuilt binaries exist there), running `npm ci`, the typecheck and both test suites. Add an MIT `LICENSE` (holder: Paris) and an empty `THIRD_PARTY_NOTICES.md` with a header.
**Done when.** CI is green on the PR.

### H3. `node-pty` optional · P1 · S
**Why.** `npm ci` fails on Linux because node-pty has no Linux prebuilt binary.
**Where.** `package.json` `postinstall`, `server/src/tools/terminal.ts`.
**Do.** Move `node-pty` to `optionalDependencies` and load it lazily. If it's missing, disable the `terminal_*` tools with a clear note in Settings → Capabilities ("Persistent terminals need node-pty: install build tools, then `npm rebuild node-pty`"). `shell_run` keeps working.
**Done when.** `npm ci` succeeds in a fresh Linux container, and the tests pass with the terminal tools reported as unavailable.

---

## 3. Phase 1: Fixes found in the audit

### F1. Risk classifier false positives · P0 · S
**Why.** `server/src/council/router.ts` line 46 contains `ci( config| pipeline| workflow)?`. The trailing `?` makes a bare **"CI"** count as `deploy/infra`. That misfired on a real task ("add `--fail-on` for CI gating"). Other words that are too loose: `sessions?` (LocalDex itself has "sessions"), `log ?in`, `permissions?`, `prod`, `tls`, `certificates?`.
**Do.**
1. Require context: `ci` only as `ci config|ci pipeline|ci workflow|ci/cd|\.github/workflows`. `sessions` only in auth phrases (`session (token|cookie|fixation|hijack)`, `user sessions`). Do the same for `prod` (`prod(uction)? (db|database|deploy|server|data)`).
2. Add a per-message **"Not risky"** chip next to the access switch. It sets `route.risk = 'normal'`, logs that the user overrode it, and still respects the access mode.
3. Show the matched words on the run card (they're already in `riskReasons`) with a link: "Wrong? Mark not risky".
**Done when.** New tests cover these phrases: "add a --fail-on flag for CI" → normal; "update the CI pipeline config" → high; "list chat sessions in the sidebar" → normal; "fix session token expiry" → high; "productivity tweaks" → normal.

### F2. Goal/Loop should follow Council mode · P0 · M
**Why.** In `server/src/agent/runner.ts`, `startGoalRun()` (line ~232) always calls `this.run()`, the local loop, even when `session.mode === 'council'`. Paris hit this in a live run.
**Do.** Add `goal.lead: 'local' | 'council'`. It defaults to the session mode when the goal is set, and the Goal panel shows a toggle. When `council`, each iteration becomes a council turn (`runCouncilTurn` with the goal brief plus the last checkpoint). The finish checkpoint is judged by the council `reviewer` role, not the local model. Respect `maxIterations` and Stop.
**Done when.** A test with fake CLIs shows a council-led goal running 2 iterations through council members, with no LM Studio calls for the main loop. The Solo goal behaviour is unchanged.

### F3. Reviewer grounding gate · P0 · S
**Why.** The local Gemma reviewer approved builds without reading anything. Worker reports are already annotated "made NO tool calls" (`agent/workers.ts:112`), but council verdicts aren't checked.
**Where.** `server/src/council/orchestrator.ts`, in `readVerdict()` (line ~338) and around the review/QA steps (line ~227).
**Do.** If the `review` or `qa` step's `transcript` has **zero tool items** and the diff was not inlined in its prompt, treat the verdict as `missing` ("changes requested: reviewer did not inspect the work"). Show a badge on the step: "ungrounded". Add a setting, `council.requireGroundedReview`, default on.
**Done when.** A test where a fake reviewer says "APPROVED" with no tool calls ends in a fix round or a "no verdict" outcome, not "approved".

### F4. Diff budget per reviewer · P0 · M
**Why.** `MAX_DIFF = 40_000` characters (`orchestrator.ts:57`) is about 10k tokens. With the prompt on top, that overflowed Gemma's 32k window.
**Do.**
1. Get each member's context window. For the local model, read the loaded context from LM Studio (already available in `lmstudio.ts`). For cloud members, use a generous constant.
2. Budget = 35% of the window, minus prompt overhead.
3. When a diff exceeds the budget for a **local** reviewer, review **one file at a time** (one sub-review per file group, then a merge pass), or send a `--stat` summary with the full diff saved through C1 for the reviewer to read on demand.
**Done when.** A 120 KB diff with a mocked 32k local model produces no context-overflow errors, and every file gets reviewed.

### F5. Playwright MCP hardening · P0 · S
**Why.** The default config runs `npx -y @playwright/mcp@latest --headless --isolated` (`shared/src/index.ts:689`). Chromium runs without its sandbox by default, and the browser tools follow links the agent picks. An earlier CVE check found critical Chromium bugs that Playwright's bundled Chromium had not patched yet.
**Do.** Change the defaults to `--sandbox`, `--browser chrome` (the system Chrome, which auto-updates) and a pinned `@playwright/mcp@<x.y.z>` instead of `@latest`. Add a README note on bumping the pin. **Don't** touch existing user configs: log a one-time hint if theirs lacks `--sandbox`.
**Done when.** A fresh `config.json` has the new args, and the MCP integration test still launches the server.

---

## 4. Phase 2: Context budget (highest-value DeepSeek Harness ideas for 32k models)

### C1. Save oversized tool output to a file · P0 · M
**Why.** The output caps are fixed and ignore the model's context window. In `tools/types.ts:67`, `MAX_OUTPUT = 30_000` characters (about 7.5k tokens, roughly a quarter of 32k). In `tools/fs.ts:8`, `read_file` allows `MAX_READ = 200_000` characters (about 50k tokens, **more than the whole window**). `truncate()` throws the middle away with no way to get it back.
**Borrow.** `spill/spill-policy` (`src/retention.ts`, `src/notice.ts`) and `spill/spill-local` (`src/store.ts`, `src/cleanup.ts`). The pattern: keep an ordered head and tail inline, save the **complete** output to a private session file, and end with a notice that names the omitted bytes and the file path. Their default is `maxInlineTokens: 12500`.
**Do.**
1. Add `server/src/spill.ts`. It writes the full text to `~/.localdex/spill/<sessionId>/<callId>.txt` and returns head (60%) + `[...]` + tail (25%) + the notice: `Output was N chars; showing start and end. Full output: <path>. Read it with read_file start_line/end_line or grep.`
2. Inline budget = `min(30% of the context window, 12.5k tokens)`, at roughly 4 characters per token, with a floor for unknown context sizes.
3. Use it in `shell_run`, `terminal_*`, MCP results, worker reports and `grep`. For `read_file`, cap at the budget and tell the model which line range to read next, instead of saving to a file.
4. In `tools/permissions.ts`, let file tools **read** the spill folder (never write to it). Delete spill files when their session is deleted.
**Done when.** A mock 500 KB `shell_run` output leaves a prompt under budget, the model can `read_file` the spill file, and a deleted session takes its spill folder with it.

### C2. Trim old tool results before summarizing · P1 · S
**Why.** Compact & Resume always summarizes, which costs a model call on a slow local model. Often, just trimming old tool outputs is enough.
**Borrow.** `compaction/compaction-tool-result-pruner`. When pressure qualifies, rewrite each tool result over 8,192 characters as its first 4,096 + `\n\n[... tool result middle pruned ...]\n\n` + its last 1,024. Keep the original in the session log, then re-measure, and skip summarizing if the request now fits.
**Where.** `server/src/agent/compact.ts`, in `maybeCompactMain`.
**Do.** Run the trim pass first (it never touches the latest turn). The archived transcript keeps the originals. Log "pruned N results, saved ~T tokens".
**Done when.** A test with a long, tool-heavy history stays under the threshold without a summary call.

### C3. Keep the prompt prefix stable · P1 · S
**Why.** LM Studio reuses its cache for a prompt prefix that hasn't changed (the "KV cache"). Any byte change near the top forces the whole prompt to be processed again, which is slow on an M4. `prompts.ts` rebuilds the system prompt before every step (`ensureSystemPrompt` in `beforeStep`). It includes `Date:`, the tool list, the MCP notes and the skills, so toggling a tool mid-session changes the prefix.
**Borrow.** DeepSeek Harness labels each package with its "KV Cache effect" (append-only vs. invalidating). `context/time-context` *appends* a clock reading as a message, at most every 10 minutes, instead of editing the system prompt.
**Do.** Freeze the system prompt per session. Rebuild it only when the tool set actually changes, and log "system prompt changed (cache reset)". Move the date and time into an appended context line. Measure time to first token on the second step, before and after, with LM Studio's response stats.
**Done when.** The system prompt is byte-identical across steps of one run (test with a hash), and the measured time to first token is reported in the PR.

### C4. Project instructions file · P1 · S
**Why.** LocalDex doesn't load `AGENTS.md` or `CLAUDE.md`, so users repeat project conventions in every chat.
**Borrow.** `context/agent-instructions`. It loads a user-global chain plus the project chain with **separate byte budgets**: broader files are dropped before the most specific one is truncated, and nested files are discovered as the agent touches folders.
**Do.** Look for `~/.localdex/AGENTS.md`, then `<approved root>/AGENTS.md | CLAUDE.md | LOCALDEX.md`, then nested ones when the agent reads or writes inside a subfolder. Default budget: 4 KB global and 8 KB project. Put them in the system prompt once per session (see C3). Add a toggle in Settings → Instructions.
**Done when.** A test project with `AGENTS.md` shows its text in the system prompt, and a 50 KB file is truncated with a notice.

---

## 5. Phase 3: Safety and trust

### S1. Read-before-edit + stale check · P0 · S
**Why.** The prompt already says "Read a file before editing it", but nothing enforces it. Small models edit blind and overwrite changes made outside LocalDex.
**Borrow.** `fs/fs-observation-policy`. Edits need a prior read, and a mutation is rejected if the file changed since that read. Its errors: `cannot modify "<path>": file has not been read — read the file, then retry` and `… — re-read the file, then retry`.
**Where.** `server/src/tools/fs.ts`, plus per-agent state on the session or worker.
**Do.** When `read_file` runs, record `{path → mtimeMs, size, sha1}` per agent. `edit_file`, and `write_file` on an *existing* file, require a record and a matching fingerprint. Reading a missing path allows creating it. `write_file` updates the record after a successful write, so chained edits work. Add a setting, default on, with an off switch for odd models. The records reset on Compact & Resume.
**Done when.** Mock tests: an edit without a read is refused with that exact text, a file changed externally is refused, and read → edit → edit succeeds.

### S2. Per-turn checkpoints + Undo · P0 · L
**Why.** Council builders work in a separate copy with Apply/Discard, but **Solo edits go straight to disk with no way back**.
**Borrow.** `deliverables/workspace-changes` (`src/git.ts`, `src/capture.ts`, `src/recorder.ts`, `src/compare.ts`). At turn start and turn end it takes a git snapshot of the working tree **using a temporary index, so the user's index is never touched**, plus a whole-file copy before the first file-tool edit (which covers files git doesn't track). It produces a per-turn changed-files summary with line counts and a before/after comparison for each file. Note their listed limits: edits the user makes during a turn are attributed to that turn, and outside git only file-tool edits are seen.
**Do.**
1. Add `server/src/checkpoints.ts`. Snapshot with `GIT_INDEX_FILE=<tmp> git add -A && git write-tree` at turn start and end, and also copy files before their first `write_file`/`edit_file`. Store everything under `~/.localdex/checkpoints/<session>/<turn>/`.
2. UI: a **Changed files** card under each assistant turn (file, +/-), a diff viewer, and **Undo this turn**, which restores the turn-start contents of the listed files. If a file changed after the turn ended, refuse with a clear message, the same rule as council Apply.
3. Keep checkpoints for the last N turns (default 20). They survive restarts, unlike in DeepSeek Harness.
**Done when.** Tests cover git and non-git folders, undo after a write and after an edit, an undo refused because of a later external change, and a user's staged changes that are untouched afterwards.

### S3. Shell sandbox + permission presets · P1 · M
**Why.** `shell_run` runs with full user privileges. Approved folders constrain the file tools, not shell commands.
**Borrow.** `sandbox/sandbox-local/src/profiles.ts` (about 60 lines).
- macOS: `sandbox-exec -p '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null")) (allow file-write* (subpath "<root>") …)'`. Canonicalize every root, because `/tmp` is really `/private/tmp`.
- Linux: `bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent --tmpfs /tmp --bind <root> <root>`.
- It **fails closed** (`SANDBOX_UNAVAILABLE`) instead of quietly running without a sandbox.
- `interaction/permission-presets` bundles sandbox mode and approval policy into named presets.

**Do.** Add presets to Settings → Workspace and the composer:
- **Read only:** shell sandboxed read-only, file writes off.
- **Workspace (sandboxed):** writes allowed only in approved folders, temp and spill; dangerous commands still ask. Recommended default on macOS.
- **Full access:** today's behaviour.

When a sandboxed command fails with a write denial, show "Command was blocked by the sandbox: allow once with full access?" (a one-shot escalation through the existing approval flow). Also apply it to `terminal_*`.
**Done when.** On macOS, `touch ~/outside.txt` is denied under the Workspace preset and `touch <root>/ok.txt` works. On a platform with no sandbox, the preset is shown as unavailable instead of silently not working.

### S4. Auto-review for approval prompts (experimental) · P2 · M
**Why.** Constant approval prompts get rubber-stamped.
**Borrow.** `experimental/auto-review/src/index.ts` lines 53–77 (the reviewer system prompt). It asks for strict JSON, `{"risk":"low|medium|high","decision":"allow|deny","reason"?}`, with rules: low = allow, medium = deny unless the user explicitly authorized it, high (exfiltration) = always deny, and fail closed when unsure.
**Do.** Add an opt-in preset. Before a "dangerous" approval prompt, ask a reviewer: preferably the council `quick` member (subscription), and the local model only if the user opts in (**a 12B model is not a safe judge**). Low → run it. Anything else, or invalid JSON, → show the normal prompt with the reviewer's reason. Log every decision in the Log panel.
**Done when.** Tests with a fake reviewer cover allow-low, deny-medium → user prompt, invalid JSON → user prompt, and a high-risk call that is never auto-allowed.

### S5. Run existing hooks (experimental) · P3 · M
**Borrow.** `experimental/hooks-claude-code` and `experimental/hook-protocol`. They run the user's existing Claude Code `hooks.json` (PreToolUse / PostToolUse / UserPromptSubmit / Stop): block with a reason the model sees, add context, or force another turn.
**Do.** Off by default, and loaded only from `~/.localdex/hooks.json` or the user's `~/.claude/settings.json`, **never from project files**, in line with the untrusted-config rule.

---

## 6. Phase 4: Agent capabilities

### A1. `web_fetch` (+ optional `web_search`) · P1 · M
**Why.** Playwright is heavy for small models. Most lookups just need one page as Markdown.
**Borrow.** `web/tool-web` (`src/fetch.ts`, turndown with GFM) and `web/web-fetch-http` (bounded fetch, same-origin redirects only, text only).
**Do.** Add a `web_fetch(url)` tool: http(s) only, a size cap, HTML → Markdown, oversized output saved through C1, and the result wrapped in `<web_result>` tags marked as untrusted (like MCP results). `web_search` gets a pluggable provider (a user-configured SearXNG URL to start), off by default. Both start disabled in Capabilities.
**Done when.** Tests against a local HTTP fixture cover redirects, a binary file refused, and size capping.

### A2. Background jobs · P1 · M
**Why.** Dev servers and watch tasks block `shell_run` or need hand-managed terminals.
**Borrow.** `jobs/jobs-local` (an output ring buffer, ownership, lifecycle) and `jobs/tool-jobs` (`job_output` with a bounded wait that yields early to a user correction, `job_list`, `job_kill`). When a job finishes, the agent gets a short notice: a busy agent sees it on its next step, and an idle agent is woken by a follow-up turn, with a cap on wakeups.
**Do.** Add `shell_run({ background: true })` that returns a job id, plus those three tools. Show jobs in a right-panel list with Kill. Feed completion notices into the existing corrections queue.
**Done when.** A test starts `sleep 1; echo done` in the background, the agent receives the notice, and `job_kill` stops a long job.

### A3. Read-only `lsp` tool · P2 · M
**Borrow.** `lsp/lsp-stdio` and `lsp/tool-lsp`: four read-only operations (definition, references, implementations, hover) with 1-based positions and results grouped by file and capped.
**Do.** Detect `typescript-language-server`, `pyright-langserver` and `gopls` on PATH. Off by default, with a short schema.

### A4. Plan mode · P1 · M
**Borrow.** `plan/plan-mode`: `/plan` explores and designs, the finished plan goes to the user for approval, and they approve or send feedback. Unlike DeepSeek Harness (where plan mode is guidance only), **enforce it**.
**Do.** `/plan <task>` hides the write and shell-mutation tools (reads, glob, grep and read-only shell stay), and the agent ends with `update_plan` plus a summary. The UI shows **Approve & run** / **Revise** / **Cancel**. Approving restores the tools and runs the plan as the brief. Plan mode survives a session reload.

### A5. Goal upgrades · P1 · M
**Borrow.**
- `goal/tool-goal`: the model can `get_goal`, `update_goal` and `complete_goal` / `block_goal`, with a revision id (no stale updates). The goal blocks after **3 consecutive blocked rounds**.
- `experimental/tool-ralph`: **fresh-context rounds**. Each round is a new agent that only gets the fixed objective, the previous round's report (capped in size) and the workspace state.

**Do.**
1. Give the model the goal tools, so it can mark a goal complete or blocked with a reason, instead of relying only on the finish-checkpoint prompt.
2. Add the Goal option **Fresh context each round** (recommended for 32k models). Seed each round with the brief, the last report (2k tokens at most), the *Files on disk right now* block from `compact.ts`, and the plan. This avoids the steady quality loss that sets in as the context fills up.

**Done when.** Mock tests: three blocked rounds stop the goal with a visible blocker, and in fresh mode round 2's prompt is under 4k tokens.

### A6. `@file` mentions · P2 · S
**Borrow.** `context/file-reference` (the mention syntax) and `file-reference-local` (completion).
**Do.** Typing `@` in the composer lists files in the approved folders (fuzzy, capped). A picked file is inserted as a path and attached as a read hint ("User referenced: path"). Its content isn't inlined, to save context.

### A7. Image attachments · P2 · M
**Borrow.** `attachment/attachment-local` (content-addressed image storage) and `compaction/compaction-image-offload` (drop images when the model's image budget is exceeded).
**Do.** Add paste/drop images in the composer, send them as OpenAI `image_url` parts to vision-capable LM Studio models (check the model's capabilities), and add a `read_image(path)` tool. Old images are swapped for `[image: path]` during compaction.

### A8. Selectable edit format · P3 · M
**Borrow.** `fs/fs-patch` (a Codex-style patch parser) and `fs/tool-str-replace-editor`.
**Do.** Add a per-model setting, "Edit tool style": `edit_file` (default) / `apply_patch` / `str_replace_editor`. Some fine-tunes were trained on one specific format. Measure with E4 before recommending one.

---

## 7. Phase 5: Sessions and UX

### U1. Session search, rename, auto-title, export · P1 · M
**Why.** The sidebar can only delete.
**Borrow.** `session-query/session-query-sqlite` (full-text search), `session-query/session-log-export` (Markdown copy and ZIP export, plus an `/export` command) and `session/session-title-first-prompt-llm`.
**Do.** Search across session titles and messages (a pure-JS index such as MiniSearch avoids another native dependency; switch to `node:sqlite` once Node 22+ is the minimum). Add inline rename, an auto-title from the first prompt by the local model (one short call, can be turned off), and **Export → Markdown / JSON**.

### U2. Stats tab · P1 · M
**Why.** On local models, speed *is* the user experience, and nobody can see it today.
**Borrow.** `experimental/client-ui-stats`. Each turn expands into steps showing context and output tokens, time to first token, model vs. tool time, output speed and a total-time bar.
**Do.** Record timings in `lmstudio.ts` (request start, first token, end, tokens) and in the tool runner. Add a **Stats** tab in the right panel. LM Studio's native REST API (`/api/v0/...`) returns `time_to_first_token` and `tokens_per_second`, so use those when they're available.

### U3. Message feedback · P2 · S
**Borrow.** `feedback/message-feedback`.
**Do.** Add 👍/👎 and an optional category on assistant messages, stored in the session. Roll the results up per model and per council member into the existing scorecard.

### U4. Fork / edit and regenerate · P2 · M
**Borrow.** `subagent/subagent-fork-in-process` (children start with the parent's completed turns).
**Do.** **Fork from here** on any message copies the session up to that point. **Edit** on a user message re-runs from there in a fork, so history is never destroyed. (Check that neither exists first.)

### U5. Unified slash-command palette · P2 · S
**Borrow.** `interaction/commands`: commands that act directly, without creating a model message.
**Do.** Typing `/` opens a palette listing `/plan`, `/goal`, `/compact`, `/export`, `/undo`, `/fork` and the existing council commands (`/ask`, `/build`, `/vote`, …), with short descriptions.

### U6. LM Studio retry · P1 · S
**Why.** `lmstudio.ts` only retries the `reasoning_effort` rejection. Brief LM Studio hiccups (a model loading, a 5xx, a dropped connection) currently stop the run.
**Borrow.** `llm/llm-retry`: retries happen at clean step boundaries, never in the middle of a stream after tokens were shown.
**Do.** Retry up to 3 times with backoff (1 s, 3 s, 8 s) when no tokens have streamed yet, and log each retry. Never retry after a partial stream.

---

## 8. Phase 6: Ecosystem

### E1. MCP manager UI + preset gallery · P1 · M
> **Build this on top of P1–P4 and P6**: the gallery entries are first-party plugin packs, and the MCP tab is a filtered view of the Plugins tab. Don't build a second install flow.

**Why.** Today servers can only be added by editing `config.json`. That's safe on purpose, but unfriendly.
**Borrow.** `mcp/mcp-manager` (add, edit, probe and observe servers at runtime) and `mcp/mcp-resources`.
**Do.** Add a gallery: **Playwright**, **Blender** (already running on Paris's Mac), Filesystem, GitHub. **Add** shows the exact command, args and env in a confirm dialog, and requires typing the server name to confirm. Then it writes `config.json` *on the server side* and runs **Test connection** (list tools). Keep the rule that the WebSocket can't set arbitrary commands: only gallery entries, or a confirm flow that is re-checked on the server, can add one. Show `allowTools` as checkboxes, with a warning above 8 tools.

### E2. Headless CLI · P2 · M
**Borrow.** `bundle/headless` (run one task from the command line and print the final answer).
**Do.** `npx localdex run "task" --folder . [--model X] [--council] [--access read|ask|edit] [--json]`. Exit code 0 if done, 1 if stopped or failed. Approvals are denied by default unless `--yes-safe` is passed (and dangerous commands are always denied). This makes LocalDex usable in scripts and CI.

### E3. "Open PR" from a council worktree · P2 · S
**Borrow.** `experimental/forge` and `forge-github` (gh CLI, PR status polling).
**Do.** Next to Apply/Discard, add **Open PR**. It commits the worktree to a new branch, pushes, runs `gh pr create`, and shows a PR status chip that refreshes. Hidden when `gh` isn't installed or authenticated.

### E4. Model doctor · P1 · M
**Why.** Picking a local model is guesswork. Recent questions (Gemma vs. Bonsai, which context size fits 16 GB) needed manual research.
**Do.** **Settings → Model & Agent → Run model doctor** runs about 10 scripted tool-calling probes against the loaded model (a native call, the text protocol, a multi-step edit, JSON with newlines, honesty when a tool fails) plus a speed test. It reports a score card (tool-call success rate, edits that land, tokens/s, time to first token) and suggests **tool mode, reasoning setting and a context size** based on reported RAM and model size (for example, 16 GB with a 12B model → 32k). Save results per model so they can be compared.
**Done when.** It runs against the mock LM Studio in tests, and the report renders.

### E5. Scheduled goal runs · P3 · M
**Borrow.** `schedule/schedule`.
**Do.** "Run this goal daily at HH:MM" for a folder (for example "fix failing tests"). It only runs while LocalDex is running, and every approval rule still applies.

### E6. Voice input · P3 · M
**Borrow.** `experimental/speech-to-text-sensevoice` (local CPU speech-to-text worker) and `client-ui-voice-input` (the transcript goes into the draft for review, never sent automatically).
**Do.** A mic button with a local Whisper/SenseVoice worker. Nothing leaves the machine.

---

## 9. Phase 7: Plugin system

**What DeepSeek Harness does (the experience to copy).** Everything optional is a plugin with a name, a config schema and display text. Plugins have a **Plugins page** with **Installed** and **Discover** tabs, can be turned on and off without a restart, and sit in named **profiles/bundles**. A **plugin index** is one static JSON file (`format: 1`) listing installable versions, each with a pinned source (npm package, or Git repo + **commit** + folder) and a compatibility range. Install always shows a **confirmation with the exact source**, and the UI warns that indexes are third-party content. There are per-session **presets** (different plugin sets per chat). The agent can **suggest** a plugin with a card, and a **Creator mode** lets it write one, with Undo/Restore. Plugin packages also carry "model experience" notes (what the model sees, token cost, cache effect).
Study: `packages/boot/plugin-manager`, `plugin-market`, `config-editor`, `hmr`; `packages/host/plugin-inventory`; `packages/client/ui-plugin-manager`, `ui-plugin-market`, `ui-settings-plugins`; `packages/preset/agent-preset`, `agent-preset-registry`; `packages/experimental/plugin-recommendations`, `creation-recommendations`; `docs/cookbook/plugin-market.md`; `docs/cookbook/extension-cookbook.md`.

**What LocalDex must do differently.** DeepSeek Harness runs plugin code inside its own process. LocalDex can read your files and run commands, so a plugin that is just code in the server would be a way around every protection. LocalDex plugins come in two kinds:

| Kind | What it is | Risk |
|---|---|---|
| **Pack (declarative)** | A folder with a manifest and files only: skills, instructions, slash-command templates, council role presets, MCP server entries, settings. No code of its own runs. | Low. The one exception is an MCP entry, which starts a program, so it gets its own prominent line on the consent screen. |
| **Code plugin** | Needs to run code. Allowed only as a **separate process**: an MCP server for tools, or a command hook that reads JSON on stdin and answers on stdout. Never `require()`d into the LocalDex server. | Real. Needs declared permissions, the sandbox from S3 where available, and a clear consent screen. |

**Security rules (apply to every P-task):**
1. Installing, updating, enabling a code plugin, or changing a plugin's permissions happens only through a **server-side confirmation** that shows exactly what will be added (commands, args, env names, folders, hooks). The WebSocket message is a *request*; the server re-checks it, as it does for MCP today. A plugin can never approve itself.
2. A plugin can **never** change: approved folders, the 127.0.0.1 binding, Origin/Host checks, shell approval mode, subscription-only council billing, or redaction. Reject any manifest that tries.
3. Installs are **pinned**: a Git commit hash or a version, plus a SHA-256 of the unpacked files, saved in `~/.localdex/plugins.lock.json`. **No automatic updates.** An update that adds or widens a permission asks again.
4. Plugin MCP servers go through the same rules as hand-written ones: minimal environment, short `allowTools`, results wrapped as untrusted, approval once per server.
5. Add `LOCALDEX_SAFE_MODE=1` (and a **Safe mode** button) that starts with all third-party plugins off, so a bad plugin can't lock you out.
6. Every plugin action (install, enable, hook run, blocked call) is written to the Log panel.
7. A plugin's skills and instructions count against the context budget (C4); show their token cost on the plugin's card.

### P1. Manifest, registry and inventory · P1 · M
**Where.** New `server/src/plugins/` (`manifest.ts`, `registry.ts`, `inventory.ts`), types in `shared/src/index.ts`.
**Do.**
1. Define `localdex-plugin.json` and validate it strictly (reject unknown top-level keys):
   ```json
   {
     "format": 1,
     "name": "blender",
     "version": "1.0.0",
     "title": "Blender",
     "description": "Control Blender from the agent",
     "author": "…",
     "engines": { "localdex": ">=0.2.0" },
     "permissions": { "shell": false, "network": false, "writeFolders": [], "env": [] },
     "contributes": {
       "skills": ["skills/*"],
       "instructions": "INSTRUCTIONS.md",
       "mcpServers": { "blender": { "command": "uvx", "args": ["blender-mcp"], "allowTools": ["…"] } },
       "commands": [{ "name": "/scene", "file": "commands/scene.md" }],
       "councilRoles": {},
       "settings": { "type": "object", "properties": {} },
       "hooks": []
     }
   }
   ```
2. Registry: scan `~/.localdex/plugins/<name>/`, read state from `~/.localdex/plugins.json` (`enabled`, `config`, `installedFrom`), and expose `list()`, `enable()`, `disable()`, `getConfig()`.
3. **Built-in plugins.** Turn LocalDex's own optional features into entries in the same inventory, marked **Provided by LocalDex**: Playwright browsing, `web_fetch` (A1), background jobs (A2), `lsp` (A3), auto-review (S4), hooks (S5), voice (E6), and the council. They are off or on by default exactly as their tasks say. Start by wrapping what already exists (MCP, skills, council) without changing its behaviour.
4. Inventory shows, per plugin: name, version, kind (built-in / pack / code), enabled, live status (`loading`, `ready`, `failed` + the error), what it contributes, and its token cost.
**Done when.** Unit tests cover valid and invalid manifests (unknown key, bad permission, a manifest that tries to set an approved folder), enable/disable persistence, and a failing plugin showing `failed` without stopping the server.

### P2. Plugins tab · P1 · M
**Borrow.** `client/ui-settings-plugins`, `ui-plugin-manager`, `ui-plugin-market` (tab layout, cards, detail page).
**Where.** `web/src/components/Settings.tsx` (new tab id `plugins`), a new `Plugins.tsx`.
**Do.** Tabs **Installed** and **Discover** (Discover arrives in P6; show a "Add a source" empty state until then). Each card: icon, title, version, kind badge, an on/off switch, the token cost, and an error line when failed. The detail page lists everything the plugin contributes and its permissions, and has a config form generated from its `settings` schema. Enable/disable applies at once for packs (see P4), and with a "restart needed" note only where truly necessary. **Skills and MCP Servers tabs become filtered views of the same data** (keep their URLs working).
**Done when.** Toggling a plugin in the UI changes the system prompt or tool list on the next step (checked in a test), and a plugin with a broken manifest shows an error card.

### P3. Install packs · P1 · M
**Borrow.** `boot/plugin-manager` (install, remove, update, approval of the exact source) and `docs/cookbook/plugin-market.md` (what the confirmation shows). **Reuse** `server/src/skills/import.ts` for folder, zip and GitHub fetching.
**Do.**
1. Sources: drag in a folder or `.zip`, or paste `https://github.com/owner/repo[/tree/<ref>/<dir>]`. Resolve a Git ref to a **commit hash** and store it. Public repos only, as with skills today.
2. Consent screen (server-driven) listing: name, version, source + commit, the SHA-256, every contribution, every permission, and in red any MCP command and any hook. The confirm button needs a second click on anything red.
3. Update flow compares the new manifest to the old one and highlights added or widened permissions. Remove deletes the folder and its state, and leaves the user's own settings alone.
4. Refuse: a manifest above format 1, a path that escapes the plugin folder (`..`, absolute paths, symlinks out), files over a size cap, and more than N files.
**Done when.** Tests cover a zip with a path-traversal entry (refused), a symlink out (refused), a clean install, an update that adds a permission (asks again), and remove.

### P4. What a plugin can add · P1 · M
**Do.** Wire each contribution type into the existing code, with these rules:

| Contribution | Wired into | Rule |
|---|---|---|
| `skills` | `skills/store.ts` | Namespaced `<plugin>/<skill>`. Same progressive loading (name + description only in the prompt). |
| `instructions` | C4 | Counted against the instructions byte budget; truncated with a notice. |
| `mcpServers` | `mcp/client.ts` | Same defaults as hand-written entries: `approval: once`, main agent only, minimal env. Shown in the MCP tab as "from plugin X". |
| `commands` | U5 palette | A markdown template with `$ARGS`. It sends a normal user message, so it can't do anything the user couldn't type. |
| `councilRoles` | `council/router.ts` | May add or reorder members for a role. May **not** switch on write access or change billing mode. |
| `settings` | P2 | JSON-schema form. Values are readable by that plugin's own contributions only. |
| `hooks` | S5 / P5 | Command hooks only. |

On conflict (two plugins add the same command or skill name), the first-enabled wins and the Log panel says so. Disabling a plugin removes all of its contributions on the next step.
**Done when.** One test pack that contributes one of each type is installed, enabled and disabled, and the prompt, tool list, MCP list and palette change accordingly. Two packs with the same command name produce a logged conflict, not a crash.

### P5. Code plugins as separate processes · P2 · M
**Why.** Some plugins need real code (a custom tool, a hook that runs a linter). Keep that outside the server.
**Do.**
1. A code plugin declares `contributes.mcpServers` (tools) and/or `contributes.hooks` (events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`) with a command. Hooks get one JSON object on stdin and answer on stdout (`{"decision":"block","reason":"…"}` or `{"context":"…"}`), with a timeout (default 10 s). Reuse the protocol in S5.
2. Declared `permissions` are shown on the consent screen **and enforced where possible**: run the process under the S3 sandbox with only the declared `writeFolders` writable, and start it with only the declared `env` names. On a machine without a sandbox, say so on the consent screen ("not confined").
3. A crashing or timing-out hook is skipped and logged, never blocks the run. A **blocking** hook can only block; it can never *approve* something that would have asked.
4. Never `import()` plugin code into the server.
**Done when.** Tests: a hook that blocks `shell_run rm -rf` (the model sees the reason), a hook that hangs (skipped after the timeout), a code plugin started with only its declared env variables, and a plugin attempting to write outside its folder (denied where a sandbox exists).

### P6. Plugin index + Discover tab · P2 · M
**Borrow.** `util/plugin-market-index` (format and validation), `boot/plugin-market`, `client/ui-plugin-market`, `docs/cookbook/plugin-market.md`.
**Do.**
1. **Index format** (static JSON, `format: 1`): `plugins[]` with `name`, `title`, `description`, `icon`, `author`, `homepage`, `keywords`, and `versions[]` with `version`, `publishTimestamp`, `engines.localdex`, and `source` = `{ "type": "git", "url", "commit", "path" }` or `{ "type": "zip", "url", "sha256" }`. **Every version must be pinned** (a commit hash or a SHA-256). Reject the whole index, with the JSON path of the bad value, if any rule is broken.
2. **No default source.** The user adds one by URL in **Discover → Add index source**. `https:` only, no credentials in the URL, no redirects, size cap, 10 s timeout. Show each source's last error.
3. Cards show the newest version compatible with this LocalDex (non-prerelease first). Install opens the P3 consent screen with the exact commit. The Discover page says plainly: "Indexes are third-party content; check the source before you install."
4. Publish a **starter index** in this repo, `plugins/index.json`, plus a generator script (`npm run plugin:index -- <repo-list.txt>`). The user may add it as a source; it's never added automatically. List the first-party plugin packs there (see the first-party packs list at the end of this phase).
5. Search by name, keywords and description (typo-tolerant, as in U1).
**Done when.** Tests with a local HTTP fixture cover a valid index, one with an unpinned version (rejected), one over the size cap, and one that redirects (rejected).

### P7. Session presets · P2 · S
**Borrow.** `preset/agent-preset`, `agent-preset-registry`.
**Do.** A **preset** is a name plus a list of enabled plugins and a default access mode (for example "Security research", "Frontend", "Reading only"). The top bar has a preset picker per session, so the global plugin on/off state remains the default. A session saves its preset, and switching presets changes the tool list and prompt on the next step (see C3 for the cache note: log "system prompt changed").
**Done when.** Two sessions with different presets show different tool lists in the same running server.

### P8. Plugin Creator · P2 · M
**Borrow.** `extensions/tool-cordis` (the agent inspects the runtime API before writing plugin code), `experimental/creation-recommendations` (the Create card with Undo and Restore).
**Do.**
1. A **Creator** slash command (`/plugin new <idea>`) gives the agent two extra tools for that run only: `plugin_schema` (returns the manifest format, the contribution types and a worked example) and `plugin_draft_write` (writes under `~/.localdex/plugins-dev/<name>/`, nowhere else).
2. When the agent finishes, run `validate` on the draft and show a review screen: file list, the manifest, and every permission. **Install** goes through the normal P3 consent screen. **Undo** removes the plugin again, and **Restore** puts it back.
3. The agent can never enable, install, or edit anything outside the draft folder. A draft is not loaded until installed.
**Done when.** A test drives a fake model that writes a draft; the draft validates, nothing is loaded before Install, and Undo/Restore round-trips.

### P9. Plugin suggestion cards · P3 · S
**Borrow.** `experimental/plugin-recommendations`.
**Do.** After a finished answer, if the request clearly matches an *installed but disabled* plugin or a first-party pack in a source the user added, show one card: **Enable** / **Not now**. Never suggest uninstalled third-party plugins by name from the model's own memory, and never more than one card per answer. Clicking starts no model turn. Off by default.

### P10. Authoring guide + validator · P2 · S
**Borrow.** `docs/cookbook/adding-a-package.md` and the "Model Experience" README contract.
**Do.** Add `PLUGINS.md`: the manifest, every contribution type with an example, the security rules above, how to pin and publish an index entry, and a **Model experience** section every plugin README should fill in (what the model sees, token cost, and whether it changes the prompt prefix). Add `npx localdex plugin validate <folder>` (uses the E2 CLI entry point; until E2 exists, ship it as `npm run plugin:validate -w server -- <folder>`) with the same checks the installer runs.

**First-party packs to publish once P1–P6 land** (each a small, declarative pack in `plugins/`): `blender` (the Blender MCP entry + a short skill), `playwright` (the hardened browser entry from F5), `github` (a safe `gh`-based skill), `security-lab` (a preset plus instructions for Paris's SOC-analyst work: ATT&CK-mapped notes, no live scanning of third-party systems), and `council-presets` (extra roles). Keep each pack under 20 KB.

---

## 10. Reviewed and rejected (don't build)

| DeepSeek Harness idea | Why not, for LocalDex |
|---|---|
| "Everything is a plugin" / Cordis rewrite | LocalDex is about 16k lines and works. A framework migration costs far more than it returns. Phase 7 borrows the **plugin experience** (Plugins page, install flow, index, presets) but not the architecture. |
| Plugins that run inside the server process | DeepSeek Harness loads plugin code in-process, and its SAFETY.md says it is not security-audited. A LocalDex plugin that is not just data must run as a **separate process** (P5). |
| The agent mounting plugins by itself at runtime | Plugin Creator (P8) only writes a draft. Install always goes through the consent screen. |
| `run_code` tools (`tool-executor-ptc`, `agent-tool-presentation: ptc`) | A 12B model writes worse programs than it makes single tool calls. Revisit only for strong models. |
| `workflow` scripts that fan out subagents | The council orchestrator already covers multi-agent patterns. |
| `agent-team` shared task board | LM Studio serves one request per loaded model, so parallel local agents queue anyway. |
| `repeat-tool-reminder` | LocalDex already has a stronger version (warn at 3, stop at 5, plus thinking cut-offs). |
| Liveshare, OpenTelemetry, telemetry, plugin market, DeepSeek account/API, reasoning translation, webworker runtime | Out of scope for a private, local-first tool, or tied to DeepSeek's own services. |
| `claude-code-mods` bridge | Interesting, but niche. S5 and P5 cover the useful part (hooks). |
| Plugin market with a built-in default source | DeepSeek ships no default index, and neither should LocalDex. The user adds sources (P6). |

---

## 11. When you finish a task

1. The gates pass, new tests are added, and the README is updated (with a Model experience note for new tools).
2. Open a PR into `dev/roadmap` that has: a summary, evidence (test output, screenshots for UI work), any security impact, and **"Borrowed from: packages/<path>"** if a DeepSeek Harness pattern was used.
3. Tick the task off in the section 1 table in this file, in the same PR.
4. Stop and ask Paris before anything irreversible or anything that changes a security default.
