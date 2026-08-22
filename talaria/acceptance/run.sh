#!/usr/bin/env bash
# The Phase 1 acceptance scenario, end to end.
set -uo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
REPO="${1:-$(cd "$S/../.." && pwd)}"
WORK="${TMPDIR:-/tmp}/talaria-acceptance"
mkdir -p "$WORK"
export TALARIA_HOME="$WORK/home"
export TALARIA_SOCKET="/tmp/talaria-test.sock"
export STUB_STORE="$WORK/stub.json"
TSX="$REPO/apps/server/node_modules/.bin/tsx"
HERMES="$TSX $REPO/talaria/packages/cli/src/index.ts"

rm -rf "$TALARIA_HOME" "$STUB_STORE" "$TALARIA_SOCKET"; mkdir -p "$TALARIA_HOME"
cat > "$TALARIA_HOME/config.json" <<JSON
{ "origin": "http://127.0.0.1:58080", "accessKey": "probe-key", "pollSeconds": 2 }
JSON
chmod 600 "$TALARIA_HOME/config.json"

cleanup(){ pkill -f "acceptance/stub.mjs" 2>/dev/null; pkill -f "talaria/packages/daemon" 2>/dev/null; }
trap cleanup EXIT
cleanup
hr() { echo; echo "════ $* ════"; }
stub_up()  { node "$S/stub.mjs" > "$WORK/stub.log" 2>&1 & echo $! > "$WORK/stub.pid"; sleep 1; }
stub_down(){ pkill -f "acceptance/stub.mjs" 2>/dev/null; sleep 0.5; }

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
$HERMES sync
$HERMES find --kind task

hr "4. THE NETWORK GOES AWAY"
stub_down
$HERMES find
echo "--- exit code was $? (0 = answered fine) ---"

hr "5. writes while offline"
$HERMES add "Booked on the plane"
$HERMES note "line written at 30,000 feet"
echo "--- and the new task is already findable, with its real id ---"
$HERMES find plane
$HERMES queue

hr "6. network returns"
stub_up
$HERMES sync
$HERMES queue

hr "7. what actually reached Hermes"
node -e '
const s=JSON.parse(require("fs").readFileSync(process.env.STUB_STORE,"utf8"));
const made=s.blocks.filter(b=>b.properties?.title==="Booked on the plane");
console.log("blocks titled \"Booked on the plane\":", made.length, made.map(b=>b.id));
const note=s.blocks.find(b=>b.properties?.today_note);
const hits=(note.content.match(/30,000 feet/g)||[]).length;
console.log("times the line appears in the daily note:", hits);'

hr "8. a replayed create must not duplicate (lost-response case)"
node -e '
const {execSync}=require("child_process");
const s=JSON.parse(require("fs").readFileSync(process.env.STUB_STORE,"utf8"));
const b=s.blocks.find(x=>x.properties?.title==="Booked on the plane");
const r=execSync(`curl -s -X POST http://127.0.0.1:58080/api/blocks -H "authorization: Bearer probe-key" -H "content-type: application/json" -d ${JSON.stringify(JSON.stringify({id:b.id,properties:{title:"Booked on the plane"}}))}`).toString();
console.log("re-sending the same create returned version:", JSON.parse(r).version, "(1 = it was new; >1 or same id = recognised)");
const after=JSON.parse(require("fs").readFileSync(process.env.STUB_STORE,"utf8"));
console.log("blocks with that title now:", after.blocks.filter(x=>x.properties?.title==="Booked on the plane").length);'

hr "9. mirror agrees — no duplicate locally either"
$HERMES sync >/dev/null
$HERMES find plane

kill "$(cat "$WORK/daemon.pid")" 2>/dev/null
stub_down
echo; echo "════ done ════"
