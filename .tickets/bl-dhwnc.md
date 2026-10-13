---
id: bl-dhwnc
status: open
deps: [bl-hhzcz]
links: []
created: 2026-10-13T13:23:00Z
type: task
priority: 1
assignee: Stavros Korokithakis
---
# Workers: roles and the spawn/list/message/stop/transcript tools

Objective: the founder hires roles and runs background workers, as in AGENTS.md 'Workers'.

Scope: Durable documents on the root conversation: Roles { name -> { instructions, model, tools: { payment_card: boolean } } } and Workers { id -> { role, task, conversationId, status, result?, startedAt, endedAt } }. Founder-only tools in the supervisor extension: hire_role, update_role, fire_role, spawn_worker(role, task) -> worker_id, list_workers, message_worker(worker_id, text) (submit with whenBusy: 'steer'), stop_worker (abort the worker conversation), read_worker_transcript (entries as role: text, truncated to a sane size). Worker conversation: owned by a background anchor task, model from the role, extensions = CodingTools + a 'worker' extension with the hard rules and the role instructions as sections; no supervisor tools. A reporter task waits for the worker's answer and submits 'worker_finished' to the root with requestId worker:<id>:<entryId>; status, result, and endedAt go into the Workers doc. Enforce max parallel workers in spawn_worker (return an error result). Follow Durable's 23-subagent-background.ts pattern; it already handles restart safety.

Non-goals: worker-to-worker messaging, workers spawning workers, persistent workers, custom tools (next ticket).
Caveats: a worker's conversation must not select the supervisor extension. Verify with conversation.agent().

ready for implementation

## Acceptance Criteria

Founder hires a role, spawns two workers, both run bash on the VM, both results arrive as worker_finished. A third spawn beyond the limit is refused. Kill and restart mid-worker: the worker still reports. /status lists running workers by id and role.

