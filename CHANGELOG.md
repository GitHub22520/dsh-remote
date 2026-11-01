# Changelog

## 0.1.0

首个可用版本。

- 一个插件、两种角色（由配置选择）：
  - **宿主（`remotes`）**：`/remotes/<id>/` 前缀反代（HTTP + WebSocket），
    宿主会话鉴权，per-remote cookie jar，上游 `Host`/`Origin` 改写，
    令牌文件代换，iframe 存储命名空间注入。
  - **被远程（`agent`）**：维护 `ssh -R` 隧道，通过同一条 SSH 发布本进程的
    启动令牌，断开自动重连——被远程机器不需要额外脚本或拷贝文件。
- 浏览器半边：侧边栏「远程 DSH」面板、远端列表与在线探测、iframe 嵌入、
  新标签页打开；宿主没配置任何远端时不注册面板。
- 可选的独立 agent 脚本 `pc/dsh-remote-agent.mjs`（不装插件时的等价物）。
- 文档：README（两端安装、信任模型、配置、排查）、`install.sh` 便捷安装。
