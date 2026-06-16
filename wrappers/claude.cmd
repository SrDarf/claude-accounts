@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "CORE=%USERPROFILE%\.claude-accounts"
set "REAL=%CLAUDE_ACCOUNTS_REAL%"
if "%REAL%"=="" set "REAL=%USERPROFILE%\.local\bin\claude.exe"
if /I "%~1"=="--accounts" goto :menu
if /I "%~1"=="--account"  goto :acct
"%REAL%" %*
exit /b %ERRORLEVEL%
:menu
shift
node "%CORE%\src\cli.js" menu || (endlocal & exit /b 1)
goto :rest
:acct
node "%CORE%\src\cli.js" switch "%~2" || (endlocal & exit /b 1)
shift & shift
goto :rest
:rest
set "ARGS="
:loop
if "%~1"=="" goto :run
set "ARGS=!ARGS! %1"
shift
goto :loop
:run
"%REAL%" !ARGS!
exit /b %ERRORLEVEL%
