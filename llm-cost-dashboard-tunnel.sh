#!/bin/bash
# llm-cost-dashboard-tunnel.sh — open SSH tunnel from this MacBook to
# the dev machine running `llm-cost-monitor`, then point a browser
# at the dashboard.
#
#   ./llm-cost-dashboard-tunnel.sh           # start (default) + open browser
#   ./llm-cost-dashboard-tunnel.sh stop      # tear down
#   ./llm-cost-dashboard-tunnel.sh status    # is it up?

set -u

REMOTE_USER="ymh"
REMOTE_HOST="192.168.0.169"
VITE_PORT=5173        # vite renderer (IPv6 [::1] on remote)
API_PORT=4018         # web-api server (IPv4 127.0.0.1 on remote)
TAG="LCM_TUNNEL=${REMOTE_HOST}"

cmd="${1:-start}"

case "$cmd" in
  start)
    pkill -f "$TAG" 2>/dev/null && sleep 1
    ssh -fN \
        -L ${VITE_PORT}:[::1]:${VITE_PORT} \
        -L ${API_PORT}:127.0.0.1:${API_PORT} \
        -o ExitOnForwardFailure=yes \
        -o ServerAliveInterval=30 \
        -o "SetEnv ${TAG}" \
        ${REMOTE_USER}@${REMOTE_HOST}
    if [ $? -ne 0 ]; then
      echo "tunnel failed" >&2
      exit 1
    fi
    echo "tunnel up:"
    echo "  localhost:${VITE_PORT}  ->  ${REMOTE_HOST} (vite renderer)"
    echo "  localhost:${API_PORT}  ->  ${REMOTE_HOST} (web-api)"
    sleep 1
    open "http://localhost:${VITE_PORT}"
    ;;
  stop)
    if pkill -f "$TAG"; then echo "stopped"; else echo "no tunnel running"; fi
    ;;
  status)
    if pgrep -f "$TAG" >/dev/null; then
      echo "running:"
      pgrep -fl "$TAG"
    else
      echo "not running"
    fi
    ;;
  *)
    echo "usage: $0 [start|stop|status]" >&2
    exit 2
    ;;
esac
