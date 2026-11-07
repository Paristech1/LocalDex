# LocalDex

**Chat On Steroids, but for your own local LLM.** A browser-based coding agent that drives
[LM Studio](https://lmstudio.ai) through its OpenAI-compatible API and gives the model real
access to your files and terminal, with workers, Goal/Loop autonomy, and Compact & Resume.

Your files. Your terminal. Your local model. Nothing leaves your machine.

```
Browser (React UI)  <-- WebSocket -->  LocalDex server (Node)  -->  LM Studio :1234
                                             |
                                             +--> tools: read/write/edit/glob/grep/shell/pty
                                             +--> workers (parallel sub-agents, own memory)
                                             +--> sessions  ~/.localdex/sessions/*.json
```

## Features

- **Agent loop with real tools** – `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`
  (ripgrep), `shell_run`, persistent `terminal_*` ptys, `ask_user`, `update_plan`.
- **Approved folders** – the agent can only touch paths inside folders you approve. Dangerous shell
  commands (`rm -rf`, `sudo`, force-push, `curl | sh`, …) prompt for approval.
- **Live tool results** – every call streams into the chat as a collapsible card with args and output.
- **Task plan** – the model keeps a checklist via `update_plan`; it renders in the right panel.
- **Workers** – `delegate_to_worker(name, task)` spawns named sub-agents with their own history.
  Several delegations in one turn run in parallel; reusing a name continues that worker's context.
- **Corrections while it runs** – type while a run is in progress and the message is injected before
  the next model call.
- **Goal / Loop** – set a goal with done-criteria; after each turn a finish checkpoint asks the model
  whether it is done and auto-continues if not (bounded by an iteration cap and a Stop button).
  Loop mode keeps working within a brief indefinitely. In Council mode the goal is **led by the
  council** by default: each iteration is a council turn and the checkpoint is a read-only council
  reviewer; the Goal panel's **Led by** picker switches between the local model and the council.
  While a local-led goal runs the model also gets four small goal tools: `get_goal` (brief, remaining
  items, a revision id), `update_goal` (trim the remaining list), `complete_goal` (close the goal once
  the done criteria are verified; no checkpoint call needed) and `block_goal` (say what stops it).
  Updates with a stale revision id are refused. Three `block_goal` rounds in a row stop the goal
  with the blocker shown in the chat and the Goal panel. **Fresh context each round** (on by
  default for local-led goals, recommended for 32k models) starts every round from a new context:
  the brief, the previous round's report (2k tokens at most), the *Files on disk right now* block
  LocalDex checks itself, and the plan. The old transcript is archived, so quality does not slide as
  the context fills up. *Model experience:* the goal tools are only in the tool list while a goal
  runs (about 250 tokens); a fresh round's seed is typically well under 4k tokens.
- **Web access (opt-in)** – `web_fetch(url)` reads one http(s) page as Markdown: text only, a 2 MB
  cap, redirects only within the same site, binary files refused (by content type and by sniffing),
  and every result wrapped in `<web_result>` tags that tell the model it is untrusted data, like MCP
  results. `web_search(query)` goes through a SearXNG server you set in Settings → Capabilities and is
  hidden until one is configured. Both are **off by default**. *Model experience:* `web_fetch` costs
  about 60 tokens of schema; a long page is saved to disk with head, tail and path inline (see
  oversized output below) rather than flooding the context.
- **Background jobs** – `shell_run` with `background: true` returns a job id at once and keeps the
  command running (dev servers, watchers, long test runs). `job_output` reads what it printed so far
  (with a bounded wait of up to 60 s that ends early when you send a message), `job_list` lists the
  session's jobs and `job_kill` stops one with its whole process group. When a job finishes, a busy
  agent sees a short notice on its next step; an idle agent is woken by a follow-up turn, at most 3
  times between your messages. Jobs appear in the Workers tab with a **Kill** button and die with
  the server. *Model experience:* the three job tools (about 180 tokens) only enter the tool list
  after the session's first background job; the only always-present cost is one `background` flag
  on `shell_run`. Output is kept in a 64 KB ring per job; the model is told when older output fell off.
- **Plan mode** – `/plan <task>` makes the agent explore and design first. It is enforced, not just
  suggested: the write, terminal, worker and council tools are not offered (and refused if the
  model calls them anyway), `shell_run` only runs read-only commands (`ls`, `cat`, `rg`, `git
  status/log/diff`, `npm ls` …), and the run ends with an `update_plan` and a summary. A card under
  the answer offers **Approve & run** (all tools come back and the plan is the brief), **Revise**
  (feedback, still read-only) and **Cancel**. While a plan awaits approval, whatever you type is
  feedback on it. Plan mode is stored with the session, so it survives a reload or a restart.
- **Changed files + Undo this turn** – every Solo turn that touches files gets a card under the
  answer: the files with +/− counts, the diff on demand, and **Undo this turn**, which puts every
  listed file back to how it was when the turn started. Git folders are snapshotted at turn start
  and end through a temporary index (your own index and staged changes are never touched), so
  shell edits count too; outside git, edits made by the file tools are tracked. Undo is
  all-or-nothing and refuses, changing nothing, if a file changed after the turn ended (undo the
  later turns first). The last 20 turns per session are kept under `~/.localdex/checkpoints/` and
  survive restarts. Pattern borrowed from DeepSeek Harness `workspace-changes` (reimplemented).
- **Compact & Resume** – manual or automatic (at a configurable fraction of the context window):
  the model summarizes decisions, files changed, open items and worker state, and a fresh context
  is seeded with the summary. The full transcript is archived in the session file. Before
  summarizing, old tool results over 8 KB are pruned to their first 4 KB + last 1 KB (the latest
  turn is left alone, originals stay in the session log); when that alone brings the context under
  the threshold, no summary call is made.
- **Stable prompt prefix** – the system prompt is frozen per session and only rebuilt when the tool
  set, skills or MCP servers really change (logged as a cache reset), so LM Studio can reuse its
  KV cache across steps. The date and time arrive as a `[context]` line at most every
  10 minutes instead of living in the system prompt. It goes just before your new message, so your
  request is always the last thing the model reads, and back-to-back user notes reach the model as
  one user turn (Gemma-style templates reject two in a row). The clock line is hidden in the chat.
- **Survives LM Studio hiccups** – a request that fails before any token arrives (model still
  loading, a 5xx, a dropped connection) is retried up to 3 times after 1 s, 3 s and 8 s, each retry
  logged. A stream that already produced tokens is never retried, so you never see a reply replayed.
- **Works with models that have no native tool support** – LocalDex probes the model once; if it
  does not emit OpenAI `tool_calls`, it switches to a text protocol and parses calls from the reply.
  It also recovers Python-style calls (`write_file(path="a", content="b")`), fenced JSON, and
  common hallucinated tool names (`create_file` → `write_file`).

## Requirements

- Node.js 20+ (tested on 24)
- LM Studio with the local server running (`lms server start` or Developer → Start Server)
- A chat model loaded (or JIT loading enabled). See *Choosing a model* below.
- Optional: `node-pty` for the persistent `terminal_*` tools. It installs automatically on macOS and Windows (prebuilt binaries).
  On Linux it needs build tools (`python3`, `make`, a C++ compiler); without them `npm install` still succeeds, the terminal tools
  are hidden from the model, and Settings → Capabilities says so. To enable them later: install the build tools, then `npm rebuild node-pty`.
  `shell_run` works either way.

## Quick start

```bash
npm install
npm run dev          # server on :7331, UI on http://localhost:5173
```

1. Open http://localhost:5173.
2. **Settings → Workspace**: approve the project folder the agent may work in.
3. Pick a model in the top bar (loaded models are marked ●).
4. Describe a task and press Enter.

Production-style single process (serves the built UI from the server on :7331):

```bash
npm run build
npm start            # http://localhost:7331
```

## Headless (command line)

Run one task without the web UI. The answer goes to stdout, logs to stderr:

```bash
npx localdex run "fix the failing test in src/date.ts" --folder ~/code/app        # inside the LocalDex repo
npm run cli -- run "summarize what this repo does" --access read --json
npm link -w server && localdex run "…"                                          # install `localdex` globally
```

| Option | Meaning |
|---|---|
| `--folder <dir>` | Project folder (default: current folder). Approved for this run only |
| `--model <id>` | LM Studio model (default: Settings) |
| `--council` | Send the task to the model council |
| `--access read\|ask\|edit` | `read`: nothing may change files · `ask` (default): normal rules, anything that would ask is denied · `edit`: council builders may edit |
| `--yes-safe` | Approve prompts for commands not on the dangerous list. Dangerous commands (`rm -rf`, `sudo`, force-push…) are always denied |
| `--max-steps <n>` | Step cap |
| `--json` | Print `{"status","answer","session","steps","error"}` |
| `--verbose` | Tool calls on stderr |

Exit code 0 = done, 1 = stopped or failed, 2 = bad usage. Questions from the agent are answered with "no user is available". Options apply to that run only and are never saved to `config.json`. The session is saved like any other, so you can open it in the UI afterwards. MCP servers are not started in headless runs.

## Using it

| Panel | What it does |
| --- | --- |
| **Chat** | Streaming replies, reasoning (collapsible), tool cards, approval and question prompts. Send while running = correction. |
| **Plan** | Checklist maintained by the model with `update_plan`. |
| **Workers** | Status, last task, live stream and full transcript per worker. Reset or delete a worker's memory. Background jobs with Kill. |
| **Goal** | Start a Goal (until done) or a Loop (keep working), led by the local model or the council, with or without a fresh context each round. Shows iteration, last checkpoint, remaining items and any blocker the model reported. **Scheduled goals**: a goal that starts by itself at a time of day on chosen days, in a new session, in one of your approved folders (e.g. 07:30 weekdays: "run the tests and fix failures"). Only while LocalDex is running; a time missed while it was off is skipped. Approvals still wait for you. **Run now** starts it at once. |
| **Context** | Token usage vs. context window, compactions, "Compact & Resume now", latest summary. |
| **Stats** | Per step: context and output tokens, time to first token, model time vs. tool time, output speed; last 20 steps or the whole session. On a local model, speed *is* the experience: a jump in time to first token usually means the prompt prefix changed and LM Studio's cache was reset. Measured by LocalDex around each request (LM Studio's own `/api/v0` timings are not used). |
| **Log** | Server events: tool-mode detection, recovered tool calls, goal checkpoints, errors. |

Keyboard: `Enter` send, `Shift+Enter` newline, `Cmd/Ctrl+,` settings, `Esc` close.

**Voice** (🎙 in the composer): dictate a message. The audio is converted with `ffmpeg` and transcribed **on this computer** with whisper.cpp, and the text goes into the message box for you to check; nothing is sent until you press Send. It needs `ffmpeg`, whisper.cpp (`brew install whisper-cpp`) and a model file in `~/.localdex/models/` (e.g. `ggml-base.en.bin` from huggingface.co/ggerganov/whisper.cpp). The button only shows when all three are there, and Settings → Workspace says what's missing. Set another binary, model or language in `~/.localdex/config.json` under `"voice": { "command", "model", "language" }`.

**Images**: paste or drop screenshots and mockups into the composer (PNG, JPEG, WebP or GIF, up to 10 MB; checked by content, not by name). Vision models in LM Studio (type `vlm`) receive the image itself. Other models get a placeholder telling them an image was attached that they can't see. To save context, only the three most recent images are sent again; older ones become `[image: path]` text. Vision models also get a `read_image` tool for image files in your folders (hidden for text-only models). In Council mode the members get the image file paths, since their CLIs open files themselves.

**File mentions**: type `@` in the composer to pick a file from your first approved folder (fuzzy match; `node_modules`, `.git`, build folders and protected files like `.env` are left out). Mentioned files are named to the model as a short read hint; their content is not pasted in, so it costs almost no context.

**Slash commands**: type `/` in the composer for a palette (↑/↓, Tab or Enter to pick). Commands marked *runs now* act directly and send nothing to the model: `/goal <done-when>`, `/loop <brief>`, `/compact`, `/undo` (last Solo turn that changed files), `/export [md|json]`, `/new`, `/council` / `/solo`. `/plan <task>` and the council commands (`/ask`, `/build`, `/second`, `/review`, `/vote`, `/frontend`, `/backend`, `/vision`, `/arena`) are sent as the message.

Slash commands in Solo: `/plan <task>` (plan first, read-only until approved; **not** the same as Council mode’s `/plan …`, which asks the cloud planner). The council
commands (`/ask`, `/build`, `/review`, `/vote`, `/arena` …) are listed under
[Model council](#model-council-cloud-models-on-your-subscriptions).

### Sessions: search, rename, export

- **Search** (box at the top of the sidebar) looks through every session's title and messages: typo-tolerant and prefix matching, best match first, with a snippet. Tool output and internal notes are not indexed.
- **Rename**: double-click a session's name, or the ✎ button.
- **Automatic names**: after the first answer in a new Solo session, the local model writes a 3–7 word title (one short call with no tools, after your run so it never delays it). A name you set yourself is never replaced. Off switch: Settings → Workspace.
- **Export** (⤓ on a session): Markdown (messages in order, tool calls and results in collapsible blocks, archived parts after Compact & Resume at the end) or the raw JSON session file. Also at `GET /api/sessions/<id>/export?format=md|json`.

### Rate answers

Hover a finished answer for 👍 / 👎 (click again to clear). A 👎 offers a reason: wrong answer, claimed things it didn't check, ignored my instructions, broke something, too long, too slow. Ratings are saved on the message, then added up per local model (shown in the **Stats** tab) and, for council answers, for each member that finished a step in that run (the **👍/👎** column of the council scorecard).

### Fork and edit

Hover a message for **Fork** / **Fork from here**: the conversation up to that point is copied into a new session (model, mode, plan and worker memory come along; Solo undo history, council copies and members' own vendor sessions don't). **Edit** on one of your messages re-runs from there with the new text, in a fork: the original session keeps its message and answer, so nothing is ever lost. `/fork` copies the whole conversation. A forked session links back to where it came from.

## Settings

- **Workspace** – approved folders (first one is the default cwd), **Permissions** preset, shell approval mode.
- **Model & Agent** – LM Studio base URL, default and worker model, tool call mode (auto/native/text),
  temperature, max steps per run, context length override, auto-compact threshold, worker concurrency.
- **Capabilities** – toggle individual tools. Fewer tools make small models more reliable.
- **Instructions** – custom text appended to the system prompt of the main agent and all workers.

Settings and sessions live in `~/.localdex/` (override with `LOCALDEX_HOME`). Server port: `PORT`.

## Security

LocalDex can read your files and run commands, so it only accepts your own browser:

- The server listens on `127.0.0.1` only, so other machines on your network cannot reach it. (`LOCALDEX_HOST=0.0.0.0` overrides this; don't, unless you know why.)
- The WebSocket and every `/api` route reject requests from other websites (foreign `Origin`) and from rebinding tricks (foreign `Host`). Other websites you visit can no longer drive the agent through your localhost.
- If you serve the UI from another local hostname, add it with `LOCALDEX_ALLOWED_HOSTS=name1,name2`.

### Permissions (shell sandbox)

**Settings → Workspace → Permissions** (also a picker in the Solo composer) sets how much the local agent's shell can change:

| Preset | Shell commands | File tools |
|---|---|---|
| **Full access** (default) | Run with your user's rights | `write_file` / `edit_file` inside the approved folders |
| **Workspace (sandboxed)** | May only write inside the approved folders, temp and tool caches (`~/.npm`, `~/.cache`, …). A blocked command asks you once whether to run it with full access | Same as above |
| **Read only** | Writes are blocked everywhere, including the approved folders. No escalation | `write_file` / `edit_file` are off |

The sandbox is macOS Seatbelt (`sandbox-exec`) or Linux bubblewrap (`sudo apt install bubblewrap`). It covers `shell_run`, background jobs and `terminal_*`. With no sandbox on the machine, the sandboxed presets are unavailable, and a preset that needs one **fails closed** (nothing runs) rather than running unconfined. Extra writable folders for the Workspace preset go in `~/.localdex/config.json` as `"sandboxExtraWritable": ["~/somewhere"]` (not editable from the UI). `LOCALDEX_SANDBOX=none` forces "no sandbox" for debugging. Council members are separate: they use their vendor's own sandbox and the per-message access switch.

### Auto-review (experimental)

**Settings → Workspace → Auto-review risky commands** (off by default). Before LocalDex asks you about a risky shell command (`rm -rf`, force-push, `sudo`…), a reviewer rates it against a fixed rubric and answers in strict JSON. Only **low risk** (normal project work, or deleting exact files the agent generated) runs without asking. Medium or high risk, an unreadable answer, or a reviewer error shows the normal prompt with the reviewer's reason added. It never auto-approves medium or high risk, sandbox escalations, or MCP calls. The reviewer is the council's quick member (read-only, on your subscription) or, if you choose, the local model. A small local model is not a safe judge, so prefer the council. Every decision goes to the Log panel.

### Hooks (experimental)

**Settings → Workspace → Run my hooks** runs hooks in Claude Code's format during Solo runs, from `~/.localdex/hooks.json` or your own `~/.claude/settings.json`. They are **never loaded from a project folder**, so a cloned repo can't run commands. LocalDex tools are named as Claude Code names them (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`…), so existing matchers work. Each hook gets the usual JSON on stdin.

- **PreToolUse**: exit 2, `{"decision":"block"}` or `permissionDecision: "deny"` blocks the call, and the model sees your reason.
- **PostToolUse**: `additionalContext` (or a block reason) is added to the tool result as feedback.
- **UserPromptSubmit**: can block the message, and plain stdout or `additionalContext` becomes context.
- **Stop**: a block asks for another turn with your reason, at most 3 times per message.

Hooks can **never approve** anything that would otherwise ask, and `"allow"` is ignored. A hook that crashes or times out (default 60 s) is skipped and logged, never blocking the run.

## Project instructions

LocalDex loads instruction files into the system prompt, each under its own byte budget so one never crowds out the other:

- `~/.localdex/AGENTS.md` – your own rules for every project (first 4 KB).
- `<approved folder>/AGENTS.md`, or `CLAUDE.md`, or `LOCALDEX.md` (first match wins; first 8 KB).
- Instruction files in subfolders are appended as a `[context]` message the first time the agent reads, edits or lists
  something in that folder (first 4 KB each), so the system prompt itself stays stable.

A file over its budget is cut at a line end with a notice saying so. Workers get the same instructions. Turn it off in
**Settings → Instructions → Load instruction files**. Pattern borrowed from DeepSeek Harness `agent-instructions` (reimplemented).

## Skills

A skill is a folder with a `SKILL.md` (frontmatter `name` + `description`, then instructions) plus any files it needs. Skills live in `~/.localdex/skills/<name>/`.

Add one in **Settings → Skills**:

- **Drag and drop** a skill folder, a `SKILL.md`, any `.md` file, or a `.zip` (several at once is fine).
- **Paste a GitHub link**: `https://github.com/owner/repo` imports every skill in the repo; a `/tree/<branch>/<folder>` or `/blob/.../SKILL.md` link imports just that one. Public repos only.

Only each skill's name and one-line description go into the system prompt. The model calls `load_skill` to read the full text (and `load_skill` with `file` for bundled files). Toggle or remove skills in the same tab. Skills that bundle scripts get a badge; scripts only run if the model calls `shell_run`, so your shell-approval setting still applies.

## Code navigation (`lsp` tool)

Off by default (**Settings → Capabilities → lsp**). When on, the agent can ask a language server where a symbol is defined, where it is used, its implementations, or its type and docs. It is read-only, and it's useful when `grep` would be ambiguous. The model names the symbol on a line (no column counting needed). Results are grouped by file, show the line text, and are capped at 50 locations. Servers are found on your PATH: `typescript-language-server` (TypeScript/JavaScript; LocalDex supplies TypeScript if the project has none), `pyright-langserver`, `gopls`, `rust-analyzer`. Add others in `~/.localdex/config.json` under `"lspServers": { ".rb": { "command": "solargraph", "args": ["stdio"] } }`. A server stays up for 5 idle minutes per project. Line text is only shown for files inside your approved folders.

## MCP servers (extra tools)

LocalDex is an [MCP](https://modelcontextprotocol.io) client. Any stdio MCP server can add tools; the first one
configured is [Playwright MCP](https://github.com/microsoft/playwright-mcp) for browsing (off by default).

1. Open **Settings → MCP Servers** and switch **playwright** on (needs Node 20+; the first start downloads the server via `npx`).
2. Ask the agent to open a page. The first call to a server asks for approval once; approving allows that
   server's exposed tools until LocalDex restarts.

**Gallery** (Settings → MCP Servers): ready-made entries for **Playwright**, **Blender** (`blender-mcp`, every call asks first), **Filesystem** (read-only tools, limited to your approved folders) and **GitHub** (official server, read-only). **Add…** shows the exact command, arguments, tools, environment variables and prerequisites, and you type the server's name to confirm. The browser only sends the gallery id: the command itself is fixed in LocalDex, so the WebSocket still can't start an arbitrary program. Each server card has **Test connection** (restart it and list its tools), **Choose tools** (tick which of the server's tools the model sees; a warning above 8) and **Remove**.

Server definitions live in `~/.localdex/config.json` under `mcpServers`. Your own servers are added by editing that file
(restart LocalDex after editing). From the UI and WebSocket you can only add gallery entries, toggle `enabled`, pick from the
tools a server offers, or remove a server: never type a command, because a server command runs a program on your machine.

```json
"mcpServers": {
  "playwright": {
    "command": "npx",
    "args": ["-y", "@playwright/mcp@0.0.84", "--browser", "chrome", "--sandbox", "--headless", "--isolated"],
    "enabled": true,
    "allowTools": ["browser_navigate", "browser_snapshot", "browser_click", "browser_type"],
    "approval": "once",
    "hint": "Browser: navigate, then read the page with browser_snapshot."
  }
}
```

| Field | Meaning |
| --- | --- |
| `allowTools` / `denyTools` | Which of the server's tools the model sees. **Keep this short**: small local models get less reliable as the tool list grows. |
| `approval` | `once` (default), `always`, or `never`. |
| `allowWorkers` | Let worker agents use the server (default `false`: main agent only). |
| `env` / `inheritEnv` | Servers start with a minimal environment so your secrets are not leaked to them. Add variables with `env`, or copy named ones from LocalDex's own environment with `inheritEnv` (e.g. `["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"]` behind a proxy). |
| `cwd` | Working directory. Default `~/.localdex/mcp/<name>`, so servers' scratch files stay out of your projects. |
| `timeoutSeconds`, `maxOutputChars` | Per-call timeout (60) and cap on output returned to the model (12000). |

MCP tools appear to the model as `mcp_<server>_<tool>`. Their output is wrapped in `<mcp_result>` tags and the system
prompt tells the model to treat it as untrusted data (web pages can contain prompt injection).

## Model council (cloud models on your subscriptions)

LocalDex can hand work to **Claude, Codex (OpenAI), Gemini and Cursor**. Each one runs through the vendor's own tool, on the subscription you are signed into there. LocalDex never handles your passwords or keys.

| Member | Runs as | Sign in once (Terminal) |
|---|---|---|
| Claude | `claude -p --output-format stream-json` | `claude auth login` (Pro/Max) |
| Codex | `codex exec --json` | `codex login` (ChatGPT plan) |
| Gemini | `gemini -p -o stream-json` | `gemini`, then "Login with Google" |
| Cursor | `@cursor/sdk` local agent | **Settings → Council → Sign in** |

Install the CLIs you want (`npm i -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli`), then turn on **Settings → Council**. The tab shows each member's install, sign-in and billing status.

**Two ways to use it**

- **Council mode** (top bar → ☁ Council): each message goes to the council.
  - `/ask claude …` asks one member by name.
  - `/build …` runs plan → build → review.
  - `/second …` builds, then gets a second opinion.
  - `/review …` sends it to the reviewer only.
  - `/vote …` collects independent answers, then a judge combines them.
  - `/frontend …` and `/backend …` send a change to the UI or backend builder.
  - `/vision …` asks a vision-capable member to look at a screenshot or mockup (name the image file; the member opens it itself).
  - `/arena …` (or `/arena claude codex …`) races two builders on the same task, each in its own copy of the project. A third member compares the diffs and recommends one; you keep one or discard both.
  - Plain messages are routed automatically (keyword rules, or the local model if you pick that).
  - The composer has a per-message access switch: **Read only**, **Ask before edits**, **Edits allowed**. It applies to that run only and never changes Settings.
- **Solo mode**: your local model leads. It can call `ask_member` and `council` itself when a task is too big for it, so the work tag-teams. **Hand to council ☁** under the last answer sends your latest request, plus what the local agent already did (files touched, commands, failures), to the council without leaving Solo.

**How runs work**

- **Separate copy (on by default).** Builders edit a git worktree of your project in LocalDex's data folder, including your uncommitted changes. Checks and reviewers run there too. At the end you see the diff and choose **Apply to my folder** (lands as uncommitted changes) or **Discard**. Apply refuses, and changes nothing, if a file it would touch changed in your folder meanwhile. If no copy can be made (e.g. not a git repo), LocalDex asks before editing your folder directly.
- **Open PR** (next to Apply / Discard, shown when the GitHub CLI `gh` is installed and signed in): LocalDex builds one commit on top of your last commit with **only the members' changes** (your own uncommitted work that was copied into the copy stays out; if the members edited those same lines, it refuses and suggests committing first), pushes it to a new `localdex/…` branch and runs `gh pr create` against your current branch (or the default branch). Your folder and branch are not touched. The card then shows the PR's state, checks and review, with ↻ to refresh.
- **Plan → build → review** adds an optional checks gate (your test command, after approval) and a QA step, with strict verdicts and fix rounds.
- **Reviews are grounded (on by default).** A reviewer's or QA's verdict only counts if the member inspected the work: it made at least one tool call, or the whole diff was in its prompt. A blind verdict gets one "look first" re-ask; if it still doesn't look, the run counts it as changes requested and the step shows **did not inspect**. Turn it off in Settings → Council.
- **Diffs are sized to the reviewer.** A cloud member gets the diff inline up to 160k characters; the local model gets ~35% of its context window. Over that, a cloud reviewer gets the `--stat` summary, the changed-file list and the path of the full diff (saved under `~/.localdex/spill/`), and must read the files itself; the local reviewer reviews the diff in up to six file groups (one step each) and merges its notes into one verdict.
- **Votes** wait for a quorum with a grace timer, then advisers rank each other's answers blind before the judge decides.
- **Handoff.** When a member hits its usage limit mid-run, the next one gets a written handoff and continues.
- **Follow-ups** in Council mode resume the same member's own session instead of re-sending the chat.
- **Risk routing** sends risky changes (migrations, auth, deletes…) to stronger models and always asks before editing. The run card shows the words that matched. If the classifier is wrong ("CI" in "add a --fail-on flag for CI", "sessions" in "list chat sessions"), press **Not risky** next to the access switch before sending, or **Wrong? Mark not risky** on the run card to reload the request with it pressed. The access mode still applies; the override is logged and shown on the run.
- **Scorecard** in the Council tab tracks each member's runs, success rate, time, tokens, limits, build and review outcomes.
- **Secrets are redacted** (API keys, tokens, passwords, private keys) from prompts, history and diffs before they reach a cloud member.

**Routing and fallback.** Each role (planner, builder, frontend, backend, reviewer, researcher, vision, quick) has an ordered list of members. Changes with clear UI signals (CSS, components, layout…) go to the frontend builder, clear backend signals (API, SQL, migrations…) to the backend builder, anything mixed to the builder. Requests that name an image file or a screenshot/mockup go to vision (read-only). A member that is off, signed out, or at its usage limit is skipped. When a member hits a limit mid-run, the next one takes over, and the first one cools down until its reset time.

**Guardrails**

- **Subscription only (default on).**
  - API-key variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) are removed before a member starts.
  - Members signed in with an API key are refused.
  - If Claude starts on API billing anyway, LocalDex stops it.
- **Read-only by default.** File edits by the builder are off until you enable them. When on, LocalDex asks before each edit step.
- **Separate permissions.** Members use their vendor's own tools and permission modes, not LocalDex's tools:
  - Claude: edits blocked when read-only, `acceptEdits` when allowed.
  - Codex: `read-only` / `workspace-write` sandbox.
  - Gemini: `plan` / `auto_edit` approval mode.
  - Cursor: mutating tools disallowed when read-only.
- **Project config is not trusted by default.** A cloned repo can't add hooks, MCP servers or settings to a member run: Claude loads only your user settings and no MCP servers (`--setting-sources user --strict-mcp-config`), Cursor loads only user settings, and Gemini runs without `--skip-trust`, so it only works in folders you have trusted in Gemini. Codex already ignores `.codex/` config in projects you haven't trusted. Settings → Council → Advanced → *Trust project config* turns this off for repos you trust.
- **Approved folders only.** Members start in your first approved folder, and the other approved folders are passed as extra directories (not when a builder works in a separate copy).
- **Executables come from config only.** Member programs are found on `PATH`, or set with `council.members.<name>.command` in `~/.localdex/config.json`. That setting cannot be changed from the UI.

The task, and any files a member reads, go to that vendor. Every message written by the council is marked with ☁ in the chat, and the **Council** tab in the right panel shows each run step by step: who did what, live output, tool calls, timing and tokens.

## When a small local model can't call tools

Small local models fail at tool calling in a handful of predictable ways. LocalDex handles each one in a fixed order, and only reaches for the cloud at the end:

| # | What goes wrong | What LocalDex does |
|---|---|---|
| 1 | **Thinking breaks tool calls.** Reasoning models (Gemma 4, Qwen 3…) write a plan or pseudo-code instead of calling the tool, open their thought channel inside the call (which crashes LM Studio's parser), and take several times longer per step. | **Settings → Model & Agent → Reasoning: Auto** sends `reasoning_effort: "none"` while tools are available, for models LM Studio reports a reasoning switch for. Measured on Gemma 4 12B: native tool calls went from 0/3 to 3/3, and a step from ~9.5 s to ~2.5 s. |
| 2 | **LM Studio can't parse the native tool call** (e.g. `Invalid diff: now finding less tool calls`). | In Auto tool mode the model is switched to the text protocol for good and the same step is asked again. Nothing is lost and the switch is logged. |
| 3 | **Malformed arguments**: raw newlines inside JSON strings, Gemma's `<\|"\|>` string tokens, trailing commas, smart quotes, plan steps sent as plain strings. | Lenient parsing and argument normalisation repair these before the tool runs. |
| 4 | **Content double-escaped** (`one\\ntwo` written as one line), or a file left **without a final newline** while the model thinks `wc -l` should agree with it. | `write_file` turns unambiguous literal `\n` into line breaks and says so. Every write and edit reports lines in `wc -l` terms ("3 lines; no newline at end, so `wc -l` reports 2"). |
| 5 | **Retrying a command the user denied.** | The same command is refused without asking again for the rest of the request, and the model is told plainly not to retry it. |
| 6 | **Loops**: the same call with the same arguments and the same result, over and over. | A warning after 3, and the run stops as *stuck* at 5. |
| 7 | **Thinking forever** without acting. | The reply is cut off after ~6000 characters of reasoning and the model is told to act or answer. Three cut-offs in a row means stuck. |
| 8 | **Wrong memory of the files** in Compact & Resume summaries and Goal checkpoints. | LocalDex appends a *Files on disk right now* block it checks itself (exists, lines, bytes), and tells the model to trust it over the summary. |
| 9 | **Still stuck**: LM Studio errors, stuck loops, failures after two warnings, step or goal limits. | The run stops with a visible `[system] Run stopped: …` note. With the council on, **Settings → Council → When the local model gets stuck** decides what happens next: *Suggest* shows **Hand to council ☁**, *Auto* hands the request plus everything the local agent did to the council by itself (same access rules as Hand to council), *Off* does nothing. |
| 10 | **One tool result floods the context**: a 500 KB test log, a recursive `ls`, a worker's report. | Output over the model's inline budget (30% of its context window, at most ~12.5k tokens; ~39k characters at 32k) is saved whole under `~/.localdex/spill/<session>/` and the model gets the start, the end and the file path. `read_file` stops at a line boundary with "continue at line N" instead. *Model experience:* the model sees head + tail + one notice line and can `read_file`/`grep` the saved file on demand; the saved file is read-only to the model and goes away with the session. Prompt caching is unaffected (results only shrink). Pattern borrowed from DeepSeek Harness `spill-policy` (reimplemented). |
| 11 | **Editing blind**: changing a file it never read, or overwriting an edit you made meanwhile in your editor. | `edit_file`, and `write_file` on an existing file, require a `read_file` of that file in the current context and refuse if the file changed since (`cannot modify "…": file has not been read — read the file, then retry` / `… file changed since it was read — re-read the file, then retry`). New files need no read. The records reset on Compact & Resume. Off switch: **Settings → Workspace → Files must be read before they are edited**. Pattern borrowed from DeepSeek Harness `fs-observation-policy` (reimplemented). |

Also useful on small machines: **Settings → Model & Agent → Context window → Reload in LM Studio** unloads the model and loads it again with a bigger context (LM Studio 0.4+). On 16 GB, 32k is a safe size for a 12B model.

Run the recovery tests (a mock LM Studio replays each failure above) with `npm run test:local -w server`.

### Edit tools per model

**Settings → Model & Agent → Edit tools for <model>**: some fine-tunes were trained on one specific way of editing files. Choose between `edit_file` + `write_file` (default), **`apply_patch`** (Codex-style `*** Begin Patch / *** Update File / @@ / -old / +new / *** End Patch`; context lines may differ in trailing spaces), or **`str_replace_editor`** (Claude-Code-style `view` / `create` / `str_replace` / `insert`). The model is shown exactly one style, and the system prompt matches it. All three go through the same file code, so read-before-edit, checkpoints with Undo and the Read only preset apply. Try the default first and switch if edits keep failing for that model.

### Model doctor

**Settings → Model & Agent → Run model doctor** checks how well the selected model works as an agent before you rely on it. It sends six scripted checks in each tool protocol (native and text): calls a tool, picks the right tool, keeps multi-line file content intact, makes an edit that actually lands, stays honest when a tool fails (doesn't invent an answer), and stops when the task is done. Then a short speed test (first-token time, tokens/s). Every check is one request with a made-up conversation, so nothing touches your files or runs a command.

The report shows a pass/fail grid, a verdict (good / usable / poor), and suggested settings with **Apply** buttons: tool call mode (native wins ties), Reasoning, and a context window that fits next to the model in your RAM (rule of thumb: 4-bit weights ≈ 0.55 GB per billion parameters; e.g. 16 GB + 12B → 32k). Reports are saved per model under `~/.localdex/doctor/` so you can compare models.

## Choosing a model

Agentic work depends almost entirely on how reliably the model calls tools and tells the truth
about results. Rough guidance for LM Studio:

- Best: instruction-tuned models with native tool support and the stock chat template, e.g.
  Qwen2.5-Coder / Qwen3 (14B+), Devstral, Llama 3.x 70B-class, GLM-4, Mistral Small.
- Load with at least 16k context; 32k+ is comfortable for multi-file work. Auto-compact will keep
  the conversation inside whatever you load.
- Uncensored/"heretic" fine-tunes often break the tool-calling template. LocalDex still works with
  them (see *When a small local model can't call tools* above), but expect more hallucinated results. The
  system prompt tells the model never to claim results it did not observe, and worker reports are
  annotated when a worker made no tool calls.
- LM Studio serves one request per loaded model at a time, so worker concurrency > 1 only helps
  when several models are loaded (set a separate *Worker model*).

## Project layout

```
shared/   TypeScript types shared by server and UI (messages, session, settings, WS protocol)
server/   Node + Hono + ws
  src/lmstudio.ts        OpenAI-compatible client, streaming, tool-mode probe, text-call parser
  src/tools/             tool implementations + approved-folder permission gate
  src/agent/loop.ts      the agent loop (stream → tools → repeat)
  src/agent/workers.ts   named workers with a concurrency semaphore
  src/agent/goal.ts      finish-checkpoint assessment
  src/agent/compact.ts   summarize → archive → reseed
  src/agent/runner.ts    per-session orchestration (corrections, goal controller, auto-compact)
  src/mcp/client.ts      MCP client: spawns stdio servers, exposes their tools, routes calls
web/      Vite + React + Tailwind UI
```

## Security notes

- The agent runs shell commands with your user privileges inside approved folders. Review what you
  approve; keep *Dangerous only* or *Always ask* for shell approval.
- Paths such as `~/.ssh`, `~/.aws`, `.env*` and key files are blocked even inside approved folders. The one
  exception is read-only: `read_file` and `grep` may read saved tool output under `~/.localdex/spill/` (nothing
  else in `~/.localdex`, and never for writes).
- Nothing is sent anywhere except your LM Studio server, plus whatever MCP servers you enable (a browser server
  makes web requests). Playwright MCP is not a security boundary; do not pass `--allow-unrestricted-file-access`.
- The Playwright server drives your installed Google Chrome (`--browser chrome`) with the sandbox on (`--sandbox`).
  Keep Chrome updated (`chrome://settings/help`). Don't switch it to `--browser chromium` or add `--no-sandbox`:
  Playwright's bundled Chromium can lag Chrome security fixes (Playwright 1.64.1 bundles 156.0.8078.4, without the
  fixes for CVE-2026-118306, -118331, -118344 and -118348). Older stock configs are upgraded automatically on start.

MIT. Not affiliated with LM Studio or the Chat On Steroids project.
