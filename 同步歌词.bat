@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ============================================
echo   从 QQ 音乐缓存同步歌词到壁纸 lyrics/
echo ============================================
echo.
node tools\sync-lyrics.js
if errorlevel 1 (
  echo.
  echo [失败] 请确认：
  echo   1) 已安装 Node.js（命令行输入 node -v 能看到版本号）
  echo   2) QQ 音乐至少播放过几首歌（歌词缓存才会存在）
  echo   3) 如果缓存不在默认位置，用这条命令指定：
  echo      node tools\sync-lyrics.js --dir "你的\QQMusicLyricNew\路径"
)
echo.
echo 提示：想边听边自动补词，双击「歌词同步-常驻.bat」。
pause
