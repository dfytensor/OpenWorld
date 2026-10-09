@echo off
chcp 65001 >nul
title openworld
cd /d "%~dp0"
start "" http://127.0.0.1:8500
node server.js
pause
