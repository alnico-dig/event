@echo off
rem Rebuild the #DIGspotlight archive data (data/games.csv and images/)
chcp 65001 > nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
python build_archive.py
echo.
pause
