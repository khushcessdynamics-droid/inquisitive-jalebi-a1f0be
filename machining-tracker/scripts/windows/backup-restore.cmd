@echo off
title CESS backup - RESTORE
echo ==================================================================
echo  RESTORE replaces ALL data in the online database with a backup.
echo  A safety backup of the current data is taken automatically first.
echo  Close this window now if you did not mean to restore.
echo ==================================================================
call "%~dp0_common.cmd" || goto end
node "%ROOT%\tools\backup\src\cli.ts" restore
:end
pause
