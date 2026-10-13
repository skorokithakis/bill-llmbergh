---
id: bl-fjczd
status: open
deps: []
links: []
created: 2026-10-13T13:23:00Z
type: task
priority: 0
assignee: Stavros Korokithakis
---
# Spike: Pi Durable + pi-env on DeepSeek with a remote VM

Objective: prove the runtime choice before any harness code. Throwaway script in spike/ (one TS file, run with node --experimental-strip-types). Not production code; no config system, no Telegram.

Scope: npm project with @earendil-works/pi-durable, pi-env, pi-ai, chord pinned to 1.2.0. Harness.open on SQLite storage. env: RemoteExecutionEnv over sshConnection to the VM (host/user from env vars, key and known_hosts paths from env vars; scanHostKey/acceptHostKey once). CodingTools installed. Root conversation on DeepSeek. One 'subagent' tool modelled on packages/durable/test/examples/23-subagent-background.ts (background anchor task + reporter task), trimmed to spawn + report back.

Prove, and write the results in spike/RESULTS.md:
1. Root prompt makes the founder spawn a worker; the worker runs bash on the VM (e.g. uname -a; touch /tmp/spike); its answer arrives back in the root conversation as a follow-up.
2. Kill the process (SIGKILL) while the worker is mid-run. Restart, harness.resume(). The worker finishes and reports. Note what happens to the tool call that was interrupted.
3. From bash on the VM: 'nohup sleep 600 &' then drop the connection (kill the process). Check whether the sleep survives. Then a systemd transient unit (systemd-run sleep 600) and check it survives.
4. Read the SQLite file: list entries of each conversation with role and text; print harness.usage() totals. Confirm cost is non-zero for DeepSeek.

Non-goals: Telegram, roles, caps, custom tools, Docker, tests, nice code.
Caveats: Durable is experimental; if the API differs from AGENTS.md 'Pi facts', trust the installed package source in node_modules and note the difference in RESULTS.md. If any of 1, 2, 4 cannot be made to work in a day, stop and report; do not work around it.

ready for implementation

## Acceptance Criteria

spike/RESULTS.md states pass/fail for each of the 4 checks with the observed behaviour, including the interrupted tool call in check 2 and the nohup result in check 3. Any API discrepancies vs AGENTS.md are listed.

