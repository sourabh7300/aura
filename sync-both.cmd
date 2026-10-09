@echo off
setlocal
cd /d "%~dp0"
echo === AURA build sync — both repos ===

echo [1/4] Local root copy ...
copy /y "%~dp0aura.html" "%~dp0..\aura.html" >nul
if errorlevel 1 ( echo     FAILED to update ..\aura.html & exit /b 1 )
echo     ..\aura.html updated

echo [2/4] AURA repo (github.com/sourabh7300/aura) ...
git diff --quiet HEAD -- aura.html
if %errorlevel%==0 (
  echo     aura.html already committed and pushed
) else (
  git add aura.html
  git commit -m "Build: sync aura.html" -- aura.html || exit /b 1
  git push origin main || exit /b 1
  echo     pushed to aura repo
)

echo [3/4] Portfolio mirror clone ...
if not exist "%~dp0.site-mirror\.git" (
  git clone https://github.com/sourabh7300/sourabh7300.github.io.git "%~dp0.site-mirror" || exit /b 1
)
pushd "%~dp0.site-mirror"
git pull --ff-only origin main || exit /b 1

echo [4/4] Portfolio repo (github.com/sourabh7300/sourabh7300.github.io) ...
copy /y "%~dp0aura.html" "aura.html" >nul
git diff --quiet HEAD -- aura.html
if %errorlevel%==0 (
  echo     portfolio already in sync
) else (
  git commit -m "Mirror AURA build: sync %date% %time%" -- aura.html || exit /b 1
  git push origin main || exit /b 1
  echo     pushed to portfolio repo
)
popd
echo === DONE: both repos in sync ===
exit /b 0
