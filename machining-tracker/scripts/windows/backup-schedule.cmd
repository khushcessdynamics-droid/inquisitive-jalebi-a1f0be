@echo off
title CESS backup - schedule daily backup
call "%~dp0_common.cmd" || goto end
set "TIME_HHMM=21:00"
set /p "TIME_HHMM=Daily backup time in 24-hour HH:MM (press Enter for 21:00): "
if "%TIME_HHMM%"=="" set "TIME_HHMM=21:00"
node "%ROOT%\tools\backup\src\cli.ts" schedule-xml --time %TIME_HHMM% --out "%TEMP%\cess-backup-task.xml" --script "%~dp0backup-scheduled-run.cmd" || goto end
schtasks /Create /TN "CESS Machining Tracker\Daily backup" /XML "%TEMP%\cess-backup-task.xml" /F
if errorlevel 1 (echo Could not create the scheduled task.) else (echo Daily backup scheduled at %TIME_HHMM%. If the PC is off at that time, it runs at the next start-up.)
del "%TEMP%\cess-backup-task.xml" >nul 2>nul
:end
pause
