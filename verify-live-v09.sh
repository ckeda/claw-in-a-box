#!/usr/bin/env bash
# Read-only v0.9 invariant probe. No payments, claims, mutations, or mainnet deploys.
set -u

BASE="${1:-https://test.clawinabox.xyz}"
EXPECTED_VERSION="${2:-0.9.0}"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1"; }
code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }
field() {
  python3 -c 'import json,sys
d=json.load(sys.stdin)
for part in sys.argv[1].split("."):
    d=d[int(part)] if isinstance(d,list) else d[part]
print(str(d).lower() if isinstance(d,bool) else d)' "$1"
}

HEALTH=$(curl -sS "$BASE/healthz")
[ "$(printf '%s' "$HEALTH" | field version)" = "$EXPECTED_VERSION" ] && ok "version=$EXPECTED_VERSION" || bad "version assertion"
[ "$(printf '%s' "$HEALTH" | field features.persistence.mode)" = "on" ] && ok "persistence=on" || bad "persistence mode"
[ "$(printf '%s' "$HEALTH" | field features.persistence.db_connected)" = "true" ] && ok "database connected" || bad "database connected"
[ "$(printf '%s' "$HEALTH" | field features.persistence.hydrated)" = "true" ] && ok "database hydrated" || bad "database hydrated"

[ "$(code "$BASE/v1/policies")" = "200" ] && ok "policies remains free" || bad "policies remains free"
[ "$(code "$BASE/v1/metrics")" = "200" ] && ok "public aggregate metrics" || bad "public aggregate metrics"
[ "$(code "$BASE/v1/approvals?limit=1")" = "401" ] && ok "approval list requires bearer" || bad "approval list auth"
[ "$(code -X POST "$BASE/v1/guard/check" -H 'content-type: application/json' -d '{"agent_id":"verify-v09","amount":1}')" = "200" ] && ok "guard remains free" || bad "guard remains free"
[ "$(code "$BASE/paid/v1/agents/claim")" = "402" ] && ok "CDP claim GET probe" || bad "CDP claim GET probe"
[ "$(code "$BASE/paid-okx/v1/agents/claim")" = "402" ] && ok "OKX claim GET probe" || bad "OKX claim GET probe"

HEADERS=$(curl -sSI -X OPTIONS "$BASE/v1/metrics" -H 'Origin: https://console.example' -H 'Access-Control-Request-Method: GET')
printf '%s' "$HEADERS" | tr '[:upper:]' '[:lower:]' | grep -q 'access-control-allow-headers:.*authorization' && ok "CORS allows authorization" || bad "CORS authorization header"
printf '%s' "$HEADERS" | tr '[:upper:]' '[:lower:]' | grep -q 'access-control-allow-credentials' && bad "CORS credentials must stay absent" || ok "CORS credentials absent"

printf '\nRESULT  %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
