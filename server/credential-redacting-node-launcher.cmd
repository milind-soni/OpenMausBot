@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~1" "%~2"
exit /b %ERRORLEVEL%
