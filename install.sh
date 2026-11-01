#!/usr/bin/env bash
# 服务器端便捷安装：把插件装进某个 dsh profile，并在 profile patch 里写入示例配置。
#
#   bash install.sh                       # 从 GitHub 安装（默认）
#   bash install.sh /path/to/dsh-remote   # 从本地目录安装（开发用）
#
# 以运行 dsh-web 的同一个用户执行。可选环境变量：
#   DSH_PROFILE(web) DSH_HOME(~/.dsh) DSH_BIN(dsh)
#   REMOTE_ID(pc) REMOTE_TARGET(http://127.0.0.1:18081) REMOTE_LABEL(我的 PC)
set -euo pipefail

SPEC="${1:-github:GitHub22520/dsh-remote}"
PROFILE="${DSH_PROFILE:-web}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
DSH_BIN="${DSH_BIN:-dsh}"
PATCH="$DSH_HOME_DIR/profiles/$PROFILE/cordis.patch.yml"
REMOTE_ID="${REMOTE_ID:-pc}"
REMOTE_LABEL="${REMOTE_LABEL:-我的 PC}"
REMOTE_TARGET="${REMOTE_TARGET:-http://127.0.0.1:18081}"
TOKEN_FILE="$DSH_HOME_DIR/remotes/$REMOTE_ID.token"

if ! command -v "$DSH_BIN" >/dev/null 2>&1; then
  echo "找不到 dsh 命令：$DSH_BIN（加进 PATH，或用 DSH_BIN=... 指定）" >&2
  exit 1
fi
if [ ! -f "$PATCH" ]; then
  echo "找不到 profile patch：$PATCH" >&2
  echo "先用该 profile 启动过一次 dsh，再回来运行本脚本。" >&2
  exit 1
fi

echo "→ 安装 $SPEC 到 profile '$PROFILE'"
"$DSH_BIN" plugin --profile "$PROFILE" add "$SPEC"

if grep -q "id: dsh-remote" "$PATCH"; then
  echo "→ $PATCH 里已有 dsh-remote 配置，跳过"
else
  BACKUP="$PATCH.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$PATCH" "$BACKUP"
  cat >>"$PATCH" <<YAML

# dsh-remote：把 PC 上的 dsh 挂到 /remotes/<id>/，并在侧边栏提供「远程 DSH」面板。
# target 是服务器回环上那条 ssh -R 隧道；tokenFile 由 PC 上的 dsh-remote-agent 写入。
- id: dsh-remote
  config:
    remotes:
      - id: ${REMOTE_ID}
        label: ${REMOTE_LABEL}
        target: ${REMOTE_TARGET}
        tokenFile: ${TOKEN_FILE}
YAML
  echo "→ 已追加示例配置（原文件备份在 $BACKUP）"
fi

cat <<DONE

下一步：
  1) 重启 dsh web 让插件生效（会断开当前页面，刷新即可）：
       sudo systemctl restart dsh-web
  2) 在被远程的机器上装同一个插件，配置换成 agent：
       dsh plugin --profile web add "github:GitHub22520/dsh-remote"
       # ~/.dsh/profiles/web/cordis.patch.yml 里加：
       # - id: dsh-remote
       #   config:
       #     agent:
       #       ssh: <user>@<本机可达的宿主机>   # 需要免密
       #       remotePort: ${REMOTE_TARGET##*:}
  3) 打开 dsh → 侧边栏「远程 DSH」→ 打开

自检：
  curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3080/remotes/_api/list   # 期望 401
DONE
