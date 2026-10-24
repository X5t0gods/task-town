@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Task Town
if not exist node_modules\mysql2\package.json call npm ci
if errorlevel 1 goto failed
if not exist .env node scripts/local-mysql.mjs
if errorlevel 1 goto failed
echo 任务小镇 - 正式本地数据
echo 打开浏览器访问 http://127.0.0.1:3000
echo 关闭此窗口或按 Ctrl+C 可以停止服务。
set DB_NAME=
node server.mjs
:failed
pause
