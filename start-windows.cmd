@echo off
setlocal
pushd "%~dp0" || exit /b 1

if not exist ".venv\Scripts\python.exe" (
    where py >nul 2>&1
    if errorlevel 1 (
        python -m venv .venv
    ) else (
        py -3 -m venv .venv
    )
    if errorlevel 1 goto :failed
)

".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --only-binary=:all: -r requirements.txt
if errorlevel 1 goto :failed

".venv\Scripts\python.exe" backend\server.py %*
set "status=%errorlevel%"
popd
exit /b %status%

:failed
echo Could not prepare Python dependencies. Check that CPython and pip are installed.
popd
exit /b 1
