@echo off
setlocal
title tudouni-aigo desktop

REM ---------------------------------------------------------------
REM  Double-click this file to run the desktop app.
REM
REM  The debug build reads its interface from the Vite dev server and
REM  spawns the Go runtime, so both are checked below with the exact
REM  command to fix each.
REM
REM  Everything the app writes to stderr is captured to a log next to
REM  this script. A WebView2 failure happens during start-up and the
REM  window never appears, so without the log the only symptom is "it
REM  closed" -- which is not something anyone can act on.
REM ---------------------------------------------------------------

set "APPDIR=%~dp0.."
for %%I in ("%APPDIR%") do set "APPDIR=%%~fI"
set "ROOT=%APPDIR%\..\.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "EXE=%APPDIR%\src-tauri\target\debug\tudouni-aigo-desktop.exe"
set "RUNTIME=%APPDIR%\src-tauri\runtime\tudouni-aigo.exe"
set "LOG=%APPDIR%\launch.log"

if not exist "%EXE%" (
  echo.
  echo   The desktop app has not been built yet.
  echo     cd /d "%APPDIR%"
  echo     npm run tauri dev
  echo.
  pause
  exit /b 1
)

if not exist "%RUNTIME%" (
  echo.
  echo   The Go runtime is not staged next to the app.
  echo   The app spawns it, so it has to be there.
  echo     cd /d "%APPDIR%"
  echo     npm run runtime:stage
  echo.
  pause
  exit /b 1
)

REM A sandboxing tool can put an NTFS "Low" integrity label on this
REM repository. Windows caps a new process at the label of the image it
REM starts from, so every launch would run at low integrity -- and low
REM integrity cannot write to %LOCALAPPDATA%, which is where the app has
REM to create its WebView2 profile. The app then dies during start-up
REM with "Access is denied. (os error 5)" and no window ever appears.
powershell -NoProfile -Command "$t = @('%ROOT%', '%EXE%'); if (@($t | ForEach-Object { icacls $_ } | Select-String -SimpleMatch 'Low Mandatory Level').Count -gt 0) { exit 1 } else { exit 0 }"
if not errorlevel 1 goto integrity_ok

echo.
echo   This path carries a "Low" integrity label:
echo     %ROOT%
echo   Processes started from it run at low integrity, and Windows denies
echo   them %%LOCALAPPDATA%% -- the app has to create its WebView2 profile
echo   there, so it exits before any window appears. Clear the label with:
echo.
echo     icacls "%ROOT%" /T /C /setintegritylevel "(OI)(CI)Medium"
echo.
pause
exit /b 1

:integrity_ok

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5178 -State Listen -EA SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo   Starting the dev server on 127.0.0.1:5178 ...
  pushd "%APPDIR%"
  start "tudouni-aigo dev server" /min cmd /c "npx vite --port 5178 --strictPort"
  popd
  powershell -NoProfile -Command "for ($i=0; $i -lt 60; $i++) { if (Get-NetTCPConnection -LocalPort 5178 -State Listen -EA SilentlyContinue) { exit 0 }; Start-Sleep -Milliseconds 500 }; exit 1"
  if errorlevel 1 (
    echo   The dev server did not come up. Start it by hand:
    echo     cd /d "%APPDIR%"
    echo     npm run dev
    pause
    exit /b 1
  )
  echo   Dev server is up.
)

REM The runtime takes its working directory as the workspace. The
REM repository root is a real workspace (it has an AGENT.md).
cd /d "%ROOT%"
set "TUDOUNI_RUNTIME=%RUNTIME%"

echo.
echo   workspace : %CD%
echo   runtime   : %RUNTIME%
echo   log       : %LOG%
echo   launching ...
echo.

"%EXE%" 2> "%LOG%"
set "CODE=%ERRORLEVEL%"

echo.
if %CODE% neq 0 (
  echo   The app exited with code %CODE% before a window appeared.
  echo   What it said:
  echo.
  type "%LOG%"
  echo.
  echo   Full log: %LOG%
) else (
  echo   The app exited normally ^(code 0^).
)
echo.
pause
