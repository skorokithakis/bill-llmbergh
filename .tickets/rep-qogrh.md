---
id: rep-qogrh
status: open
deps: []
links: []
created: 2026-11-09T22:05:35Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Drop local claude-fable-5-2 entry after pi upgrade

Ready for implementation, but only when a pi-ai release lists claude-fable-5-2 in its Anthropic catalog AND sends a Claude Code version >= 2.1.290 on OAuth (see earendil-works/pi#11969). Do not start before that release exists.

Objective: remove our temporary workaround in src/providers.ts (anthropicAdvisorProvider, the copied claude-fable-5-2 entry and its user-agent header) and go back to models.setProvider(anthropicProvider()). Upgrade @earendil-works/pi-durable, pi-env, pi-ai, chord together to that release (they are pinned to the same version). Update the pin and the 'Pi facts' notes in AGENTS.md.

Caveat: Durable is experimental and has had breaking changes between minor versions; fix any type or behaviour breaks from the upgrade. config.example.json keeps claude-fable-5-2.

Non-goals: other model or config changes.

