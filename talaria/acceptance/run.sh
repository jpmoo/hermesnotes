#!/usr/bin/env bash
# The Phase 1 acceptance scenario, end to end.
set -uo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
REPO="${1:-$(cd "$S/../.." && pwd)}"
WORK="${TMPDIR:-/tmp}/talaria-acceptance"
mkdir -p "$WORK"
export TALARIA_HOME="$WORK/home"
export TALARIA_SOCKET="/tmp/talaria-acceptance.sock"
export STUB_STORE="$WORK/stub.json"
TSX="$REPO/apps/server/node_modules/.bin/tsx"
HERMES="$TSX $REPO/talaria/packages/cli/src/index.ts"

rm -rf "$TALARIA_HOME" "$STUB_STORE" "$TALARIA_SOCKET"; mkdir -p "$TALARIA_HOME"
cat > "$TALARIA_HOME/config.json" <<JSON
{ "origin": "http://127.0.0.1:58080", "accessKey": "probe-key", "pollSeconds": 2 }
JSON
chmod 600 "$TALARIA_HOME/config.json"

# Only ever kill what this script started. `pkill -f talaria/packages/daemon`
# also matches a daemon the user is actually running — which is how this suite
# once stopped a live one, and then launchd declined to bring it back because a
# clean shutdown exits 0.
cleanup(){
  [ -f "$WORK/daemon.pid" ] && kill "$(cat "$WORK/daemon.pid")" 2>/dev/null
  [ -f "$WORK/stub.pid" ] && kill "$(cat "$WORK/stub.pid")" 2>/dev/null
  rm -f "$WORK/daemon.pid" "$WORK/stub.pid"
  return 0
}
trap cleanup EXIT
cleanup
hr() { echo; echo "════ $* ════"; }

# ── Failing loudly ────────────────────────────────────────────────────────────
#
# This script printed "done" and exited 0 whatever happened. It had been doing
# that for a while: its stub answered the producer's private routes rather than
# the interchange, so half the steps printed an error, one died on a TypeError,
# and the run still ended green. A scenario nobody can trust is worse than no
# scenario, because it is *counted*.
#
# So: every claim the scenario makes is now checked, and anything that fails is
# collected and reported at the end with a non-zero exit.
FAILURES=0
fail() { echo "   ✗ $*"; FAILURES=$((FAILURES + 1)); }
pass() { echo "   ✓ $*"; }

# `want <description> <expected> <actual>`
want() { [ "$2" = "$3" ] && pass "$1" || fail "$1 — wanted [$2], got [$3]"; }

# `says <description> <needle> <haystack>` — a fact somewhere in some output.
says() { case "$3" in *"$2"*) pass "$1" ;; *) fail "$1 — no '$2' in the output" ;; esac; }

# `quiet <description> <output>` — nothing in it announced an error.
quiet() { case "$2" in *"error:"*|*"Error"*|*"Cannot read"*) fail "$1 — $2" ;; *) pass "$1" ;; esac; }
stub_up()  { node "$S/stub.mjs" > "$WORK/stub.log" 2>&1 & echo $! > "$WORK/stub.pid"; sleep 1; }
stub_down(){ [ -f "$WORK/stub.pid" ] && kill "$(cat "$WORK/stub.pid")" 2>/dev/null; sleep 0.5; return 0; }

hr "1. Hermes up, daemon starts cold"
stub_up
$TSX "$REPO/talaria/packages/daemon/src/index.ts" > "$WORK/daemon.log" 2>&1 &
echo $! > "$WORK/daemon.pid"
sleep 3
$HERMES status | sed -n '1,8p'

hr "2. reads come from the mirror"
$HERMES find

hr "3. someone edits in the web app; daemon catches up"
node -e '
const s=JSON.parse(require("fs").readFileSync(process.env.STUB_STORE,"utf8"));
const b=s.blocks.find(b=>b.properties.title==="Call the accountant");
b.properties.title="Call the accountant (urgent)"; b.version++;
s.seq++; s.changes.push({seq:s.seq,blockId:b.id,op:"update",version:b.version,at:new Date().toISOString()});
require("fs").writeFileSync(process.env.STUB_STORE,JSON.stringify(s));'
stub_down; stub_up
SYNCED="$($HERMES sync 2>&1)"; echo "$SYNCED"
quiet "sync answered without an error" "$SYNCED"
FOUND="$($HERMES find --kind task 2>&1)"; echo "$FOUND"
says "the edit made it into the mirror" "urgent" "$FOUND"

hr "4. THE NETWORK GOES AWAY"
stub_down
$HERMES find
echo "--- exit code was $? (0 = answered fine) ---"

hr "5. writes while offline"
ADDED="$($HERMES add "Booked on the plane" 2>&1)"; echo "$ADDED"
says "an offline create queues rather than failing" "queued" "$ADDED"
NOTED="$($HERMES note "line written at 30,000 feet" 2>&1)"; echo "$NOTED"
quiet "an offline note append is accepted" "$NOTED"
echo "--- and the new task is already findable, with its real id ---"
PLANE="$($HERMES find plane 2>&1)"; echo "$PLANE"
says "a queued create is findable at once" "plane" "$PLANE"
$HERMES queue

hr "6. network returns"
stub_up
$HERMES sync
$HERMES queue

hr "7. what actually reached Hermes"
REACHED="$(node -e '
const s=JSON.parse(require("fs").readFileSync(process.env.STUB_STORE,"utf8"));
const made=s.blocks.filter(b=>b.properties?.title==="Booked on the plane");
console.log("blocks titled \"Booked on the plane\":", made.length, made.map(b=>b.id));
// Every daily note, not the first one found. The seeded note is from August and
// the write went to the current day, which the daemon had to create on the way,
// so looking at one note found the wrong one and reported a line that had
// arrived safely as missing.
//
// No apostrophes in here: this script is inside a single-quoted shell string,
// and one of those ends it — which is how a comment turned into a syntax error
// that printed nothing and looked exactly like the bug it was describing.
const notes=s.blocks.filter(b=>b.properties?.today_note);
const hits=notes.reduce((n,b)=>n+((b.content||"").match(/30,000 feet/g)||[]).length,0);
console.log("times the line appears in the daily note:", hits);' 2>&1)"
echo "$REACHED"
says "the queued task reached the producer exactly once" '"Booked on the plane": 1' "$REACHED"
says "the note line arrived exactly once" "daily note: 1" "$REACHED"

hr "8. a replayed create must not duplicate (lost-response case)"
REPLAY="$(node -e '
const {execSync}=require("child_process");
const s=JSON.parse(require("fs").readFileSync(process.env.STUB_STORE,"utf8"));
const b=s.blocks.find(x=>x.properties?.title==="Booked on the plane");
const r=execSync(`curl -s -X POST http://127.0.0.1:58080/api/blocks -H "authorization: Bearer probe-key" -H "content-type: application/json" -d ${JSON.stringify(JSON.stringify({id:b.id,properties:{title:"Booked on the plane"}}))}`).toString();
console.log("re-sending the same create returned version:", JSON.parse(r).version, "(1 = it was new; >1 or same id = recognized)");
const after=JSON.parse(require("fs").readFileSync(process.env.STUB_STORE,"utf8"));
console.log("blocks with that title now:", after.blocks.filter(x=>x.properties?.title==="Booked on the plane").length);' 2>&1)"
echo "$REPLAY"
quiet "the replay ran" "$REPLAY"
says "re-sending the same create made no second block" "title now: 1" "$REPLAY"

hr "9. mirror agrees — no duplicate locally either"
$HERMES sync >/dev/null
LOCAL="$($HERMES find plane 2>&1)"; echo "$LOCAL"
want "one local copy, not two" "1" "$(printf "%s" "$LOCAL" | grep -c "Booked on the plane")"

kill "$(cat "$WORK/daemon.pid")" 2>/dev/null
stub_down
echo
if [ "$FAILURES" -eq 0 ]; then
  echo "════ done — every check passed ════"
else
  echo "════ FAILED — $FAILURES check(s) did not pass ════"
fi
exit "$FAILURES"
