@echo off
title CATAN 2
cd /d "%~dp0"
echo Iniciando CATAN 2...
call npm run dev
if errorlevel 1 (
  echo.
  echo Hubo un error al iniciar. Revisa el mensaje de arriba.
  pause
)
