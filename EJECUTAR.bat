@echo off
chcp 65001 >nul
title Escrutador de Artículos
cd /d "%~dp0"

echo ================================================================
echo    ESCRUTADOR DE ARTICULOS - Verificacion y calidad periodistica
echo ================================================================
echo.

if not exist ".venv\Scripts\python.exe" (
    echo [1/3] Creando entorno virtual...
    py -m venv .venv
)
echo [1/3] Comprobando dependencias...
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r requirements.txt

echo [2/3] Liberando el puerto 8010...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /r ":8010\>"') do (
    if not "%%a"=="" if not "%%a"=="0" taskkill /F /PID %%a >nul 2>&1
)

echo [3/3] Abriendo http://localhost:8010 ...
start "" cmd /c "timeout /t 3 >nul & start http://localhost:8010"
echo.
echo Servidor en ejecucion. Pulsa Ctrl+C para detenerlo.
echo ================================================================
".venv\Scripts\python.exe" run.py

if %ERRORLEVEL% NEQ 0 pause
