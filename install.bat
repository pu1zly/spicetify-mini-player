@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo       Installing Spotify Mini Player (PiP)
echo ===================================================
echo.

:: 1. Check Spicetify
where spicetify >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Spicetify CLI is not found in PATH!
    echo Please ensure Spicetify is installed: https://spicetify.app/
    pause
    exit /b 1
)

:: 2. Determine Spicetify Extensions path
for /f "delims=" %%I in ('spicetify path -e 2^>nul') do set "SPICETIFY_EXT=%%I"
if not exist "%SPICETIFY_EXT%" (
    set "SPICETIFY_EXT=%APPDATA%\spicetify\Extensions"
)

echo [*] Target Spicetify Extensions folder: %SPICETIFY_EXT%
if not exist "%SPICETIFY_EXT%" (
    mkdir "%SPICETIFY_EXT%"
)

:: 3. Copy miniplayer.js
echo [*] Copying miniplayer.js...
copy /y "%~dp0miniplayer.js" "%SPICETIFY_EXT%\miniplayer.js" >nul

:: 4. Enable in Spicetify config
echo [*] Enabling extension in Spicetify configuration...
spicetify config extensions miniplayer.js

:: 5. Apply
echo [*] Applying Spicetify modifications...
spicetify apply

echo.
echo ===================================================
echo   Installation Complete!
echo   Open Spotify and look for the Mini Player icon
echo   in the bottom-right playbar / topbar, or press
echo   Alt + M to toggle the floating Mini Player!
echo ===================================================
echo.
pause
