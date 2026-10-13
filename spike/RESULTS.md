# Spike results: Pi Durable + pi-env + DeepSeek (ticket bl-fjczd)

Verdict: **checks 1, 2 and 4 pass; check 3 passes, but its result contradicts the reason given in
AGENTS.md for requiring systemd.** All four were run against the real work VM and a real DeepSeek model.
One deviation was needed: the `DEEPSEEK_API_KEY` in the environment is an **Ollama Cloud** key, not a
DeepSeek key (see "Provider" below). This was confirmed with the owner before running.

Throwaway code. No tests, no polish.

## What was built

- `spike/package.json`: a small npm project with `@earendil-works/pi-durable`, `pi-env`, `pi-ai` and
  `chord`, each pinned to exactly `1.2.0`.
- `spike/spike.ts`: one TS file, run with `node --experimental-strip-types`. Modes:
  - `check1 <db>`: root spawns a worker, the worker runs bash on the VM, the answer is reported back to
    the root, then it prints the SQLite transcript and `harness.usage()`.
  - `check2a <db>`: spawns a worker with a long bash command, waits until the worker is inside its bash
    call, prints `READY_TO_KILL`, then idles.
  - `check2b <db>`: reopens the same SQLite, `harness.resume()`, waits for the worker to finish and report.
  - `check3`: the SSH-drop survival probes (in-flight command, `nohup ... &`, `systemd-run`).
  - `check4 <db>`: reads the SQLite file directly (`node:sqlite`) and prints `harness.usage()`.
- `spike/run-check2.sh`: the check 2 driver: starts `check2a` with `setsid`, waits for `READY_TO_KILL`,
  `kill -9`s the whole supervisor process group, then runs `check2b`.
- Evidence: `spike/check1.log`, `spike/check2.log` (+ `spike/check2a.log`), `spike/check3.log`, and the
  SQLite files `spike/session-check1.sqlite`, `spike/session-check2.sqlite`.

Reproduce (from the repo root, `DEEPSEEK_API_KEY` set and `.secrets/vm.env` present):

```bash
set -a; . ./.secrets/vm.env; set +a
node --experimental-strip-types spike/spike.ts check1 spike/session-check1.sqlite
bash spike/run-check2.sh
node --experimental-strip-types spike/spike.ts check3 spike/session-check3.sqlite
node --experimental-strip-types spike/spike.ts check4 spike/session-check2.sqlite
```

## Provider: DeepSeek via Ollama Cloud, not api.deepseek.com

The `DEEPSEEK_API_KEY` value in the environment (and in `.envrc`) is rejected by `api.deepseek.com`:

```
$ curl https://api.deepseek.com/models -H "Authorization: Bearer $DEEPSEEK_API_KEY"
{"error":{"message":"Authentication Fails, Your api key: ****tzav is invalid", ...}}
```

The same key authenticates to Ollama Cloud (`https://ollama.com/v1/models` → 200), which serves
`deepseek-v4.1-flash` and `deepseek-v4-pro:0813`. pi-ai 1.2.0's built-in `deepseekProvider()` targets
`api.deepseek.com` and its catalog has model ids `deepseek-flash` / `deepseek-v4-pro` (there is **no**
`deepseek-chat`). The owner confirmed using Ollama Cloud.

The spike therefore builds the provider with `createProvider` (as AGENTS.md describes for Ollama Cloud):
provider id `deepseek`, `baseUrl: "https://ollama.com/v1"`, model id `deepseek-v4.1-flash` (a real DeepSeek
model), `compat.supportsDeveloperRole: false`, and the DeepSeek pricing copied from the `deepseek-flash`
catalog entry so `harness.usage()` reports a real cost.

**Important pitfall:** the catalog model object carries its own `baseUrl` (`https://api.deepseek.com`),
which overrides the provider's `baseUrl`. The model passed to `createProvider` must set `baseUrl` back to
the Ollama endpoint, otherwise every call silently goes to DeepSeek and 401s.

## Check 1 — spawn a worker, run bash on the VM, report back — PASS

Observed (`spike/check1.log`): the root assistant called `subagent {name: "alice", task: ...}`; a second
conversation (id 15, owned by the anchor task with id 14) called `bash {command: "uname -a; touch /tmp/spike"}`;
the tool result was the VM's `Linux bill-llmbergh 6.12.107+deb13-cloud-amd64 ... x86_64 GNU/Linux`; the
worker's final message became a follow-up input in the root conversation:
`[worker alice answered] I ran the exact command ...`. `/tmp/spike` exists on the VM. Root then acknowledged.
`harness.usage()` reported `deepseek/deepseek-v4.1-flash` with non-zero tokens and cost.

## Check 2 — SIGKILL mid-worker, reopen, resume — PASS

Observed (`spike/check2.log`): `check2a` spawned worker `bob` running
`echo start > /tmp/spike2; sleep 40; echo done >> /tmp/spike2`, waited until the worker's live state showed
the `bash` tool `running`, and printed `READY_TO_KILL`. The driver then `kill -9`ed the whole supervisor
process group (node + its `ssh`), so the local process died with **no** clean shutdown and the SSH transport
dropped. `check2b` reopened the same SQLite and called `harness.resume()`.

- The worker finished on its own and reported back to the root as a follow-up.
- **The interrupted tool call:** the durable transcript shows the `bash` tool-result as
  `<harness>\n[error] Tool bash was interrupted and may have partially run\n</harness>`. With the default
  replay policy, the interrupted `bash` call was **not** rerun; the model received the error result and
  continued. The model then chose not to retry (as instructed) and reported the interruption.
- `/tmp/spike2` on the VM contained exactly `start`: the write before the `sleep` had committed, the
  `sleep 40` was killed together with the dropping daemon, and `echo done` never ran.

## Check 3 — SSH-drop survival — PASS (with a caveat that matters)

Observed (`spike/check3.log`). Each case kills the local `ssh` transport mid-flight (what a supervisor
restart or network drop looks like to the remote pi-env daemon) and reconnects:

| Case | After the drop |
|---|---|
| In-flight foreground `sleep 653` | Killed. The exec rejected with `pi-env connection lost`; no `sleep 653` process remained. |
| `nohup sleep 654 &` (spawning exec returned at once) | **Survived** (the sleep process was still there after reconnect). |
| `systemd-run --unit=spike-sleep sleep 655` | Survived; the unit reported `active`. |

The AGENTS.md caveat ("when the SSH connection drops, pi-env kills every process group it started") is
**only true for commands still in flight**. A process backgrounded with `&` **after its spawning command
returned** is orphaned and reparented away from the daemon, so the daemon's shutdown does not reach it —
`nohup` is not even required. In practice a model calling `nohup sleep 600 &` through the `bash` tool gets a
quick return, so that background process **does** survive a supervisor restart. `systemd` is still the right
answer for anything that must survive, and is the only thing that survives when the command that started it
is still running at the drop, but the stated reason (nohup dies) does not hold for the common case.

## Check 4 — read the SQLite file, usage, cost — PASS

Observed (`spike/check1.log` and `check4`): reading the file directly with `node:sqlite` lists each
conversation (root and the anchor-owned worker conversation 15) and, per entry, its `kind` and the role/text
of its model messages (`pi.user`, `pi.assistant`, `pi.tool-result`). The `entries` table stores one JSON
`record` per row with `kind` and an optional `model` array; `conversations.owner_conversation_id` /
`owner_task_id` give ownership. `harness.usage()` totals are non-zero for
`deepseek/deepseek-v4.1-flash`, e.g. `cost.total ≈ 0.00073` for check 1 and `≈ 0.0016` for check 2.

## API differences from AGENTS.md "Pi facts"

1. **`DEEPSEEK_API_KEY` is not a DeepSeek key.** `deepseekProvider()` cannot authenticate with it; use the
   Ollama Cloud provider as above. pi-ai 1.2.0 has no `deepseek-chat` — the catalog ids are
   `deepseek-flash` and `deepseek-v4-pro`.
2. **A catalog model carries its own `baseUrl`.** `createProvider({ baseUrl })` is ignored for a model that
   already has `baseUrl`; the model must be overridden too. (Caused a confusing 401 to `api.deepseek.com`.)
3. **`env.exec()` does not return stdout.** `ShellExecResult` is `{ exitCode, spillPath? }`; output arrives
   through `options.onOutput(text, context, { stream })`. `spike.ts` collects it there.
4. **A task's `runtime.entry()` sees only its own conversation.** To read a subagent's answer entry, read it
   with `tx.entry(token, id)` **inside** a `runtime.commit`, as example 23 does — not with
   `runtime.entry(...)`, which returned `undefined` and produced an empty report.
5. **Example 23 is out of step with the installed types for tool results.** It returns
   `{ content: [...] }`; the installed `ToolExecutionResult` uses `output`. Use `output`.
6. **`harness.resume()` is synchronous** and takes no `Context`. Everything else takes `BACKGROUND_CONTEXT`.
7. `harness.snapshot(token, conversationId, context)` is the read used for `LiveDoc` / custom documents;
   `LiveDoc.tools[].status === "running"` was how the driver knew the worker was inside its `bash` call.
8. `acceptHostKey` + `scanHostKey` are a one-time step; the alias for this spike is `pi-env-bill-spike` in
   `.secrets/ssh/known_hosts` (the file's existing entry is for the bare IP, which pi-env does not use).

## Concerns for the real harness

- **Provider/credential:** the harness's config assumes `DEEPSEEK_API_KEY` drives `deepseekProvider()`. That
  is wrong for this credential. Config must select the Ollama Cloud base URL and model id explicitly, and
  the model's own `baseUrl` must be overwritten. Worth deciding whether the founder's config is "Ollama
  Cloud" or "DeepSeek direct", because the cost numbers and model behaviour differ.
- **systemd rule:** the founder's prompt says long-running work must be a systemd service because `nohup`
  dies on disconnect. That justification is false here; `nohup ... &` survives. The rule can stay (systemd
  is still more robust and observable), but the prompt should not claim something the runtime does not do.
- **First remote call is slow:** the first `env` use pays platform detection and a daemon upload
  (SHA-256 verified) over SSH. Do it at startup, not on the first user-visible command.
- **Interrupted tools are silent to the model beyond an error string.** The worker handled it well because
  the prompt told it not to retry; without that, a model may repeat a long command after every crash. The
  founder/worker prompts should say what to do about `interrupted`.
- **No cross-process storage locking.** `openNodeSqliteStorage` is single-owner; a crash leaves WAL to
  recover, which worked here, but two supervisors must never open the same file.
