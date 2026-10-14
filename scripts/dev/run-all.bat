@echo off
rem Double-click entry point for the Sortea local stack.
rem   run-all.bat          check tooling, start Docker and local Supabase, refresh
rem                        dependencies, migrate and seed, then start api + worker + web
rem   run-all.bat test     same preparation, then typecheck, unit/integration tests
rem                        against real Postgres, and Playwright E2E against the stack
rem   run-all.bat doctor   only report prerequisites; changes nothing
rem Set SORTEA_NO_PAUSE=1 to skip the final pause (scripted use).
setlocal EnableExtensions

for %%I in ("%~dp0..\..") do set "REPO_ROOT=%%~fI"
set "DOCTOR=%REPO_ROOT%\scripts\dev\doctor.mjs"
set "DOCKER_DESKTOP_EXE=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
set "DOCKER_WAIT_LIMIT=180"
rem API_HEALTH is set after .env exists (step 4): the API port comes from API_PORT.
rem The web port is fixed by apps/web/vite.config.ts (strictPort).
set "WEB_HEALTH=http://127.0.0.1:5173/"
set "STACK_TITLE=Sortea - dev stack (close to stop)"

set "MODE=%~1"
if "%MODE%"=="" set "MODE=run"
if /i "%MODE%"=="run" goto :mode_ok
if /i "%MODE%"=="test" goto :mode_ok
if /i "%MODE%"=="doctor" goto :mode_ok
echo Unknown mode "%MODE%". Use: run-all.bat [run^|test^|doctor]
goto :fail
:mode_ok

title Sortea - local stack (%MODE%)
cls
echo ============================================================
echo  Sortea - local stack (%MODE%)
echo ============================================================
echo.

if not exist "%REPO_ROOT%\package.json" (
  echo ERROR: Repository not found at %REPO_ROOT%
  goto :fail
)
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not available on PATH.
  echo Install Node 22 with: fnm install 22 ^&^& fnm default 22
  goto :fail
)
cd /d "%REPO_ROOT%"

if /i "%MODE%"=="doctor" goto :doctor_only

rem --- Tooling -----------------------------------------------------------------
echo [1/6] Checking tooling...
node "%DOCTOR%" check --scope=tooling
if errorlevel 1 goto :fail
echo.

rem --- Docker engine -------------------------------------------------------------
echo [2/6] Checking Docker engine...
docker info >nul 2>nul
if not errorlevel 1 goto :docker_ready

echo Docker engine is not running. Starting Docker Desktop...
docker desktop start --detach >nul 2>nul
if not errorlevel 1 goto :docker_wait_start
if not exist "%DOCKER_DESKTOP_EXE%" (
  echo ERROR: Could not start Docker Desktop and it was not found at:
  echo   %DOCKER_DESKTOP_EXE%
  echo Start Docker Desktop manually and run this launcher again.
  goto :fail
)
start "" "%DOCKER_DESKTOP_EXE%"

:docker_wait_start
set /a DOCKER_WAITED=0
:docker_wait
docker info >nul 2>nul
if not errorlevel 1 goto :docker_ready
if %DOCKER_WAITED% GEQ %DOCKER_WAIT_LIMIT% (
  echo ERROR: Docker engine did not become ready within %DOCKER_WAIT_LIMIT%s.
  echo Open Docker Desktop, check for errors or pending updates, then run this launcher again.
  goto :fail
)
echo   waiting for Docker engine... %DOCKER_WAITED%s
timeout /t 3 /nobreak >nul
set /a DOCKER_WAITED+=3
goto :docker_wait

:docker_ready
for /f "delims=" %%v in ('docker info --format "{{.ServerVersion}}"') do echo   Docker engine %%v is running.
echo.

rem --- Local Supabase -------------------------------------------------------------
echo [3/6] Checking local Supabase...
node "%DOCTOR%" supabase-running
if not errorlevel 1 goto :supabase_ready
echo Local Supabase is not running. Starting it (the first start downloads images)...
node scripts\supabase.mjs start
if errorlevel 1 (
  echo ERROR: Could not start local Supabase. Check Docker Desktop and the output above.
  goto :fail
)
:supabase_ready
echo   Local Supabase is running.
echo.

rem --- Configuration and dependencies ------------------------------------------
echo [4/6] Checking configuration and dependencies...
if exist "%REPO_ROOT%\.env" goto :env_ready
echo .env is missing; generating it from local Supabase with fresh secrets...
call pnpm setup:env
if errorlevel 1 (
  echo ERROR: pnpm setup:env failed.
  goto :fail
)
:env_ready

node "%DOCTOR%" deps-fresh
if not errorlevel 1 goto :deps_ready
echo node_modules is missing or older than pnpm-lock.yaml; running pnpm install...
call pnpm install --frozen-lockfile
if errorlevel 1 (
  echo ERROR: pnpm install failed.
  goto :fail
)
:deps_ready

set "API_PORT="
for /f "delims=" %%p in ('node "%DOCTOR%" env API_PORT') do set "API_PORT=%%p"
if not defined API_PORT set "API_PORT=3001"
set "API_HEALTH=http://127.0.0.1:%API_PORT%/health"

node "%DOCTOR%" check
if errorlevel 1 (
  echo.
  echo ERROR: Fix the failed checks above before starting the stack.
  goto :fail
)
echo.

rem --- Database -----------------------------------------------------------------
echo [5/6] Applying migrations and seed data (both are idempotent)...
call pnpm --silent db:migrate
if errorlevel 1 (
  echo ERROR: Migrations failed.
  goto :fail
)
call pnpm --silent db:seed
if errorlevel 1 (
  echo ERROR: Seeding failed.
  goto :fail
)
echo.

if /i "%MODE%"=="test" goto :tests

rem --- Run ----------------------------------------------------------------------
echo [6/6] Starting the stack...
call :ensure_stack
if errorlevel 1 goto :fail
start "" "http://localhost:5173/"
echo.
echo ============================================================
echo  Sortea is running
echo ============================================================
echo   Site (MotoGarage)   http://localhost:5173
echo   Second tenant       http://pista.localhost:5173
echo   Admin panel         http://localhost:5173/admin
echo   Emails (Mailpit)    http://127.0.0.1:54324
echo   Supabase Studio     http://127.0.0.1:54323
echo.
echo   Accounts: admin@sortea.local, owner@motogarage.local, operador@motogarage.local,
echo             finanzas@motogarage.local, owner@pistasur.local
echo   Password: SEED_ADMIN_PASSWORD in .env, or the one printed by the first seed.
echo.
echo Close the "%STACK_TITLE%" window to stop api, worker and web.
echo Local Supabase keeps running in Docker until: pnpm db:stop
goto :done

rem --- Tests --------------------------------------------------------------------
:tests
set "RESULT_CHECK=FAILED"
set "RESULT_UNIT=FAILED"
set "RESULT_E2E=SKIPPED"

echo [6/6] Running tests...
echo.
echo --- Typecheck (pnpm check) ---
call pnpm check
if not errorlevel 1 set "RESULT_CHECK=passed"
echo.
echo --- Unit and integration tests against real Postgres (pnpm test) ---
call pnpm test
if not errorlevel 1 set "RESULT_UNIT=passed"
echo.
echo --- End-to-end tests (Playwright) ---
if defined E2E_ADMIN_PASSWORD goto :e2e_password_ready
for /f "delims=" %%p in ('node "%DOCTOR%" env E2E_ADMIN_PASSWORD') do set "E2E_ADMIN_PASSWORD=%%p"
if defined E2E_ADMIN_PASSWORD goto :e2e_password_ready
for /f "delims=" %%p in ('node "%DOCTOR%" env SEED_ADMIN_PASSWORD') do set "E2E_ADMIN_PASSWORD=%%p"
if defined E2E_ADMIN_PASSWORD goto :e2e_password_ready
echo Skipped: add SEED_ADMIN_PASSWORD=^<password of the local accounts^> to .env to run them.
goto :test_summary

:e2e_password_ready
if not defined PW_CHROMIUM_PATH for /f "delims=" %%b in ('node "%DOCTOR%" browser') do set "PW_CHROMIUM_PATH=%%b"
node "%DOCTOR%" wait "%API_HEALTH%" "%WEB_HEALTH%" --timeout=2 >nul 2>nul
if errorlevel 1 goto :e2e_start_stack
echo The stack was already running. Rate limits live in memory: if E2E fails with
echo "Demasiados intentos", close the stack window and run this launcher again.
goto :e2e_run
:e2e_start_stack
call :ensure_stack
if errorlevel 1 (
  set "RESULT_E2E=FAILED (stack did not start)"
  goto :test_summary
)
:e2e_run
set "RESULT_E2E=FAILED"
call pnpm test:e2e
if not errorlevel 1 set "RESULT_E2E=passed"

:test_summary
echo.
echo ============================================================
echo  Test results
echo ============================================================
echo   Typecheck              %RESULT_CHECK%
echo   Unit and integration   %RESULT_UNIT%
echo   End-to-end             %RESULT_E2E%
echo.
if not "%RESULT_CHECK%"=="passed" goto :fail
if not "%RESULT_UNIT%"=="passed" goto :fail
if "%RESULT_E2E%"=="passed" goto :done
if "%RESULT_E2E%"=="SKIPPED" goto :done
goto :fail

rem --- Doctor -------------------------------------------------------------------
:doctor_only
node "%DOCTOR%" check
if errorlevel 1 goto :fail
goto :done

:done
if not defined SORTEA_NO_PAUSE pause
exit /b 0

:fail
echo.
echo The launcher stopped. Check the message above.
if not defined SORTEA_NO_PAUSE pause
exit /b 1

rem Starts api + worker + web in their own window unless they already answer,
rem then waits until both answer. Exits 1 when they do not come up in time.
:ensure_stack
node "%DOCTOR%" wait "%API_HEALTH%" "%WEB_HEALTH%" --timeout=2 >nul 2>nul
if not errorlevel 1 (
  echo   The stack is already running.
  exit /b 0
)
start "%STACK_TITLE%" /D "%REPO_ROOT%" cmd /k pnpm dev
echo   Waiting for api :%API_PORT% and web :5173 (up to 120s)...
node "%DOCTOR%" wait "%API_HEALTH%" "%WEB_HEALTH%" --timeout=120
if errorlevel 1 (
  echo ERROR: The stack did not answer in time. Check the "%STACK_TITLE%" window.
  exit /b 1
)
echo   api and web are answering.
exit /b 0
