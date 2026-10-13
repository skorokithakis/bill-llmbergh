---
id: bl-rkqlb
status: open
deps: [bl-hhzcz]
links: []
created: 2026-10-13T13:23:00Z
type: task
priority: 1
assignee: Stavros Korokithakis
---
# Telegram: owner-only bot, owner_message in, message_owner out, /stop /resume /status

Objective: the owner talks to the founder over Telegram, and the supervisor obeys three commands.

Scope: src/telegram.ts using fetch and getUpdates long polling, no library. Accept an update only if message.from.id === owner user id AND message.chat.id === owner user id; drop everything else silently (other users, groups, edited messages, channel posts). Persist the last update offset in a Durable document or a small file in /data so a restart does not replay messages. Owner text -> root.submit({ type: 'input', content, requestId: 'tg:<update_id>' }), prefixed so the founder knows it is the owner. Tool message_owner(text) in the supervisor extension (founder only) sends to the owner chat. Commands handled by the supervisor, not the founder: /stop = root.abort(context, { background: true }) and a 'stopped' flag that blocks new submissions and the heartbeat until /resume; /resume clears it; /status replies with running workers (count for now; the workers ticket fills in names), today's cost, advisor calls today (0 until the caps ticket). Keep a sendToOwner(text) function that other tickets reuse (card notice, cost cap).

Non-goals: inline keyboards, markdown formatting beyond plain text, any other chat.
Caveats: Telegram messages are limited to 4096 chars; split long outputs.

ready for implementation

## Acceptance Criteria

Messages from a different Telegram account get no reply and do not reach the founder. The owner's message produces a founder reply via message_owner. /stop halts a running worker and the heartbeat; /resume brings them back; /status shows cost.

