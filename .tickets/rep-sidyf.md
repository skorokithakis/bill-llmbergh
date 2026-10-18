---
id: rep-sidyf
status: closed
deps: []
links: []
created: 2026-10-18T00:29:19Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# send_file: founder sends a VM file to the owner on Telegram

Ready for implementation.

Objective: add a founder-only supervisor tool send_file(path, caption?) that reads a file from the work VM and uploads it to the owner's private Telegram chat as a document.

Scope: src/telegram.ts (sendFileToOwner using sendDocument, multipart via Node FormData/Blob, same client and owner chat id as sendToOwner), src/supervisor.ts (tool next to MessageOwnerTool), src/prompt.ts (one line telling the founder about the tool; workers give file paths in their result and the founder sends them), AGENTS.md (add the tool to the founder's supervisor tool list).

Behaviour:
- Read bytes through api.env (pi-env docs list readBinaryFile returning a Buffer; check the real 1.2.0 ExecutionEnv type). If api.env is undefined, error result, as in custom_tools.ts.
- Filename for Telegram = basename of path. Caption optional; Telegram caps captions at 1024 chars, so reject or clip a longer one with a clear message.
- Over 50 MB (Telegram bot upload limit): error result, nothing sent. The message tells the agent to compress/split, or serve it from the VM web server and send the link with message_owner. Prefer checking size before reading all bytes if the env offers stat cheaply; otherwise check after reading.
- Missing file, directory, read error, Telegram non-ok: error result the model can read (isError: true). Never throw for these. Let context aborts propagate (see web.ts).
- Not replay-safe, same as message_owner (an external effect must not repeat on restart).

Non-goals: inbound files from the owner; sendPhoto or other media types; worker access or per-role switch; new dependencies.

Constraints: the bot token and owner id must never appear in a tool result or reach the VM. callTelegram currently sends JSON only; extend or add a sibling for multipart without breaking the existing calls.

