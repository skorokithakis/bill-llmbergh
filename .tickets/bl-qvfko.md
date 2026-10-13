---
id: bl-qvfko
status: closed
deps: [bl-rkqlb, bl-dhwnc]
links: []
created: 2026-10-13T13:23:00Z
type: task
priority: 1
assignee: Stavros Korokithakis
---
# Advisors, daily caps, cost cap, payment card

Objective: the expensive and dangerous tools, each with its guard.

Scope:
- ask_advisor(advisor: 'anthropic' | 'openai', question): founder only. One model call via api.models with a fixed senior-advisor system prompt; no tools, no history. Count calls per UTC day in a Counters document on the root; refuse with an error result when the configured daily maximum is reached. Add the call's usage to the result so it shows in pi.usage.
- Daily cost cap: Counters stores { day, costAtDayStart }. On a 60 s timer, read harness.usage(), compute today's cost, and when it exceeds the configured cap do what /stop does and sendToOwner a notice. /resume continues (and the cap check resumes; if still over, it stops again, which is fine).
- get_payment_card(): available to the founder and to workers whose role has tools.payment_card true. Returns the card fields from env. Every call sendToOwner('Card details were read by <founder|worker id/role>').
- /status includes advisor calls today.

Non-goals: per-model budgets, approvals, a payments API.
Caveats: use a beforeTool hook or a check at the top of execute, whichever is shorter. Do not log the card number into the transcript beyond the tool result itself (that is unavoidable and accepted).

ready for implementation

## Acceptance Criteria

The (max+1)th advisor call in a day is refused. With the cap set to a tiny value, the supervisor stops and the owner gets a Telegram notice; /resume works. A card read by a worker produces a notice naming the worker.


## Notes

**2026-10-13T13:44:44Z**

Advisors authenticate with pi-ai OAuth (Claude Pro/Max login and Sign in with ChatGPT), not API keys. Owner runs 'npx @earendil-works/pi-ai login anthropic' and 'login openai' locally and copies auth.json to /data/auth.json. Use a file-backed CredentialStore on that path so token refreshes are written back. Anthropic bills this as extra usage at API rates; that is accepted. Model ids: TBD by owner.
