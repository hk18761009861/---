@echo off
chcp 65001 >nul
cd /d "%~dp0"
python server.py
if errorlevel 1 (
  echo.
  echo 启动失败：请先安装 Python 3（https://www.python.org/downloads/ ，安装时勾选 Add Python to PATH）
  pause
)
