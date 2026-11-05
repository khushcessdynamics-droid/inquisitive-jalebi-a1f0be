@echo off
rem Used by Windows Task Scheduler (no pause). Exit code 0 = verified backup, 1 = problem.
call "%~dp0_common.cmd" || exit /b 1
node "%ROOT%\tools\backup\src\cli.ts" backup --kind scheduled
exit /b %errorlevel%
