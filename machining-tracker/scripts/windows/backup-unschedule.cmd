@echo off
title CESS backup - remove daily schedule
schtasks /Delete /TN "CESS Machining Tracker\Daily backup" /F
pause
