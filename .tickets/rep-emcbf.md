---
id: rep-emcbf
status: closed
deps: []
links: []
created: 2026-10-13T16:32:57Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Owner messages steer the founder and report unanswered runs

Objective: the owner's Telegram messages reach the founder promptly and never vanish silently.

Scope: src/telegram.ts, handleUpdate() only.

Changes:
1. Submit owner messages with whenBusy: "steer" so the founder sees them after its current tool round instead of after the whole run (today they queue as follow-ups behind long runs).
2. After root.submit() returns, wait for the submission in the background (submission.wait(context), not awaited by the poll loop). If the settlement has status "unanswered", call sendToOwner with a short notice that includes the reason and detail (e.g. 'The founder did not answer your message: <reason> <detail>'). A rejected wait must not crash the process: catch it and console.error it. The poll loop must not block on this wait.

Non-goals: retries of failed runs; changes to /stop, /resume, /status; forwarding the founder's assistant text; changes to the heartbeat or worker_finished submissions.

Caveats: the background wait is lost on restart; that is accepted. Keep the requestId tg:<update_id> as is. Run npx tsc --noEmit (or the repo's check command) to validate.

ready for implementation

## Design

Submission.wait() settles as { status: 'done', answer } or { status: 'unanswered', reason, detail? }. Durable does not pass a failed founder run to onReport, which is why the notice must come from this wait.

