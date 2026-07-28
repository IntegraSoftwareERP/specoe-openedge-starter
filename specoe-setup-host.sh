#!/usr/bin/env bash
# specoe-setup-host.sh — Preparación del HOST, 1 vez por máquina (piloto Integra).
#
# Hace lo que NO depende del rol y se comparte entre todos los rooms del dev:
#   1. Pre-req: Node dentro del rango certificado (ver SPECOE_NODE_*), Claude Code, Git.
#   2. Instala el bundle de hooks + npm install (setup.sh --host-only).
#   3. [ELEVADO/UAC] hosts (hub/mcp.integra.local → IP piloto) + CA de Caddy en el trust.
#   4. Copia el CA a ~/.claude (de ahi lo lee ca-channel.mjs, el canal unico de los hooks).
#   5. Verificación del host: ping al server + fetch de prueba al Hub con el CA → confirma
#      que la máquina quedó lista antes de instanciar rooms.
#   6. Login SDD (SPEC-0157): pide tu email + clave del Hub, enrola el equipo y guarda
#      el token de usuario en el keyring. El único paso humano posterior legítimo es que
#      un admin del tenant apruebe el equipo si quedó PENDING.
#
# Después de esto, instanciá cada room con specoe-room-<rol>.sh (o specoe-add-room.sh).
#
# Uso:
#   ./specoe-setup-host.sh [--ip <ip>] [--hub <url>] [--repo <url>] [--skip-elevation] [--skip-login]
#
# Windows es el target del piloto. En Linux/Mac hace 1-2, 5 y 6; hosts + CA (3) se avisan manuales.

set -euo pipefail

PILOT_IP="10.0.10.198"
STARTER_REPO="https://github.com/IntegraSoftwareERP/specoe-openedge-starter.git"
SKIP_ELEVATION=0
SKIP_LOGIN=0
HUB_URL=""

log()  { echo -e "\033[1;34m[specoe-host]\033[0m $*"; }
warn() { echo -e "\033[1;33m[specoe-host]\033[0m $*" >&2; }
err()  { echo -e "\033[1;31m[specoe-host]\033[0m $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ip)   PILOT_IP="$2"; shift 2 ;;
    --hub)  HUB_URL="$2"; shift 2 ;;
    --repo) STARTER_REPO="$2"; shift 2 ;;
    --skip-elevation) SKIP_ELEVATION=1; shift ;;
    --skip-login) SKIP_LOGIN=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) err "Opción desconocida: $1 (ver --help)" ;;
  esac
done

IS_WINDOWS=0
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;; esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")" # ruta absoluta estable (para el comando de retomada)

# ----- Rango de Node certificado (SPEC-0164 P3 / ADR-004) -----
# MEDIDO, no elegido. El canal unico del starter (.claude-bundle/hooks/ca-channel.mjs) se apoya
# en tls.setDefaultCACertificates + tls.getCACertificates. Medicion 2026-07-28, misma maquina:
#   v20.20.2 → ninguna de las dos existe        v22.14.0 / v22.15.0 / v22.18.0 → falta setDefault
#   v22.19.0 → aparecen las dos                 v23.11.1 (ultima 23.x, EOL)    → falta setDefault
#   v24.18.0 · v25.9.0 · v26.5.0 → las dos existen
# Corridas verdes registradas del mecanismo completo: 22.22.2 (suites del bundle, P1/P2) y
# 26.5.0 (VM del incidente). Por eso el rango va de 22.19.0 a 26.x y Node 23 queda AFUERA.
# Antes el preflight pedia ">= 20 sin techo": la VM del incidente corria 26.5.0, dentro de lo
# declarado, y el canal no existia en 20 — un rango sin certificar es una promesa vacia.
# ESTE BLOQUE ESTA DUPLICADO EN setup.sh (:~140). Si cambia acá, cambia allá: los dos son
# entrypoints y el preflight tiene que correr antes de que el starter este en disco.
SPECOE_NODE_MIN="22.19.0"
SPECOE_NODE_MAX_MAJOR="26"

# "22.19.0" → 22019000, para comparar sin depender de sort -V.
specoe_node_num() {
  local a b c
  IFS=. read -r a b c <<<"$1"
  a="${a%%[!0-9]*}"; b="${b%%[!0-9]*}"; c="${c%%[!0-9]*}"
  echo $(( ${a:-0} * 1000000 + ${b:-0} * 1000 + ${c:-0} ))
}

# ----- 1. Pre-req -----
log "Verificando prerrequisitos..."
command -v node >/dev/null 2>&1 || err "node no encontrado. Instalar Node.js del rango certificado ($SPECOE_NODE_MIN a $SPECOE_NODE_MAX_MAJOR.x)."
NODE_VER="$(node -p 'process.versions.node' 2>/dev/null || true)"
NODE_VER="${NODE_VER%%[!0-9.]*}" # corta el \r de Git Bash y cualquier sufijo pre-release
[ -n "$NODE_VER" ] || err "no pude leer la versión de Node (node -p process.versions.node)."
NODE_MAJOR="${NODE_VER%%.*}"
if [ "$(specoe_node_num "$NODE_VER")" -lt "$(specoe_node_num "$SPECOE_NODE_MIN")" ] \
  || [ "$NODE_MAJOR" -gt "$SPECOE_NODE_MAX_MAJOR" ] \
  || [ "$NODE_MAJOR" -eq 23 ]; then
  err "Node v$NODE_VER detectado — FUERA del rango certificado del starter ($SPECOE_NODE_MIN a $SPECOE_NODE_MAX_MAJOR.x; Node 23 queda afuera: no expone tls.setDefaultCACertificates).
  En esta versión el canal TLS de los hooks no puede armarse, así que el room arrancaría sin poder hablar con el Hub.
  Instalá una versión del rango (LTS 22.19+ o 24.x) y volvé a correr este script."
fi
# ADR-004, segunda capa: el numero de version no alcanza. Se comprueba en ESTA version que la
# API sobre la que se apoya el canal exista de verdad — un patch de Node puede sacarla.
node -e "const tls=require('node:tls');process.exit(typeof tls.setDefaultCACertificates==='function'&&typeof tls.getCACertificates==='function'?0:1)" 2>/dev/null \
  || err "Node v$NODE_VER está dentro del rango certificado pero NO expone tls.setDefaultCACertificates/getCACertificates.
  Sin esa API el canal TLS del starter no existe. Reportá esta versión a Integra Software (soporte@integrasoftware.biz) y usá mientras tanto un LTS 22.19+ o 24.x."
command -v git >/dev/null 2>&1 || err "git no encontrado."
command -v claude >/dev/null 2>&1 || warn "Claude Code no está en PATH. Instalalo desde https://claude.ai/code y arrancalo una vez."
log "  Node v$NODE_VER OK (rango certificado $SPECOE_NODE_MIN a $SPECOE_NODE_MAX_MAJOR.x) · git OK"

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

# ----- 4. CA para los hooks Node (lo lee ca-channel.mjs, mecanismo unico del bundle) -----
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
# fetch de prueba al Hub POR EL MISMO CANAL QUE USA EL ROOM: se IMPORTA ca-channel.mjs desde
# ~/.claude/hooks (lo dejó ahí el paso 2) y se ejercitan sus dos funciones — applyCaChannel()
# para el mecanismo y probeCaChannel() para el efecto. NO se reimplementa nada acá: si alguien
# rompe ca-channel.mjs, esta verificación se cae sin tocar el instalador. Y NO se importa
# specoe-license-check.mjs, que corre main() y termina en process.exit() al cargarse.
# Antes esta verificación inyectaba NODE_EXTRA_CA_CERTS en la línea de comando — un camino
# privilegiado que el hook nunca tuvo: daba verde acá y el room igual moría con TLS/401.
# SPEC-0164 P1 (T1.7) migró el mecanismo; P3 (T3.1) le saca el verde falso al veredicto.
set +e
node --input-type=module -e "
  const os = await import('node:os');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const mjs = path.join(os.homedir(), '.claude', 'hooks', 'ca-channel.mjs');
  const { applyCaChannel, probeCaChannel } = await import(pathToFileURL(mjs).href);
  const ca = applyCaChannel();
  if (!ca.ok) {
    console.error('  canal de CA NO aplicado (' + ca.reason + '): ' + (ca.error ?? ca.caPath));
    process.exit(2);
  }
  const probe = await probeCaChannel('https://hub.integra.local/api/v1');
  if (!probe.ok) {
    console.error('  ' + probe.url + ' → ' + (probe.code ?? 'sin código') + ' ' + (probe.error ?? ''));
    process.exit(3);
  }
  console.log('  ' + probe.url + ' responde HTTP ' + probe.status + ' con el CA ' + ca.subject + ' en el store del proceso (' + ca.storeBefore + ' → ' + ca.storeAfter + ' certs)');
"
CHANNEL_RC=$?
set -e
if [ "$CHANNEL_RC" -eq 0 ]; then
  log "  canal verificado por el mismo mecanismo que usa el room (ca-channel.mjs) — hosts + CA + TLS válidos."
else
  # Aborto, NO warn: acá es donde la VM del incidente siguió de largo y terminó imprimiendo
  # "Host listo" con el canal roto. Nombra el paso, declara lo que YA quedó aplicado, y da el
  # comando de retomada que no vuelve a disparar la elevación UAC (--skip-elevation).
  RESUME_CMD="$SELF --skip-elevation --ip $PILOT_IP"
  [ -n "$HUB_URL" ] && RESUME_CMD="$RESUME_CMD --hub $HUB_URL"
  case "$CHANNEL_RC" in
    2) CHANNEL_WHY="el CA no quedó en el store del proceso (mecanismo)" ;;
    3) CHANNEL_WHY="el CA quedó aplicado pero el request al Hub no llegó (efecto — el código está arriba)" ;;
    *) CHANNEL_WHY="la verificación del canal no pudo ejecutarse (¿falta ~/.claude/hooks/ca-channel.mjs?)" ;;
  esac
  # Lo aplicado depende de por dónde vino la corrida: declararlo de más sería el mismo verde
  # falso en otra forma (el dev daría por hecho el trust del SO que nunca se tocó).
  APPLIED="bundle de hooks en ~/.claude y CA en ~/.claude/caddy-local-root.crt"
  if [ "$SKIP_ELEVATION" -eq 1 ]; then
    APPLIED="$APPLIED. NO se tocaron hosts ni el trust del SO (corriste --skip-elevation)"
  elif [ "$IS_WINDOWS" -eq 1 ]; then
    APPLIED="$APPLIED, entradas de hosts para hub/mcp.integra.local y CA de Caddy en el trust de Windows"
  else
    APPLIED="$APPLIED. hosts + CA en el trust del SO quedaron a tu cargo (no-Windows)"
  fi
  err "PASO 5 (verificación del canal) FALLÓ: $CHANNEL_WHY. El host NO está listo — el room arrancaría con TLS/401 en VSCode.
  Lo que YA quedó aplicado en esta máquina (no hay que rehacerlo): $APPLIED.
  Lo que FALTA: el login SDD (paso 6).
  Revisá VPN/red del piloto y que hub.integra.local resuelva a $PILOT_IP; después retomá SIN volver a pedir elevación con:
    $RESUME_CMD"
fi

# ----- 6. Login SDD (SPEC-0157 — identidad por usuario) -----
if [ "$SKIP_LOGIN" -eq 1 ]; then
  warn "--skip-login: NO hago el login SDD. Sin él, el MCP integra-hub no opera — corré ./setup.sh --login cuando puedas."
else
  log "Login SDD (identidad por usuario contra el Hub)..."
  LOGIN_ARGS=(--login)
  [ -n "$HUB_URL" ] && LOGIN_ARGS+=(--hub "$HUB_URL")
  ( cd "$STARTER_DIR" && bash setup.sh "${LOGIN_ARGS[@]}" ) \
    || err "El login SDD falló. Corregí lo indicado arriba y reintentá con: (cd $STARTER_DIR && ./setup.sh --login)"
fi

log ""
log "==================================================================="
log " Host listo (bundle + CA + login SDD). Instanciá cada room (1 vez por rol):"
log "   ./specoe-room-discovery.sh   <license-key-discovery>"
log "   ./specoe-room-engineering.sh <license-key-engineering>"
log "   ./specoe-room-adversarial.sh <license-key-adversarial>"
log "   ./specoe-room-ccdev.sh       <license-key-ccdev>"
log " Si el equipo quedó PENDING, un admin del tenant lo aprueba en el Hub"
log " (Administración → SDD → Equipos autorizados) — único paso humano restante."
log "==================================================================="
