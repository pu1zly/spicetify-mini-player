@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo      Uninstalling Spotify Mini Player (PiP)
echo ===================================================
echo.

where spicetify >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Spicetify CLI is not found in PATH!
    pause
    exit /b 1
)

for /f "delims=" %%I in ('spicetify path -e 2^>nul') do set "SPICETIFY_EXT=%%I"
if not exist "%SPICETIFY_EXT%" (
    set "SPICETIFY_EXT=%APPDATA%\spicetify\Extensions"
)

echo [*] Removing miniplayer.js from Spicetify configuration...
spicetify config extensions miniplayer.js-

if exist "%SPICETIFY_EXT%\miniplayer.js" (
    echo [*] Deleting "%SPICETIFY_EXT%\miniplayer.js"...
    del /f /q "%SPICETIFY_EXT%\miniplayer.js"
)

echo [*] Re-applying Spicetify...
spicetify apply

echo.
echo ===================================================
echo   Spotify Mini Player has been removed.
echo ===================================================
echo.
pause
