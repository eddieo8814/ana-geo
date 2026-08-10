#!/bin/bash
# ANA 두뇌 세션 기동기 — fakechat 고아 정리 후 채널을 물고 Claude Code를 시작한다.
# 배경: 세션이 종료돼도 fakechat의 bun 서버(:8787)가 고아로 살아남는 경우가 있고,
#       그러면 다음 세션의 fakechat이 EADDRINUSE로 조용히 죽는다(/mcp에 -32000).
#       기동 전에 "부모가 launchd인(=고아)" bun만 골라 제거한다.
set -euo pipefail
PORT="${FAKECHAT_PORT:-8787}"

for pid in $(lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null); do
  ppid=$(ps -o ppid= -p "$pid" | tr -d ' ')
  cmd=$(ps -o comm= -p "$pid")
  if [ "$ppid" = "1" ]; then
    echo "[brain] 고아 fakechat 제거: pid=$pid ($cmd)"
    kill "$pid" || true
    sleep 1
  else
    echo "[brain] :$PORT 를 살아있는 프로세스(pid=$pid, ppid=$ppid)가 사용 중입니다."
    echo "        다른 두뇌 세션이 떠 있는지 확인하세요. 중단합니다."
    exit 1
  fi
done

echo "[brain] claude --channels plugin:fakechat@claude-plugins-official"
exec claude --channels plugin:fakechat@claude-plugins-official
