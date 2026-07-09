#!/usr/bin/env bash
# Claw-in-a-Box — demo terminal script
# 用法: BASE=https://你的域名 bash demo.sh   (本地: BASE=http://127.0.0.1:8787)
# 开录屏软件,终端调大字号(18pt+)、深色主题,直接跑。

BASE="${BASE:-http://127.0.0.1:8787}"
G='\033[1;32m'; R='\033[1;31m'; Y='\033[1;33m'; C='\033[1;36m'; N='\033[0m'

say()  { echo; echo -e "${C}▶ $1${N}"; sleep 1.2; }
run()  { echo -e "${Y}\$ $1${N}"; sleep 0.8; }
show() { echo "$1" | python3 -m json.tool 2>/dev/null || echo "$1"; sleep 2.2; }

clear
echo -e "${C}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   Claw-in-a-Box                        ║"
echo "  ║   你的 AI agent 花钱之前,先问我一句。    ║"
echo "  ╚══════════════════════════════════════════╝"
echo -e "${N}"
sleep 2.5

# ─── 第一幕:三种裁决 ────────────────────────────────
say "场景:一个自动交易 agent 准备转账。每一笔,先问 Guard。"

say "小额 30 USDT —— 放行"
run "curl -X POST \$BASE/v1/guard/check -d '{\"agent_id\":\"trading-bot\",\"amount\":30}'"
show "$(curl -s -m 5 -X POST $BASE/v1/guard/check -d '{"agent_id":"trading-bot","amount":30}')"

say "150 USDT,超过审批阈值 —— 挂起,等人类点头 (review)"
run "curl ... -d '{\"agent_id\":\"trading-bot\",\"amount\":150}'"
show "$(curl -s -m 5 -X POST $BASE/v1/guard/check -d '{"agent_id":"trading-bot","amount":150}')"

say "999 USDT,超过单笔上限 —— 直接拒绝 (deny)"
run "curl ... -d '{\"agent_id\":\"trading-bot\",\"amount\":999}'"
show "$(curl -s -m 5 -X POST $BASE/v1/guard/check -d '{"agent_id":"trading-bot","amount":999}')"

# ─── 第二幕:日累计额度 ──────────────────────────────
say "agent 学会了拆单?没用。日累计额度记着账。"
for i in 1 2 3; do
  V=$(curl -s -m 5 -X POST $BASE/v1/guard/check -d '{"agent_id":"splitter","amount":80,"policy":"conservative"}')
  echo -e "  第 $i 笔 80 USDT -> $(echo $V | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["verdict"],"| 今日累计:",d["spent_today_after"])')"
  sleep 1.2
done
echo -e "${R}  ↑ 单笔都合规,但累计撞线,照样拦下${N}"
sleep 2.5

# ─── 第三幕:能力令牌 + 级联撤销 ─────────────────────
say "更进一步:agent 雇 agent 干活,怎么给权限?"
say "主 agent 持有 [read, write, pay] —— 只委托 [read] 给工人,10 分钟有效"
ROOT=$(curl -s -m 5 -X POST $BASE/v1/tokens -d '{"subject":"boss-agent","scopes":["read","write","pay"]}' | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
CHILD=$(curl -s -m 5 -X POST $BASE/v1/tokens/delegate -d "{\"parent_token\":\"$ROOT\",\"audience\":\"worker\",\"scopes\":[\"read\"],\"ttl_seconds\":600}" | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
echo -e "${G}  ✓ 子令牌已签发(不需要问任何中心服务器)${N}"
sleep 2

say "工人想给自己升级 admin 权限?"
show "$(curl -s -m 5 -X POST $BASE/v1/tokens/delegate -d "{\"parent_token\":\"$CHILD\",\"audience\":\"worker-2\",\"scopes\":[\"admin\"]}")"
echo -e "${R}  ✗ 越权被密码学拦截:子令牌永远不可能比父令牌权力大${N}"
sleep 2.5

say "任务结束,主 agent 撤销根令牌 ——"
curl -s -m 5 -X POST $BASE/v1/tokens/revoke -d "{\"token\":\"$ROOT\"}" > /dev/null
show "$(curl -s -m 5 -X POST $BASE/v1/tokens/verify -d "{\"token\":\"$CHILD\"}")"
echo -e "${R}  ✗ 整棵委托树瞬间失效。一次撤销,级联到底。${N}"
sleep 3

# ─── 收尾 ────────────────────────────────────────────
echo
echo -e "${C}  Claw-in-a-Box —— clawinabox.xyz · 开源 · Apache-2.0${N}"
echo -e "${C}  事前强制,而非事后追责。${N}"
echo
