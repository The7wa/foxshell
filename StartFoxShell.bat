@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo First run: installing dependencies...
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  call npm install
)
call npm start
