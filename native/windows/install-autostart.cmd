@echo off
rem ---------------------------------------------------------------------------
rem  Makes AURA start with Windows, so "Aura" is listening without you opening
rem  anything - the closest thing to Siri on a laptop that a web app can do.
rem
rem  usage:  install-autostart.cmd        add the startup entry
rem          install-autostart.cmd /remove  delete it
rem ---------------------------------------------------------------------------
setlocal
set "HERE=%~dp0"
set "TARGET=%HERE%aura-app.cmd"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AURA.lnk"

if /i "%~1"=="/remove" (
  if exist "%LNK%" del "%LNK%" && echo AURA will no longer start with Windows.
  exit /b 0
)

if not exist "%TARGET%" (
  echo AURA: aura-app.cmd is missing next to this script.
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%');" ^
  "$s.TargetPath='%TARGET%'; $s.WorkingDirectory='%HERE%';" ^
  "$s.IconLocation='%SystemRoot%\System32\shell32.dll,14'; $s.Save()"

if exist "%LNK%" (
  echo AURA now starts with Windows: %LNK%
  echo Remove it any time with:  install-autostart.cmd /remove
) else (
  echo AURA: could not create the startup shortcut.
  exit /b 1
)
