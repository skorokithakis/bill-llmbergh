---
id: rep-uinue
status: closed
deps: []
links: []
created: 2026-10-13T19:43:03Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Heartbeat 6 hours and founder wake-up tools

Objective: the founder runs less often and can schedule its own one-shot wake-ups.

1. Interval: config.example.json heartbeatIntervalMinutes 30 -> 360. README: 'every thirty minutes' -> 'every six hours'. The live /data/config.json is changed by the owner by hand; do not touch it.

2. New src/wakeups.ts, founder-only tools registered alongside the other supervisor tools (see supervisor.ts, money.ts for the defineTool/defineDoc pattern):
   - WakeupsDoc: defineDoc on the root conversation (kind app.wakeups, scope conversation, history latest), state { wakeups: Record<id, { dueAt: ISO string, note: string, createdAt: ISO string }> }.
   - schedule_wakeup(delay_minutes: positive number, note: string) -> id. One-shot only. No cap on delay.
   - list_wakeups() -> pending wake-ups with id, due time, note.
   - cancel_wakeup(id).
   - fireDueWakeups(harness, root, context): for each entry with dueAt <= now, root.submit({ type: 'input', content: 'Scheduled wake-up (set by you): <note>', requestId: 'wakeup:<id>' }) then remove the entry in a commit. Submit before remove: the requestId makes a crash between the two harmless.
   - The existing 60 s tick in heartbeat.ts calls fireDueWakeups after the isStopped check and before the idle check. Wake-ups do not fire while /stop is set; they fire once after /resume.

3. FOUNDER_PROMPT in prompt.ts: add a short 'When you run' paragraph. The harness starts a run when the owner writes, when a worker finishes, when a scheduled wake-up is due, and otherwise with the input 'heartbeat' after about six idle hours. Every run costs money. If nothing useful can be done before a known time (a deploy to check, a reply to wait for, metrics to read tomorrow), call schedule_wakeup with a note that says what to do, then end the turn. Do not poll or busy-wait. Document the three tools in the tools list in the same style as the others.

Non-goals: recurring schedules, cron on the VM, a cap on delay or count, worker access to these tools, changing the heartbeat mechanism itself.

Caveats: supervisor tools use the api.snapshot / api.commit + tx.doc pattern (see money.ts bumpCounters). Use ROOT_CONVERSATION_ID for the doc. Keep the wake-up content short; the note is the founder's own text.

## Acceptance Criteria

npm run typecheck passes. A scheduled wake-up fires once within a minute of its due time, including after a restart. A wake-up due during /stop fires after /resume. heartbeat still fires after the configured idle interval.


## Notes

**2026-10-13T19:44:26Z**

Approved by the owner 2026-10-13. ready for implementation
