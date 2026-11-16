@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 歌词同步（常驻，边听边补）
echo.
echo 已启动常驻模式：每 20 秒检查一次 QQ 音乐歌词缓存，有新歌就补进 lyrics/。
echo 壁纸会自己重试，通常换歌或等十几秒就能看到新歌词。关闭此窗口即停止。
echo.
node tools\sync-lyrics.js --watch
pause
