# SpecOE OpenEdge Starter — setup para Windows PowerShell.
#
# Uso:
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\setup.ps1                                   # default: usa hub.api-url del yaml
#   .\setup.ps1 -Hub https://hub.mi-org.com       # override: apunta a otra instancia
#
# Modelo de deploy:
#   - Piloto interno (default): Hub en hub.integra.local (VPN de Integra).
#     Sin Docker en el cliente.
#   - Suite on-premise: cliente ejecuta Hub + Skill Server en su infra.
#     Contactar a Integra Software para detalles del tier.

[CmdletBinding()]
param(
    [string]$Hub = ""
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Log { param([string]$msg) Write-Host "[specoe-setup] $msg" -ForegroundColor Cyan }
function Warn { param([string]$msg) Write-Host "[specoe-setup] $msg" -ForegroundColor Yellow }
function Fail { param([string]$msg) Write-Host "[specoe-setup] $msg" -ForegroundColor Red; exit 1 }

# ----- 1. Prereqs -----

Log "Verificando prerrequisitos..."

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "node no encontrado. Instalar Node.js 20+." }

$nodeVersion = (node -v) -replace '^v', ''
$nodeMajor = [int]($nodeVersion -split '\.')[0]
if ($nodeMajor -lt 20) { Fail "Node $nodeMajor detectado. Se requiere 20+." }

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) { Warn "Claude Code no encontrado en PATH. Instalar desde https://claude.ai/code" }

if (-not (Test-Path project.config.yaml)) { Fail "project.config.yaml no existe en este directorio." }

# ----- 1.5. Instalar bundle .claude (SPEC-0023 F6) -----
# Idempotente: copia hooks + scripts del bundle a $HOME\.claude\. NO pisa archivos existentes.
# Sin esto, los comandos del flow SpecOE (license check, hub auth, migrate credentials) no funcionan.

Log "Instalando .claude bundle..."

$ClaudeHome = Join-Path $HOME ".claude"
$BundleDir  = Join-Path $PSScriptRoot ".claude-bundle"

if (-not (Test-Path $BundleDir)) {
    Warn ".claude-bundle no existe en el starter -- saltando install. Si Claude Code no autentica al Hub, contactar a Integra Software."
} else {
    foreach ($sub in @("hooks", "scripts")) {
        $dir = Join-Path $ClaudeHome $sub
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    }

    function Install-IfAbsent {
        param([string]$Src, [string]$Dst)
        if (-not (Test-Path $Src)) {
            Warn "  [MISSING] $Src -- bundle incompleto"
            return
        }
        if (-not (Test-Path $Dst)) {
            Copy-Item -Path $Src -Destination $Dst -Force
            Log "  [INSTALL] $Dst"
        } else {
            Log "  [SKIP]    $Dst (ya existe)"
        }
    }

    Install-IfAbsent (Join-Path $BundleDir "hooks\credentials.mjs")               (Join-Path $ClaudeHome "hooks\credentials.mjs")
    Install-IfAbsent (Join-Path $BundleDir "hooks\integra-hub-auth.mjs")          (Join-Path $ClaudeHome "hooks\integra-hub-auth.mjs")
    Install-IfAbsent (Join-Path $BundleDir "hooks\specoe-license-check.mjs")      (Join-Path $ClaudeHome "hooks\specoe-license-check.mjs")
    Install-IfAbsent (Join-Path $BundleDir "hooks\package.json")                  (Join-Path $ClaudeHome "hooks\package.json")
    Install-IfAbsent (Join-Path $BundleDir "hooks\package-lock.json")             (Join-Path $ClaudeHome "hooks\package-lock.json")
    Install-IfAbsent (Join-Path $BundleDir "scripts\migrate-hub-credentials.mjs") (Join-Path $ClaudeHome "scripts\migrate-hub-credentials.mjs")

    # Instalar dependencias del keyring si nunca se hizo (idempotente: skipea si node_modules existe).
    $hooksPkg = Join-Path $ClaudeHome "hooks\package.json"
    $hooksMods = Join-Path $ClaudeHome "hooks\node_modules"
    if ((Test-Path $hooksPkg) -and -not (Test-Path $hooksMods)) {
        Log "  Instalando dependencias del keyring (npm install)..."
        Push-Location (Join-Path $ClaudeHome "hooks")
        try {
            npm install --silent | Out-Null
            if ($LASTEXITCODE -ne 0) { Warn "  npm install fallo -- los hooks pueden no funcionar hasta resolverlo" }
        } finally {
            Pop-Location
        }
    }
}

# ----- 2. Override hub.api-url si se paso -Hub -----

if ($Hub) {
    Log "Actualizando hub.api-url a $Hub en project.config.yaml..."
    $yamlContent = Get-Content project.config.yaml -Raw
    if ($yamlContent -match '(?m)^\s*api-url:') {
        $yamlContent = [regex]::Replace(
            $yamlContent,
            '(?m)^(\s*)api-url:.*$',
            { param($m) "$($m.Groups[1].Value)api-url: `"$Hub`"" }
        )
        Set-Content project.config.yaml -Value $yamlContent -NoNewline
    } else {
        Warn "No se encontro 'api-url:' en project.config.yaml. Agregar manualmente bajo 'hub:'."
    }
}

# ----- 3. Validar config -----

Log "Validando project.config.yaml..."
$yaml = Get-Content project.config.yaml -Raw
foreach ($field in @("name:", "vendor:", "logical-name:", "instance-name:")) {
    $match = [regex]::Match($yaml, "^\s*${field}\s*(.*)$", 'Multiline')
    if (-not $match.Success -or [string]::IsNullOrWhiteSpace(($match.Groups[1].Value -replace '"', '').Trim())) {
        Fail "Campo obligatorio vacio: $field — editar project.config.yaml"
    }
}

Log "Config basica: campos obligatorios presentes."
Warn "  ATENCION: este check solo verifica que los campos NO esten vacios."
Warn "  Si project.config.yaml tiene los valores de template ('MiCliente ERP', 'oepas1', etc.) sin editar,"
Warn "  este check pasa pero el resto del flow puede fallar. Editar el yaml en Paso 3 y validar real con smoke-test (Paso 5)."

# ----- 4. License -----

$licenseKey = $env:SPECOE_LICENSE_KEY
if (-not $licenseKey) {
    $match = [regex]::Match($yaml, '^\s*key:\s*"?([^"\r\n]*)"?$', 'Multiline')
    if ($match.Success) { $licenseKey = $match.Groups[1].Value.Trim() }
}
if (-not $licenseKey) {
    Warn "No hay license key en env ni en yaml. Modo 'solo skills libres' activado."
    Warn "Para licencia completa, setear license.key o `$env:SPECOE_LICENSE_KEY."
} else {
    $preview = $licenseKey.Substring(0, [Math]::Min(12, $licenseKey.Length))
    Log "License detectada: $preview..."
}

# ----- 5. Setup Claude Code hooks -----

Log "Configurando .claude/ local..."
if (-not (Test-Path .claude)) { New-Item -ItemType Directory -Path .claude | Out-Null }
if (-not (Test-Path .claude/settings.json)) { Warn ".claude/settings.json no existe — se esperaba estar en el starter." }

# ----- 6. Next steps -----

Log "Setup base completado."
Log ""
Log "Proximos pasos:"
Log "  1. Revisar y completar project.config.yaml"
Log "  2. Activar license (el SessionStart hook lo hace automaticamente al abrir Claude Code)"
Log "  3. Iniciar Claude Code: claude"
Log "  4. Ver docs/QUICKSTART.md para el primer entity de ejemplo"
Log ""
$yamlReload = Get-Content project.config.yaml -Raw
$hubMatch = [regex]::Match($yamlReload, '(?m)^\s*api-url:\s*"?([^"\r\n#]+)"?')
$currentHub = if ($hubMatch.Success) { $hubMatch.Groups[1].Value.Trim() } else { "<no configurado>" }
Log "Hub: $currentHub"
Log "(default piloto interno: hub.integra.local. Suite on-premise: contactar a Integra Software)"
