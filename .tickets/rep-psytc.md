---
id: rep-psytc
status: closed
deps: []
links: []
created: 2026-11-10T02:01:26Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Upgrade pi packages to 1.5.1 and drop local Fable 5.2 model entry

Ready for implementation.

Objective: upgrade @earendil-works/pi-durable, pi-env, pi-ai, chord together to 1.5.1 (exact pins), and remove our temporary claude-fable-5-2 workaround now that the 1.5.1 Anthropic catalog has the model.

Scope:
- package.json / package-lock.json: pins to 1.5.1. Add @earendil-works/pi-schema pinned at 1.5.1 as a direct dependency.
- src/providers.ts: delete anthropicAdvisorProvider, advisorModel, ANTHROPIC_ADVISOR_MODEL_ID and now-unused imports; go back to models.setProvider(anthropicProvider()).
- src/money.ts (ask_advisor): pi-ai 1.5.1 still sends user-agent claude-cli/2.1.280 on the Anthropic OAuth path, and Anthropic rejects Fable 5.2 below 2.1.290 (earendil-works/pi#11969). Pass headers: { 'user-agent': 'claude-cli/2.1.321' } in the completeSimple options, ONLY when the advisor is anthropic. Per-call options headers override pi-ai's defaults. Add a short comment saying why and that it goes once pi-ai sends >= 2.1.290.
- pi-ai 1.5.x no longer exports Type (TypeBox). Migrate every Type.* schema (custom_tools.ts, money.ts, supervisor.ts, wakeups.ts, web.ts, workers.ts) to @earendil-works/pi-schema builders (obj, str, num, int, bool, arr, union, opt, etc.). See Durable 1.5.0 changelog for the mapping. Keep descriptions and constraints. obj is closed by default; that is accepted. custom_tools.ts takes a stored JSON Schema for user-defined tools: type it as pi-schema's Schema/plain JSON Schema instead of TSchema.
- Fix any other type breaks from 1.2.0 -> 1.5.1 (changelogs: Durable, chord, pi-env 1.3.0-1.5.1). Expected to be few.

Non-goals: config changes, model changes, adopting new Durable features, AGENTS.md or knowledge-base edits (architect does those), typebox as a direct dependency.

## Acceptance Criteria

npm run typecheck passes. No Type import from pi-ai remains. providers.ts registers the stock anthropicProvider(). Only the Anthropic advisor call sends the overridden user-agent.

