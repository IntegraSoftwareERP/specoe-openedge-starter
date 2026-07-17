#!/usr/bin/env bash
# specoe-setup-host.sh — Preparación del HOST, 1 vez por máquina (piloto Integra).
#
# Hace lo que NO depende del rol y se comparte entre todos los rooms del dev:
#   1. Pre-req: Node 20+, Claude Code, Git.
#   2. Instala el bundle de hooks + npm install (setup.sh --host-only).
#   3. [ELEVADO/UAC] hosts (hub/mcp.integra.local → IP piloto) + CA de Caddy en el trust.
#   4. Copia el CA a ~/.claude (NODE_EXTRA_CA_CERTS para los hooks Node).
#   5. Verificación del host: ping al server + fetch de prueba al Hub con el CA → confirma
#      que la máquina quedó lista antes de instanciar rooms.
#
# Después de esto, instanciá cada room con specoe-room-<rol>.sh (o specoe-add-room.sh).
#
# Uso:
#   ./specoe-setup-host.sh [--ip <ip>] [--repo <url>] [--skip-elevation]
#
# Windows es el target del piloto. En Linux/Mac hace 1-2 y 5; hosts + CA (3) se avisan manuales.

set -euo pipefail

PILOT_IP="10.0.10.198"
STARTER_REPO="https://github.com/IntegraSoftwareERP/specoe-openedge-starter.git"
SKIP_ELEVATION=0

log()  { echo -e "\033[1;34m[specoe-host]\033[0m $*"; }
warn() { echo -e "\033[1;33m[specoe-host]\033[0m $*" >&2; }
err()  { echo -e "\033[1;31m[specoe-host]\033[0m $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ip)   PILOT_IP="$2"; shift 2 ;;
    --repo) STARTER_REPO="$2"; shift 2 ;;
    --skip-elevation) SKIP_ELEVATION=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) err "Opción desconocida: $1 (ver --help)" ;;
  esac
done

IS_WINDOWS=0
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;; esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ----- 1. Pre-req -----
log "Verificando prerrequisitos..."
command -v node >/dev/null 2>&1 || err "node no encontrado. Instalar Node.js 20+."
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\)\..*/\1/')
[ "$NODE_MAJOR" -ge 20 ] || err "Node $NODE_MAJOR detectado. Se requiere 20+."
command -v git >/dev/null 2>&1 || err "git no encontrado."
command -v claude >/dev/null 2>&1 || warn "Claude Code no está en PATH. Instalalo desde https://claude.ai/code y arrancalo una vez."
log "  Node $(node -v) OK · git OK"

# El bundle + el CA viven en el starter. Si no estamos parados en uno, clonamos uno base.
if [ -f "$SCRIPT_DIR/setup.sh" ] && [ -d "$SCRIPT_DIR/certs" ]; then
  STARTER_DIR="$SCRIPT_DIR"
elif [ -f "./specoe-starter/setup.sh" ]; then
  STARTER_DIR="$(cd ./specoe-starter && pwd)"
else
  log "Clonando el starter base en ./specoe-starter (para el bundle + el CA)..."
  git clone --depth 1 "$STARTER_REPO" ./specoe-starter
  STARTER_DIR="$(cd ./specoe-starter && pwd)"
fi

# ----- 2. Bundle de hooks + npm install (parte de máquina) -----
log "Instalando el bundle de hooks (setup.sh --host-only)..."
( cd "$STARTER_DIR" && bash setup.sh --host-only )

CA_SRC="$STARTER_DIR/certs/caddy-root-ca.crt"
[ -f "$CA_SRC" ] || warn "No encontré el CA en $CA_SRC — el paso del trust puede fallar."

# ----- 3. hosts + CA (una sola elevación UAC) -----
if [ "$SKIP_ELEVATION" -eq 1 ]; then
  warn "--skip-elevation: NO toco hosts ni instalo el CA. Asegurate de tenerlos hechos."
elif [ "$IS_WINDOWS" -eq 1 ]; then
  log "hosts + CA requieren admin → va a saltar UNA ventana de elevación (UAC). Aceptala."
  CA_WIN="$(cygpath -w "$CA_SRC")"
  ELEV_PS1="$(mktemp -t specoe-elev-XXXX.ps1)"
  cat > "$ELEV_PS1" <<PS1
\$ErrorActionPreference = 'Stop'
\$ip = '$PILOT_IP'
\$hostsFile = 'C:\Windows\System32\drivers\etc\hosts'
\$names = @('hub.integra.local','mcp.integra.local')
\$content = ''
if (Test-Path \$hostsFile) { \$content = Get-Content \$hostsFile -Raw }
foreach (\$n in \$names) {
  if (\$content -match ('(?m)^\s*[0-9.]+\s+' + [regex]::Escape(\$n) + '\s*\$')) {
    Write-Host "[hosts] ya existe: \$n"
  } else {
    Add-Content -Path \$hostsFile -Value ("\$ip \$n")
    Write-Host "[hosts] + \$ip \$n"
  }
}
& certutil -addstore -f Root '$CA_WIN' | Out-Null
Write-Host "[CA] instalado en 'Entidades de certificacion raiz de confianza'"
PS1
  ELEV_WIN="$(cygpath -w "$ELEV_PS1")"
  powershell.exe -NoProfile -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','$ELEV_WIN'" \
    || err "La elevación falló o fue cancelada. Reintentá o corré hosts + CA a mano (ver QUICKSTART-VSCODE.md)."
  rm -f "$ELEV_PS1"
  log "  hosts + CA aplicados."
else
  warn "hosts + CA: hacelos a mano (no-Windows). hosts: $PILOT_IP hub.integra.local / mcp.integra.local. CA: importá $CA_SRC al trust del SO."
fi

# ----- 4. CA para los hooks Node (NODE_EXTRA_CA_CERTS + fallback del dispatcher) -----
if [ -f "$CA_SRC" ]; then
  mkdir -p "$HOME/.claude"
  cp "$CA_SRC" "$HOME/.claude/caddy-local-root.crt"
  log "  CA copiado a ~/.claude/caddy-local-root.crt."
fi

# ----- 5. Verificación del host -----
log "Verificando el host..."
PING_FLAG="-c"
[ "$IS_WINDOWS" -eq 1 ] && PING_FLAG="-n"
if ping $PING_FLAG 1 "$PILOT_IP" >/dev/null 2>&1; then
  log "  ping $PILOT_IP OK"
else
  warn "  ping $PILOT_IP sin respuesta (¿VPN / red del piloto?)"
fi
# fetch de prueba al Hub con el CA (en CLI NODE_EXTRA_CA_CERTS sí llega): confirma hosts + CA + TLS.
if NODE_EXTRA_CA_CERTS="$HOME/.claude/caddy-local-root.crt" \
   node -e "fetch('https://hub.integra.local/api/v1').then(r=>{console.log('  Hub responde status',r.status);process.exit(0)}).catch(e=>{console.error('  '+e.message);process.exit(1)})"; then
  log "  fetch a https://hub.integra.local OK — hosts + CA + TLS válidos."
else
  warn "  fetch al Hub FALLÓ — revisá que hosts + CA se aplicaron (el room daría TLS/401 en VSCode)."
fi

log ""
log "==================================================================="
log " Host listo. Instanciá cada room (1 vez por rol):"
log "   ./specoe-room-discovery.sh   <license-key-discovery>"
log "   ./specoe-room-engineering.sh <license-key-engineering>"
log "   ./specoe-room-adversarial.sh <license-key-adversarial>"
log "   ./specoe-room-ccdev.sh       <license-key-ccdev>"
log "==================================================================="
