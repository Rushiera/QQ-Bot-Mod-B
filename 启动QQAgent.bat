@echo off
rem ===========================================================================
rem QQ Agent launcher (QQBot mod B satellite candidate) -- ONE-CLICK FULL RESTART
rem ===========================================================================
rem NOTE: keep this file ASCII-only -- cmd parses .bat in GBK on Chinese
rem Windows; UTF-8 Chinese comments swallow the newline and break parsing.
rem
rem 2026-10-11: this launcher is a full restart. One click does:
rem   1) stop every running instance (QQ Agent.exe, child procs included)
rem   2) drop the stale instance lock (data\qq-agent.lock)
rem   3) open a startup session (launch == new session), data dir = _unpack\data
rem   4) start the app window (tray resident), cwd pinned to _unpack
rem
rem Logs are NOT rotated here on purpose (2026-10-11: keep them for a while and
rem decide later). The app prunes its own logs at startup anyway.
rem
rem Patch chain is NOT replayed here on purpose -- it is the maintainer's job,
rem and a broken anchor must never block a plain start. After an app reinstall,
rem run the chain by hand, in this order:
rem   session engage nosys memory sessions-fold botguard hardlimit
rem   talkstyle cattools cwd browse
rem
rem NOT touched on purpose -- these hold real state, deleting them loses data:
rem   data\messages\  chat archive       data\memory\  group notes + impressions
rem   data\sessions\  run records
rem   NapCat (runtime\NapCat\...\QQ.exe) -- protocol end; killing it forces a
rem   QR re-login, so it is left running and the app reconnects to it.
rem
rem Config is reproducible via: node tools\apply-qqagent-config.mjs
rem                               node tools\apply-qqagent-policy.mjs

setlocal
set "ROOT=%~dp0"
set "APPDIR=%ROOT%_unpack"
set "DATADIR=%APPDIR%\data"

echo [1/4] stopping running instances...
taskkill /IM "QQ Agent.exe" /T /F >nul 2>&1
rem wait a moment so the OS releases the lock file and the log handles
ping -n 3 127.0.0.1 >nul

echo [2/4] clearing instance lock...
if exist "%DATADIR%\qq-agent.lock" del /f /q "%DATADIR%\qq-agent.lock" >nul 2>&1

echo [3/4] opening startup session...
node "%ROOT%tools\open-startup-session.mjs"

echo [4/4] starting app...
rem 2026-10-10: pin the app cwd to _unpack -- never inherit the caller's cwd.
rem See tools/patch-qqagent-cwd.mjs for the case (host deploy rename blocked).
rem [qqagent-cwd-patch:launcher-bat]
cd /d "%~dp0_unpack" || exit /b 1
start "" "%~dp0_unpack\QQ Agent.exe"
endlocal
