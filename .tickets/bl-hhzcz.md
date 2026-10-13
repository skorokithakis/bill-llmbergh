---
id: bl-hhzcz
status: open
deps: [bl-fjczd]
links: []
created: 2026-10-13T13:23:00Z
type: task
priority: 1
assignee: Stavros Korokithakis
---
# Supervisor core: config, storage, providers, remote env, founder, heartbeat

Objective: the harness skeleton that starts, opens storage at /data/harness.sqlite, connects to the VM, and runs the founder conversation with heartbeats and resume. Based on what the spike learned; copy from spike/ freely, then delete spike/ at the end of this ticket.

Scope: src/ with an entry point (src/main.ts). Config: config.json (non-secret, committed: models for founder/default worker/two advisors, heartbeat interval, max parallel workers, advisor calls per day, daily cost cap USD, VM ssh host and user, Telegram owner user id) plus env vars for secrets (DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, TELEGRAM_BOT_TOKEN, CARD_NUMBER, CARD_EXPIRY, CARD_CVC, CARD_NAME). Fail fast at startup on a missing value. SSH key at /data/ssh/id_ed25519, known_hosts at /data/ssh/known_hosts (accept-new on first connect is fine for this project). Providers: deepseek, anthropic, openai built in; Ollama cloud optional via createProvider only if under ~15 lines, else skip. Registry with CodingTools and an empty 'supervisor' extension that later tickets fill. Founder = harness.root with a system prompt section: the four hard rules from AGENTS.md, the company db at /company/company.db with FTS5, the systemd caveat, and a short description of its tools. harness.resume() on start. Heartbeat: when the root conversation has been idle for the configured interval, submit an input 'heartbeat' with requestId heartbeat:<iso minute>. Graceful shutdown on SIGTERM (harness.close).

Also: Dockerfile (node:22 image, npm ci, build or strip-types run) and compose.yml per AGENTS.md 'Deployment': one service, no container_name, volume data:/data, secrets listed by name only. A .env.example with the names.

Non-goals: Telegram, tools beyond CodingTools, workers, caps. Tests.
Caveats: keep it small; one file per concern (config, providers, remote env, founder prompt, main) is enough.

ready for implementation

## Acceptance Criteria

node starts the supervisor, connects to the VM, resumes, and a manual submit to root (temporary debug hook or a one-off script) runs bash on the VM. docker compose up --build works with a populated .env. harbormaster test starts the app.


## Notes

**2026-10-13T13:46:25Z**

Spike passed; see spike/RESULTS.md and the updated 'Pi facts' in AGENTS.md. Changes vs the ticket text: (1) secret is OLLAMA_API_KEY, not DEEPSEEK_API_KEY; provider via createProvider with baseUrl https://ollama.com/v1, model deepseek-v4.1-flash, override baseUrl on the model object, copy DeepSeek pricing so cost is reported. (2) No ANTHROPIC_API_KEY / OPENAI_API_KEY: advisors use OAuth from /data/auth.json; the core ticket only needs to create the Models with a file-backed CredentialStore on /data/auth.json and register anthropicProvider() and openaiProvider(); the advisor ticket uses them. (3) Founder prompt: systemd advice with the corrected reason, and 'an interrupted tool call is not rerun; check state before retrying'. (4) Delete spike/ at the end of this ticket (keep nothing from it except code you copy into src/).
