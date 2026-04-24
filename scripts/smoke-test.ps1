# smoke-test.ps1 — verificacion end-to-end del ambiente del starter (Windows PowerShell).
#
# Uso:
#   .\scripts\smoke-test.ps1                             # dry-run (default)
#   .\scripts\smoke-test.ps1 -Live                       # ademas: curl Hub + MCP Skill Server
#   .\scripts\smoke-test.ps1 -Live -Jwt "<token>"        # ademas: validacion de licencia
#
# Exit codes:
#   0 = PASS (todos los checks OK)
#   1 = FAIL (1 o mas checks fallaron)
#   2 = ERROR (problema ejecutando el script)

[CmdletBinding()]
param(
    [switch]$Live,
    [string]$Jwt = ""
)

$ErrorActionPreference = "Continue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
Set-Location $rootDir

$script:Pass = 0
$script:Fail = 0
$script:Skip = 0
$script:FailMsgs = @()

function Pass-Check {
    param([string]$Msg)
    Write-Host "  [PASS] $Msg" -ForegroundColor Green
    $script:Pass++
}

function Fail-Check {
    param([string]$Msg, [string]$Reason)
    Write-Host "  [FAIL] $Msg — $Reason" -ForegroundColor Red
    $script:Fail++
    $script:FailMsgs += "$Msg — $Reason"
}

function Skip-Check {
    param([string]$Msg, [string]$Reason)
    Write-Host "  [SKIP] $Msg — $Reason" -ForegroundColor Yellow
    $script:Skip++
}

$mode = if ($Live) { "LIVE" } else { "DRY-RUN" }
Write-Host "== smoke-test del starter — $mode ==" -ForegroundColor Cyan
Write-Host ""

# ----- 1. Prerrequisitos -----
Write-Host "[1/5] Prerrequisitos de ambiente"

try {
    $nodeVer = (& node -v) 2>$null
    if ($nodeVer -match 'v(\d+)\.') {
        $major = [int]$Matches[1]
        if ($major -ge 20) {
            Pass-Check "Node $nodeVer"
        } else {
            Fail-Check "Node >= 20" "detectado $nodeVer, se requiere 20+"
        }
    } else {
        Fail-Check "Node 20+" "salida inesperada: $nodeVer"
    }
} catch {
    Fail-Check "Node 20+" "no instalado en PATH"
}

try {
    $dockerVer = (& docker --version) 2>$null
    if ($dockerVer) {
        Pass-Check "Docker ($dockerVer) (opcional — no requerido en tier SaaS)"
    } else {
        Skip-Check "Docker" "no instalado — OK en tier SaaS (solo requerido para Suite on-premise)"
    }
} catch {
    Skip-Check "Docker" "no instalado — OK en tier SaaS (solo requerido para Suite on-premise)"
}

try {
    $claudeVer = (& claude --version 2>$null | Select-Object -First 1)
    if ($claudeVer) {
        Pass-Check "Claude Code ($claudeVer)"
    } else {
        Pass-Check "Claude Code (instalado)"
    }
} catch {
    Fail-Check "Claude Code" "no instalado en PATH — ver https://claude.ai/code"
}

try {
    $null = (& openssl version) 2>$null
    Pass-Check "openssl disponible (para generar secretos)"
} catch {
    Fail-Check "openssl" "no instalado — necesario para generar JWT/VAULT keys"
}

# ----- 2. Archivos del starter -----
Write-Host ""
Write-Host "[2/5] Archivos del starter"

if (Test-Path "project.config.yaml")        { Pass-Check "project.config.yaml" }        else { Fail-Check "project.config.yaml" "no existe en la raiz" }
if (Test-Path "setup.ps1")                   { Pass-Check "setup.ps1" }                   else { Fail-Check "setup.ps1" "falta" }
if (Test-Path "docker/Dockerfile.pasoe")     { Pass-Check "docker/Dockerfile.pasoe (build CI/CD)" } else { Fail-Check "docker/Dockerfile.pasoe" "falta" }
if (Test-Path ".claude")                     { Pass-Check ".claude/ existe" }             else { Fail-Check ".claude/" "falta — correr .\setup.ps1" }

# ----- 3. Config validation -----
Write-Host ""
Write-Host "[3/5] Validacion de project.config.yaml"

$validatorAvailable = $false
try {
    $null = (& npx --no-install specoe-validate --help 2>$null)
    if ($LASTEXITCODE -eq 0) { $validatorAvailable = $true }
} catch {}

if ($validatorAvailable) {
    try {
        $null = (& npx --no-install specoe-validate project.config.yaml 2>$null)
        if ($LASTEXITCODE -eq 0) {
            Pass-Check "specoe-validate paso (schema Zod OK)"
        } else {
            Fail-Check "specoe-validate" "el yaml no pasa el schema (correr 'npx specoe-validate project.config.yaml' para detalle)"
        }
    } catch {
        Fail-Check "specoe-validate" "error ejecutando el validator"
    }
} else {
    Skip-Check "specoe-validate" "no disponible — instalar @specoe/config-tools para validacion completa"
    # Fallback: chequear 4 secciones obligatorias
    $yamlContent = Get-Content "project.config.yaml" -Raw -ErrorAction SilentlyContinue
    foreach ($section in @("project:", "paths:", "database:", "pasoe:")) {
        if ($yamlContent -match "(?m)^$([regex]::Escape($section))") {
            Pass-Check "Seccion '$($section.TrimEnd(':'))' presente"
        } else {
            Fail-Check "Seccion '$($section.TrimEnd(':'))'" "no encontrada en project.config.yaml"
        }
    }
}

# ----- 4. Credenciales y .mcp.json -----
Write-Host ""
Write-Host "[4/5] Credenciales y MCP config"

if (Test-Path ".mcp.json") {
    Pass-Check ".mcp.json presente"
} elseif (Test-Path ".mcp.json.example") {
    Skip-Check ".mcp.json" "no existe aun — copiar desde .mcp.json.example"
} else {
    Skip-Check ".mcp.json" "sin template .example tampoco"
}

$claudeDir = Join-Path $env:USERPROFILE ".claude"
if (Test-Path (Join-Path $claudeDir "integra-hub-account.json")) {
    Pass-Check "Credenciales del Hub en keyring (hint file presente)"
} elseif (Test-Path (Join-Path $claudeDir "integra-hub.enc")) {
    Pass-Check "Credenciales del Hub en cipher file (fallback)"
} elseif (Test-Path (Join-Path $claudeDir "integra-hub.env")) {
    Skip-Check "Credenciales del Hub" "aun en .env plaintext — correr 'node ~/.claude/scripts/migrate-hub-credentials.mjs'"
} else {
    Fail-Check "Credenciales del Hub" "no hay keyring ni .env — ver QUICKSTART paso 0"
}

# ----- 5. Live checks -----
Write-Host ""
if ($Live) {
    Write-Host "[5/5] Live checks (conectividad)"

    # Extraer hub api-url del yaml (simple regex)
    $yaml = Get-Content "project.config.yaml" -Raw
    $hubUrl = ""
    if ($yaml -match '(?m)^\s*api-url:\s*"?([^"\r\n#]+)"?') {
        $hubUrl = $Matches[1].Trim()
    } elseif ($yaml -match '(?m)^\s*url:\s*"?([^"\r\n#]+)"?') {
        $hubUrl = $Matches[1].Trim()
    }

    if (-not $hubUrl) {
        Fail-Check "Hub URL" "no se pudo extraer de project.config.yaml"
    } else {
        try {
            $resp = Invoke-WebRequest -Uri "$hubUrl/health" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
            if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) {
                Pass-Check "Hub responde $($resp.StatusCode) en $hubUrl/health"
            } else {
                Fail-Check "Hub healthz" "$hubUrl/health respondio $($resp.StatusCode)"
            }
        } catch {
            Fail-Check "Hub healthz" "$hubUrl/health no responde (error: $($_.Exception.Message -replace "`n", " "))"
        }
    }

    if ($Jwt) {
        if ($Jwt -match '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$') {
            Pass-Check "JWT formato valido (3 segmentos)"
            if ($hubUrl) {
                try {
                    $hdrs = @{ Authorization = "Bearer $Jwt" }
                    $resp = Invoke-WebRequest -Uri "$hubUrl/license/validate" -Headers $hdrs -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
                    if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) {
                        Pass-Check "JWT validado contra Hub"
                    } else {
                        Fail-Check "JWT validacion" "Hub respondio $($resp.StatusCode)"
                    }
                } catch {
                    Fail-Check "JWT validacion" "Hub rechazo el token ($($_.Exception.Message -replace "`n", " "))"
                }
            }
        } else {
            Fail-Check "JWT formato" "debe ser 3 segmentos separados por punto"
        }
    } else {
        Skip-Check "JWT validation" "no se paso -Jwt <token>"
    }
} else {
    Write-Host "[5/5] Live checks — SKIPPED (usar -Live para habilitar)"
    Skip-Check "Hub healthz" "dry-run mode"
    Skip-Check "JWT validation" "dry-run mode"
}

# ----- Summary -----
Write-Host ""
Write-Host "=================================================="
$total = $script:Pass + $script:Fail + $script:Skip
Write-Host "  Total: $total checks — PASS: $($script:Pass) | FAIL: $($script:Fail) | SKIP: $($script:Skip)"
Write-Host "=================================================="

if ($script:Fail -eq 0) {
    Write-Host "  RESULTADO: PASS" -ForegroundColor Green
    exit 0
} else {
    Write-Host "  RESULTADO: FAIL" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Checks que fallaron:"
    foreach ($msg in $script:FailMsgs) {
        Write-Host "    - $msg"
    }
    Write-Host ""
    Write-Host "  Ver docs/TROUBLESHOOTING.md para resolucion de cada caso."
    exit 1
}
