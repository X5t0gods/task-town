@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Task Town Demo
set DB_NAME=
if not exist node_modules\mysql2\package.json call npm ci
if errorlevel 1 goto failed
if not exist .env node scripts/local-mysql.mjs
if errorlevel 1 goto failed
node scripts/demo.mjs
if errorlevel 1 goto failed
set DB_NAME=task_town_demo
echo.
echo 打开浏览器访问 http://127.0.0.1:3000
node server.mjs
:failed
pause
