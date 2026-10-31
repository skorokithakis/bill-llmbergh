---
id: rep-cjeld
status: closed
deps: []
links: []
created: 2026-10-31T08:55:39Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Founder on Claude Opus 5.5 via Anthropic OAuth

Ready for implementation.

Objective: the founder (Bill) runs on anthropic/claude-opus-5-5 through the existing Anthropic OAuth login (/data/auth.json), same as the Anthropic advisor. Workers stay on deepseek/deepseek-v4.1-flash via Ollama Cloud.

Scope:
- src/providers.ts: the Ollama Cloud 'deepseek' provider registers its model id from config.models.defaultWorker.modelId, not config.models.founder.modelId. Otherwise moving the founder off DeepSeek drops the worker model. Update the comments in providers.ts and config.ts that assume the founder is on DeepSeek.
- config.example.json: models.founder = { provider: anthropic, modelId: claude-opus-5-5 }; dailyCostCapUsd = 50.
- AGENTS.md: founder model line (Agents > Founder) and Configuration section say Opus 5.5 via Anthropic OAuth; workers stay on DeepSeek via Ollama Cloud.
- Check that pi-ai 1.2.0's Anthropic catalog has pricing for claude-opus-5-5, so harness.usage reports cost and the daily cap works. Report the per-million-token prices. If no pricing exists, stop and report; do not invent prices.

Non-goals: no change to workers, advisors, prompts, or role model selection. No new config fields.

## Acceptance Criteria

Typecheck passes. With founder on anthropic and defaultWorker on deepseek, both models resolve through createCompanyModels.

