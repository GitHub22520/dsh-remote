@echo off
rem 可选路径：不用插件的 agent 模式时，用这个脚本在“被远程的机器”上
rem 起 dsh web + ssh -R 隧道，并把启动令牌发布到服务器。
rem
rem   set DSH_REMOTE_SSH=you@your-server
rem   start.cmd
rem
rem 其余参数（--local-port / --remote-port / --token-path / --public-url ...）
rem 直接透传给 dsh-remote-agent.mjs。
setlocal
set HERE=%~dp0
if "%DSH_REMOTE_SSH%"=="" (
  echo 用法：set DSH_REMOTE_SSH=you@your-server ^&^& start.cmd [其他参数]
  echo   —— you@your-server 是运行 dsh-remote 宿主机（host 角色）的那台机器。
  exit /b 2
)
node "%HERE%dsh-remote-agent.mjs" --ssh "%DSH_REMOTE_SSH%" %*
