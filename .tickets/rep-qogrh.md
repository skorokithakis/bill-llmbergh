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
# Drop Anthropic advisor user-agent override after pi upgrade

Ready for implementation, but only when a pi-ai release sends a Claude Code version >= 2.1.290 on the Anthropic OAuth path (see earendil-works/pi#11969). Do not start before that release exists.

Objective: remove the per-call `user-agent: claude-cli/2.1.321` header from ask_advisor in src/money.ts. The local claude-fable-5-2 model entry was already removed in the 1.5.1 upgrade (rep-psytc). Upgrade @earendil-works/pi-durable, pi-env, pi-ai, chord, pi-schema together to that release. Update the pin and the 'Pi facts' notes in AGENTS.md.

Caveat: Durable is experimental and has had breaking changes between minor versions; fix any type or behaviour breaks from the upgrade.

Non-goals: other model or config changes.
