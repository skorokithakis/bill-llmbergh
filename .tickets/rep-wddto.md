---
id: rep-wddto
status: closed
deps: []
links: []
created: 2026-10-18T00:18:11Z
type: feature
priority: 2
assignee: Stavros Korokithakis
---
# Web search and fetch tools (Ollama)

Ready for implementation.

Objective: give the founder and every worker two supervisor tools, web_search and web_fetch, backed by Ollama's web API with the existing OLLAMA_API_KEY (secrets.ollamaApiKey). Today agents can curl known URLs from the VM but cannot search.

API (https://docs.ollama.com/capabilities/web-search):
- POST https://ollama.com/api/web_search, body {query, max_results?} (default 5, max 10) -> {results:[{title,url,content}]}
- POST https://ollama.com/api/web_fetch, body {url} -> {title, content, links[]}
- Header Authorization: Bearer <key>, Content-Type: application/json.

Scope:
- New src/web.ts: createWebExtension(apiKey) returning one extension named "web" with both tools. Use Node fetch, pass the Chord context's abort signal if there is an easy way (see how ask_advisor handles cancellation in money.ts).
- main.ts: install it in the registry; add it to the founder's extensions list.
- workers.ts: add it to both worker extension lists in spawn_worker (pass it in through WorkerToolOptions like paymentCardExtension).
- prompt.ts: one line describing both tools in a section both prompts share (founder and worker). Mention results are cut to a fixed size.
- AGENTS.md: add the two tools under 'Run in the supervisor' as founder-and-worker tools.

Constraints:
- The key stays in the container. Never put it on the VM or in a tool result.
- Cut each tool's text output to a fixed maximum (around 20000 characters) and say in the output when it was cut.
- Non-2xx responses and network errors return an error tool result with the status and a short body excerpt; do not throw.
- Read-only, so no Telegram notice and no daily counter. custom_tools.ts already reserves every registered tool name, so no change there.

Non-goals: DeepSeek backend, per-role toggle, caching, rate limiting, counting toward the daily cost cap, tests.

