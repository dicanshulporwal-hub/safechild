@echo off
setlocal
echo ======================================================================
echo SafeBrowse Child Agent - Emergency Network & DNS Restoration
echo ======================================================================
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Administrator privileges required. Please right-click and Run as Administrator.
    pause
    exit /b 1
)

echo Restoring all active network adapters to DHCP DNS...
"%~dp0SafeBrowseChild-Pilot.exe" --emergency-restore

echo.
echo Network restoration completed. Normal Internet access has been restored.
pause
