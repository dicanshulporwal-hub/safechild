@echo off
setlocal
echo ======================================================================
echo SafeBrowse Child Agent - Device Pairing Utility
echo ======================================================================
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Administrator privileges required. Please right-click and Run as Administrator.
    pause
    exit /b 1
)

if "%~1"=="" (
    echo.
    echo Please provide the pairing code displayed in the SafeBrowse Parent Portal.
    echo.
    set /p PAIR_CODE="Enter Pairing Code (e.g. SB-123456): "
) else (
    set PAIR_CODE=%~1
)

if "%PAIR_CODE%"=="" (
    echo [ERROR] Pairing code is required.
    exit /b 1
)

set DEVICE_NAME=%~2
if "%DEVICE_NAME%"=="" set DEVICE_NAME=Rahul's Windows Laptop

echo.
echo Connecting to SafeBrowse Pilot Backend (https://safebrowse.porwal.online)...
"%~dp0SafeBrowseChild-Pilot.exe" --pair %PAIR_CODE% --name "%DEVICE_NAME%" --backend-url https://safebrowse.porwal.online
echo.
pause
