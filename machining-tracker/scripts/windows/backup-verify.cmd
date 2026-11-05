@echo off
title CESS backup - verify latest
call "%~dp0_common.cmd" || goto end
node "%ROOT%\tools\backup\src\cli.ts" verify latest
:end
pause
