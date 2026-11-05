@echo off
title CESS backup - backup now
call "%~dp0_common.cmd" || goto end
node "%ROOT%\tools\backup\src\cli.ts" backup --kind manual
if errorlevel 1 (echo. & echo BACKUP FAILED - see the messages above and the log folder.) else (echo. & echo Backup finished and VERIFIED.)
:end
pause
