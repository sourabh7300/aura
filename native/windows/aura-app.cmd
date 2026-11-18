@echo off
rem ---------------------------------------------------------------------------
rem  AURA as a desktop window (no address bar, one window, own taskbar entry).
rem  Uses the installed browser app window, so the wake word ("Aura") keeps
rem  working exactly like the web app - nothing is re-implemented here.
rem
rem  usage:  aura-app.cmd            open AURA
rem          aura-app.cmd --find     only print which browser was found
rem ---------------------------------------------------------------------------
setlocal enabledelayedexpansion
set "URL=https://sourabh7300.github.io/aura/aura.html"
set "BROWSER="

for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
) do (
  if not defined BROWSER if exist "%%~P" set "BROWSER=%%~P"
)

if not defined BROWSER (
  echo AURA: Chrome or Edge not found. Install one, then run this again.
  echo        ^(The web app also works in any browser: %URL%^)
  exit /b 1
)

if /i "%~1"=="--find" (
  echo %BROWSER%
  exit /b 0
)

rem --app opens a clean window; --start-maximized keeps the mic armed on screen
start "" "%BROWSER%" --app="%URL%" --start-maximized --new-window
exit /b 0
