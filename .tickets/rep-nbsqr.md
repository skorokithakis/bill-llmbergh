---
id: rep-nbsqr
status: closed
deps: []
links: []
created: 2026-11-09T21:57:25Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Anthropic advisor on claude-fable-5-2

Ready for implementation.

Objective: the Anthropic advisor (ask_advisor with advisor "anthropic") uses claude-fable-5-2. The founder stays on claude-opus-5-5. pi-ai 1.2.0 (and every release up to 1.5.0) has no claude-fable-5-2 in its Anthropic catalog, so Models.getModel returns undefined for it today.

Scope:
- src/providers.ts: replace models.setProvider(anthropicProvider()) with our own provider built by createProvider, as ollamaCloudProvider does. Keep id "anthropic", name, baseUrl, and auth from the built-in anthropicProvider() (reuse builtin.auth so OAuth login and refresh are unchanged). api: anthropicMessagesApi() from @earendil-works/pi-ai/api/anthropic-messages.lazy. models: the built-in catalog plus one entry copied from the catalog's claude-fable-5-1 with id claude-fable-5-2, name "Claude Fable 5.2", cost { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 }. If the built-in catalog already lists claude-fable-5-2, do not add ours. If claude-fable-5-1 is missing, throw a clear error at startup (same style as the deepseek-flash check).
- config.example.json: models.advisorAnthropic.modelId -> claude-fable-5-2.
- AGENTS.md: Configuration section (advisors line) and Pi facts (founder line / note that we add claude-fable-5-2 to the anthropic provider ourselves because the 1.2.0 catalog lacks it).

Non-goals: pi-ai upgrade, fast mode, Mythos, a generic custom-model config mechanism, changes to founder or worker models.

Caveat: cache prices are a guess (Anthropic published only input/output: $8/$40 per M). Say so in a short code comment.

