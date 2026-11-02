@echo off
title CESS backup - list
call "%~dp0_common.cmd" || goto end
node "%ROOT%\tools\backup\src\cli.ts" list
:end
pause
