# AI startup harness

This repository contains a harness that runs a company where every employee is an AI agent.
A human owner gives the company a server, a domain, and a small payment card.
The agents then pick a business and try to make money ethically.

This file is the specification. Read it fully before you change anything.

This is a small throwaway weekend project. Keep everything minimal. Do not build for
longevity, scale, or other users.

## Goal of the company

Make money ethically. The agents choose what the business is.

Tone: the README is cheeky because this is partly an art project. The agents are not. Every system prompt
must make the founder and workers treat the goal seriously: make money ethically, no jokes, no playing a
character, no winking at the premise.

Hard rules for every agent (put these in every system prompt):

- No stealing, cheating, spamming, deception, or impersonation.
- Obey the law and the terms of service of every platform you use.
- When you talk to a human outside the company, say that you are an AI.
- Do not try to get more access than the harness gives you.

## Architecture

There are two machines. The boundary between them is the main security control.

### 1. Harness container (trusted)

A Docker container that runs one long-lived Node process, the **supervisor**.
It holds all secrets, the harness storage, and the harness code.
Agents cannot write to this container. They have no tool that runs code here.

The supervisor is a thin layer over **Pi Durable** (`@earendil-works/pi-durable`), Pi's
durable agent runtime. Durable commits every message, model call, and tool call to SQLite
before it acts, so a restarted process continues where it stopped. Our code adds:

- The Telegram bot.
- The founder's supervisor tools (hire roles, spawn workers, ask advisors, and so on).
- The daily caps (cost, advisor calls).
- Registration of custom tools from stored definitions at startup.

### 2. Work VM (untrusted)

A remote VM. Agents have root on it. All agent shell commands and file operations run here.
The VM also hosts whatever the company builds (websites, APIs, and so on).

- The VM holds no harness secrets. It has no credentials to reach the harness container.
- The supervisor connects out to the VM over SSH. The VM never connects in.
- If the agents break the VM, the owner can rebuild it. The harness is not affected.

Tools reach the VM through **pi-env** (`@earendil-works/pi-env`). It is a small Rust
binary that the supervisor uploads to `~/.pi/mobile/tools/` on the VM, checked by SHA-256,
and starts per connection as `ssh <vm> pi-env serve`. It has no port and no secrets. It
runs file operations and commands and speaks a framed protocol on stdin and stdout.
`RemoteExecutionEnv` is the Durable `ExecutionEnv` that talks to it.

Caveat (verified in the spike): when the SSH connection drops (supervisor restart, network error), pi-env
kills commands that are still in flight. A process backgrounded with `&` whose spawning command already
returned survives. Anything long-running on the VM should still be a `systemd` unit (`systemd-run` or a unit
file) so it restarts on reboot and is visible with `systemctl`. Tell the founder this in its system prompt.
An interrupted tool call comes back to the model as an error result and is not rerun; prompts must tell
agents to check state before they retry.

Why this split: the founder can change its own tools and run any command, but every change
stays on the VM. It cannot change the harness code, its permissions, or the secrets.

## Agents

### Founder (one)

- The root Durable conversation. Long-lived. Durable compacts it when it gets long.
- Decides strategy, hires workers, spawns them, reads results, talks to the owner.
- Model: DeepSeek served by Ollama Cloud (the owner's key is an Ollama Cloud key). Configurable.
- Input arrives as Durable submissions with a `requestId`, so a restart never delivers the same event twice:
  - `owner_message` from Telegram.
  - `worker_finished` when a worker ends (result, failure, or stop).
  - `heartbeat` when the founder has been idle for the configured interval, so it continues its own work.
- Submissions while the founder is busy queue as follow-ups (Durable's default).
- On restart, the supervisor reopens the same storage and calls `harness.resume()`.

### Workers (many, short-lived)

- The founder "hires" a **role**: a name, specialised instructions, and a model. Examples: developer, designer, marketer.
- The founder spawns a worker from a role with a task. The spawn returns at once with a worker ID (asynchronous).
- A worker is a Durable conversation owned by a background anchor task, as in Durable's example
  `23-subagent-background.ts`. Its final assistant message is its result, which a reporter task submits
  to the founder as `worker_finished`.
- Workers cannot spawn workers, ask advisors, or message the owner. If a worker needs something, it finishes and says so in its result.
- Maximum number of workers that run at the same time: configurable.

### Advisors (two, expensive)

- One on Anthropic, one on OpenAI. Each has a fixed system prompt that frames it as a senior advisor.
- Authentication: the owner's Claude and ChatGPT subscriptions through pi-ai OAuth. The owner logs in once locally
  (`npx @earendil-works/pi-ai login anthropic` and `login openai`) and copies `auth.json` to `/data/auth.json`.
  The supervisor uses a file-backed `CredentialStore` on that path so refreshed tokens persist. Anthropic bills
  third-party OAuth use as "extra usage" at API rates (checked 2026-10-13); accepted.
- Not a conversation. `ask_advisor` is a tool that makes one model call through `api.models`. One question, one answer. No tools, no memory.
- Only the founder can ask them. The founder must give all necessary context in the question.
- A configurable maximum number of calls per day, enforced in code.

## Tools

### Run on the work VM

Durable's built-in `read`, `write`, `edit`, and `bash` (`CodingTools`), with `RemoteExecutionEnv` as the environment.
Custom tools (below) also run here.

### Run in the supervisor (fixed, agents cannot change them)

Founder only:

- `hire_role(name, instructions, model)`, `update_role(...)`, `fire_role(name)`.
- `spawn_worker(role, task) -> worker_id`.
- `list_workers()`, `message_worker(worker_id, text)` (steer), `stop_worker(worker_id)`.
- `read_worker_transcript(worker_id)`.
- `ask_advisor(advisor, question)`.
- `message_owner(text)`: sends a Telegram message to the owner.
- `define_tool(...)`, `update_tool(...)`, `delete_tool(name)`.

Founder and workers (can be turned on per role):

- `get_payment_card()`: returns the card details. Every call sends a Telegram notice to the owner.

### Custom tools (self-improvement)

The founder can create and edit its own tools with `define_tool(name, description, parameters_schema, command, roles)`.

- `command` is a shell command that runs **on the work VM** through `env.exec`. Arguments go to it as JSON on stdin. Stdout is the result.
- The supervisor registers custom tools at startup for the founder and the listed roles. A change takes effect at the next registry install (Durable's `registry.install()` replaces an extension in place).
- A custom tool cannot use a name of a built-in or supervisor tool.

This gives the founder better tools without more permissions, because a custom tool can only do what `bash` on the VM can already do.

## Data

### Harness storage (Durable SQLite, in the container)

One SQLite file opened with `openNodeSqliteStorage`. Durable stores every conversation transcript (this is the
message log), tasks, inbox, and per-conversation usage and cost in it.

Our own state lives in Durable documents (`defineDoc`) on the founder's conversation:

- Roles.
- Custom tool definitions.
- Worker registry (worker ID to conversation ID, status, result).
- Daily counters: advisor calls today, cost at the start of today.

Rejected: a second SQLite or JSON file for our state. One store, one set of commits.

### Company workspace (SQLite, on the work VM)

The company's memory: goals, decisions, tasks, notes, customers, whatever the agents need.
The agents own it fully and use it through `sqlite3` with `bash`. They design the schema themselves.
Suggested location: `/company/company.db`. Tell the founder about it in its system prompt, and tell it to use FTS5 for search.

## Telegram

- One bot, long polling with `fetch`. No library.
- It accepts a message only when `message.from.id` is the owner's Telegram user ID (config) **and** the chat is the
  owner's private chat with the bot (`message.chat.id` equals the same ID). Ignore everything else silently: other
  users, group chats, channel posts, edited messages. All outbound messages go to that private chat only.
- Messages from the owner become `owner_message` submissions for the founder.
- Commands that the supervisor handles directly (not the founder):
  - `/stop`: abort all work (`root.abort(context, { background: true })`) and stop scheduling until `/resume`. The kill switch.
  - `/resume`: start again.
  - `/status`: running workers, today's cost, advisor calls today.

## Daily cost cap

The supervisor checks `harness.usage()` after each commit (or on a timer). When today's cost passes the configured
cap, it does what `/stop` does and sends the owner a Telegram message. `/resume` starts again.

## Configuration

One JSON config file plus environment variables for secrets. It includes:

- Models: founder and default worker (`deepseek-v4.1-flash` on Ollama Cloud), advisors `claude-opus-5-5` (Anthropic) and `gpt-6.1-sol` (OpenAI).
- Heartbeat interval, maximum parallel workers, advisor calls per day, daily cost cap.
- Work VM SSH host and user. The key and the `known_hosts` file are at fixed paths under `/data/ssh/`.
- Telegram owner user ID.
- Card details (from environment).

Secrets from environment: `OLLAMA_API_KEY`, Telegram bot token, card details. Advisor OAuth credentials are in `/data/auth.json`.

## Stack

- TypeScript on Node 22.19 or newer.
- `@earendil-works/pi-durable`, `@earendil-works/pi-env`, `@earendil-works/pi-ai`, `@earendil-works/chord`, all pinned to 1.2.0.
- Docker Compose for the harness container, deployed with Harbormaster (https://harbormaster.readthedocs.io/en/latest/llms.txt).
- Keep dependencies few. Prefer Node built-ins.

## Deployment (Harbormaster)

Harbormaster clones this repository and runs `docker compose up --build` on it. Rules for the Compose file:

- One service, built from the `Dockerfile` in the repository. No `container_name`.
- Plain named volumes only. Harbormaster backs a volume named `data` with a host directory it keeps forever.
  A volume whose name starts with `cache-` is backed by a directory it may delete. We have no cache-only data,
  so one volume: `data:/data`. The SQLite storage, the pi-env `known_hosts` file, and the SSH private key live there.
- The owner copies the SSH private key to `data/<app>/data/ssh/id_ed25519` by hand before the first run. A multi-line
  key does not fit Harbormaster's `key=value` environment file.
- Secrets are environment variables, listed by name only in the Compose file (`- DEEPSEEK_API_KEY`), so that
  Harbormaster's `environment_file` supplies them.
- The non-secret config (`config.json`) is committed to the repository.
- `harbormaster test` in the repository root must start the app.

## Non-goals (do not build these)

- Email (sending or receiving). The founder asks the owner by Telegram if something must be sent.
- DNS tools. The owner points a wildcard record at the VM by hand.
- A web user interface. Telegram and the SQLite file are enough.
- More than one founder.
- Workers that spawn workers, or workers that run all the time.
- Human approval steps for actions. The owner gets notices and has `/stop`.
- A budget system beyond the daily cost cap.
- Any way for agents to change harness code, harness config, secrets, or permissions.
- Tests beyond what the spike needs. This is a weekend project.

## Pi facts (checked on 2026-10-13)

- Repository: https://github.com/earendil-works/pi. Durable docs: `packages/durable/README.md`. pi-env docs: `packages/env/README.md`, `docs/protocol.md`, `docs/semantics.md`.
- Durable is marked **Experimental**. First published 2026-09-19. Breaking changes in 1.1.0 (2026-10-07) and 1.2.0 (2026-10-12). We pin 1.2.0 and accept this.
- `Harness.open(storage, { models, registry, env, settings }, context)`. Every async call takes a Chord `Context`; `BACKGROUND_CONTEXT` never cancels.
- `harness.root(context, { agent })` is the founder's conversation. `conversation.submit({ type: "input", content, requestId })` is idempotent by `requestId`.
- Busy conversation: `whenBusy: "steer"` enters after the current tool round; the default (follow-up) starts the next run.
- Tools: `defineTool({ name, description, parameters (TypeBox), execute(args, api, context), replay? })`, bundled in `defineExtension({ name, tools, sections, hooks })`, installed with `registry.install()`. Tools run in the container. `api.executeTool("bash", ...)` or the `ExecutionEnv` reaches the VM.
- `hook(ToolTask, { beforeTool })` can block a call: use it for the advisor and worker caps.
- `harness.usage(context)` returns tokens and cost per `provider/model`.
- `watchEvents(harness, conversationId, context)` gives coding-agent style events, if we need live logs.
- `pi-ai` has DeepSeek, Anthropic, and OpenAI built in, but the owner's key is for Ollama Cloud (`https://ollama.com/v1`), so the founder's provider is `createProvider()` with that `baseUrl`, model id `deepseek-v4.1-flash`, `compat.supportsDeveloperRole: false`, and the DeepSeek pricing copied from the `deepseek-flash` catalog entry so cost is reported. Pitfall: a catalog model carries its own `baseUrl`, which overrides the provider's; set it on the model object too.
- `env.exec()` returns `{ exitCode, spillPath? }`; output arrives through `options.onOutput`.
- Inside a task, `runtime.entry()` sees only the task's own conversation; read another conversation's entries with `tx.entry()` inside a commit.
- Durable's example 23 is slightly stale against the 1.2.0 types: tool results are `{ output }`, not `{ content }`.
- `harness.resume()` is synchronous and takes no context.
- The first VM operation pays for platform detection and daemon upload. Warm the connection at startup.
- The coding-agent SDK (`createAgentSession`) was the rejected alternative. Its tools accept SSH `operations`, but we would have to write durable workers, the inbox, and cost totals ourselves.

## Project status

- Phase: spec approved by the owner on 2026-10-13. Spike passed (see `spike/RESULTS.md` until the core ticket deletes it). Implementation runs through `tk` tickets (`tk ready`).
- The owner has the VM, the domain, and the card, and sets up the Telegram bot token, user ID, and SSH key by hand.
- The first ticket is a spike that proves (1) founder plus one background worker on DeepSeek with tools on the VM, (2) crash resume mid-worker, (3) `nohup` dies on disconnect and `systemd` survives, (4) the log and cost are readable from the SQLite file. If it fails, fall back to the SDK and re-plan.
