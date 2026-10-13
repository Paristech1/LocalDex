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
  Loop mode keeps working within a brief indefinitely.
- **Compact & Resume** – manual or automatic (at a configurable fraction of the context window):
  the model summarizes decisions, files changed, open items and worker state, and a fresh context
  is seeded with the summary. The full transcript is archived in the session file.
- **Works with models that have no native tool support** – LocalDex probes the model once; if it
  does not emit OpenAI `tool_calls`, it switches to a text protocol and parses calls from the reply.
  It also recovers Python-style calls (`write_file(path="a", content="b")`), fenced JSON, and
  common hallucinated tool names (`create_file` → `write_file`).

## Requirements

- Node.js 20+ (tested on 24)
- LM Studio with the local server running (`lms server start` or Developer → Start Server)
- A chat model loaded (or JIT loading enabled). See *Choosing a model* below.

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

## Using it

| Panel | What it does |
| --- | --- |
| **Chat** | Streaming replies, reasoning (collapsible), tool cards, approval and question prompts. Send while running = correction. |
| **Plan** | Checklist maintained by the model with `update_plan`. |
| **Workers** | Status, last task, live stream and full transcript per worker. Reset or delete a worker's memory. |
| **Goal** | Start a Goal (until done) or a Loop (keep working). Shows iteration, last checkpoint, remaining items. |
| **Context** | Token usage vs. context window, compactions, "Compact & Resume now", latest summary. |
| **Log** | Server events: tool-mode detection, recovered tool calls, goal checkpoints, errors. |

Keyboard: `Enter` send, `Shift+Enter` newline, `Cmd/Ctrl+,` settings, `Esc` close.

## Settings

- **Workspace** – approved folders (first one is the default cwd), shell approval mode.
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

## Skills

A skill is a folder with a `SKILL.md` (frontmatter `name` + `description`, then instructions) plus any files it needs. Skills live in `~/.localdex/skills/<name>/`.

Add one in **Settings → Skills**:

- **Drag and drop** a skill folder, a `SKILL.md`, any `.md` file, or a `.zip` (several at once is fine).
- **Paste a GitHub link**: `https://github.com/owner/repo` imports every skill in the repo; a `/tree/<branch>/<folder>` or `/blob/.../SKILL.md` link imports just that one. Public repos only.

Only each skill's name and one-line description go into the system prompt. The model calls `load_skill` to read the full text (and `load_skill` with `file` for bundled files). Toggle or remove skills in the same tab. Skills that bundle scripts get a badge; scripts only run if the model calls `shell_run`, so your shell-approval setting still applies.

## MCP servers (extra tools)

LocalDex is an [MCP](https://modelcontextprotocol.io) client. Any stdio MCP server can add tools; the first one
configured is [Playwright MCP](https://github.com/microsoft/playwright-mcp) for browsing (off by default).

1. Open **Settings → MCP Servers** and switch **playwright** on (needs Node 20+; the first start downloads the server via `npx`).
2. Ask the agent to open a page. The first call to a server asks for approval once; approving allows that
   server's exposed tools until LocalDex restarts.

Server definitions live in `~/.localdex/config.json` under `mcpServers`. They can only be edited in that file
(restart LocalDex after editing); the UI and WebSocket can only toggle `enabled`, because a server command runs a
program on your machine.

```json
"mcpServers": {
  "playwright": {
    "command": "npx",
    "args": ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
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
  - Plain messages are routed automatically (keyword rules, or the local model if you pick that).
- **Solo mode**: your local model leads. It can call `ask_member` and `council` itself when a task is too big for it, so the work tag-teams.

**Routing and fallback.** Each role (planner, builder, reviewer, researcher, quick) has an ordered list of members. A member that is off, signed out, or at its usage limit is skipped. When a member hits a limit mid-run, the next one takes over, and the first one cools down until its reset time.

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
- **Approved folders only.** Members start in your first approved folder, and the other approved folders are passed as extra directories.
- **Executables come from config only.** Member programs are found on `PATH`, or set with `council.members.<name>.command` in `~/.localdex/config.json`. That setting cannot be changed from the UI.

The task, and any files a member reads, go to that vendor. Every message written by the council is marked with ☁ in the chat, and the **Council** tab in the right panel shows each run step by step: who did what, live output, tool calls, timing and tokens.

## Choosing a model

Agentic work depends almost entirely on how reliably the model calls tools and tells the truth
about results. Rough guidance for LM Studio:

- Best: instruction-tuned models with native tool support and the stock chat template, e.g.
  Qwen2.5-Coder / Qwen3 (14B+), Devstral, Llama 3.x 70B-class, GLM-4, Mistral Small.
- Load with at least 16k context; 32k+ is comfortable for multi-file work. Auto-compact will keep
  the conversation inside whatever you load.
- Uncensored/"heretic" fine-tunes often break the tool-calling template. LocalDex still works with
  them through the text protocol and call recovery, but expect more hallucinated results. The
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
- Paths such as `~/.ssh`, `~/.aws`, `.env*` and key files are blocked even inside approved folders.
- Nothing is sent anywhere except your LM Studio server, plus whatever MCP servers you enable (a browser server
  makes web requests). Playwright MCP is not a security boundary; do not pass `--allow-unrestricted-file-access`.

MIT. Not affiliated with LM Studio or the Chat On Steroids project.
