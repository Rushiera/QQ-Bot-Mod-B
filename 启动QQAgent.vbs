' QQ Agent launcher (no console window) -- QQBot mod B satellite candidate
' NOTE: keep ASCII-only (VBS on Chinese Windows is parsed as ANSI).
' 1) open a startup session (launch == new session)
' 2) start the app window -- NapCat protocol end is auto-started by the app itself
Set sh = CreateObject("WScript.Shell")
sh.Run "node ""D:\Mau\WorkSpace\QQBotB\tools\open-startup-session.mjs""", 0, True
' 2026-10-10: pin the app cwd to _unpack -- never inherit the caller's cwd.
' [qqagent-cwd-patch:launcher-vbs]
sh.CurrentDirectory = "D:\Mau\WorkSpace\QQBotB\_unpack"
sh.Run """D:\Mau\WorkSpace\QQBotB\_unpack\QQ Agent.exe""", 1, False
