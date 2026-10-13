#!/usr/bin/env bash
# Driver for check 2: run the spike, SIGKILL the supervisor (whole process group) while the worker is
# mid-bash on the VM, then reopen the same SQLite and resume.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.secrets/vm.env; set +a
: "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY must be set}"

DB=spike/session-check2.sqlite
LOG=spike/check2a.log
rm -f "$DB"* "$LOG"

setsid node --experimental-strip-types spike/spike.ts check2a "$DB" > "$LOG" 2>&1 &
PID=$!
echo "check2a pid=$PID pgid=$(ps -o pgid= -p "$PID" | tr -d ' ')"

for _ in $(seq 1 600); do
	grep -q READY_TO_KILL "$LOG" && break
	sleep 0.5
done

if ! grep -q READY_TO_KILL "$LOG"; then
	echo "check2a never became ready:"; cat "$LOG"; kill -9 -"$PID" 2>/dev/null || true; exit 1
fi

# A moment so the VM-side sleep is definitely in flight, then kill the whole supervisor process group.
sleep 2
echo "SIGKILL -$PID"
kill -9 -"$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true

echo "=== check2a output ==="
cat "$LOG"

echo "=== check2b (reopen + resume) ==="
node --experimental-strip-types spike/spike.ts check2b "$DB" 2>&1 | grep -vE 'ExperimentalWarning|trace-warnings'
