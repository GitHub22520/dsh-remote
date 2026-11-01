#!/usr/bin/env bash
# 可选路径：不用插件的 agent 模式时，用这个脚本在“被远程的机器”上
# 起 dsh web + ssh -R 隧道，并把启动令牌发布到服务器。
#
#   DSH_REMOTE_SSH=you@your-server bash start.sh
#
# 其余参数（--local-port / --remote-port / --token-path / --public-url …）
# 直接透传给 dsh-remote-agent.mjs，见文件头注释。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_TARGET="${DSH_REMOTE_SSH:-}"

if [ -z "$SSH_TARGET" ]; then
  echo "用法：DSH_REMOTE_SSH=you@your-server bash start.sh [其他参数]" >&2
  echo "  —— you@your-server 是运行 dsh-remote 宿主机（host 角色）的那台机器。" >&2
  exit 2
fi

exec node "$HERE/dsh-remote-agent.mjs" --ssh "$SSH_TARGET" "$@"
