@echo off
title CESS backup - setup
call "%~dp0_common.cmd" || goto end
node "%ROOT%\tools\backup\src\cli.ts" setup
echo.
echo Next: edit the configuration file shown above, then run backup-now.cmd
:end
pause
