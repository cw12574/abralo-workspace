@echo off
set "WORKSPACE_DATA_DIR=%LOCALAPPDATA%\AgentWorkspaceGoalsPreview"
set "WORKSPACE_PORT=4328"
"%~dp0..\runtime\node.exe" "%~dp0launcher.mjs"
if errorlevel 1 (
  echo The goals preview did not open. Your existing Abralo installation was left untouched.
  pause
  exit /b 1
)
