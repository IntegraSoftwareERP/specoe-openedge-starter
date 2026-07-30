#!/usr/bin/env bash
# SpecOE OpenEdge Starter — setup para Linux / macOS / Git Bash Windows.
#
# Uso:
#   ./setup.sh                    # todo: bundle (máquina) + login SDD (usuario) + config de la carpeta (room)
#   ./setup.sh --hub <url>        # override de la URL del Hub (login + hub.api-url)
#   ./setup.sh --host-only        # solo la parte de máquina (pre-req + bundle + npm; SIN login — red no requerida)
#   ./setup.sh --login            # solo el login SDD (pide email + clave, enrola el equipo, guarda tokens en keyring)
#   ./setup.sh --room-only        # solo la parte de carpeta (config + .mcp.json)
#   ./setup.sh --skip-login       # corrida completa sin el paso de login
#
# --host-only / --room-only separan lo que se hace 1 vez por máquina de lo que se hace 1 vez
# por room (ver specoe-setup-host.sh + specoe-add-room.sh). Sin flags = todo (retrocompat).
#
# Identidad (SPEC-0157): el starter pide Hub URL + email + clave, llama
# POST /auth/sdd/login y guarda el UserSddToken + machineId en el keyring del SO
# (canal secrets.mjs). NINGÚN secreto queda en archivos: ni act-as, ni cuid de
# tenant — el tenant lo resuelve el server a partir del token. El rol es config
# de la carpeta (INTEGRA_SDD_ROLE en .mcp.json) y viaja como claim sin firma;
# el Hub lo autoriza server-side contra los roles concedidos a tu usuario.
# Credenciales no interactivas (CI/automación): INTEGRA_HUB_EMAIL +
# INTEGRA_HUB_PASSWORD + INTEGRA_HUB_API_URL en el entorno.
#
# Modelo de deploy:
#   - Piloto interno (default): Hub en hub.integra.local (VPN de Integra). Sin Docker.
#   - Suite on-premise: cliente ejecuta Hub + Skill Server en su infra (contactar a Integra).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")" # ruta absoluta estable tras el cd (para --help)
cd "$SCRIPT_DIR"

log() { echo -e "\033[1;34m[specoe-setup]\033[0m $*"; }
warn() { echo -e "\033[1;33m[specoe-setup]\033[0m $*" >&2; }
err() { echo -e "\033[1;31m[specoe-setup]\033[0m $*" >&2; exit 1; }

# Repo del starter, para las remediaciones que mandan al canal de HOST (SPEC-0167 P3): el
# instalador de maquina —specoe-setup-host.sh, certs/— NO esta dentro de la carpeta del room,
# asi que nombrarlo con './' manda al dev a un archivo que no existe. Mismo default que
# specoe-setup-host.sh y specoe-add-room.sh.
SPECOE_STARTER_REPO="${SPECOE_STARTER_REPO:-https://github.com/IntegraSoftwareERP/specoe-openedge-starter.git}"

# Binario de Node a usar para lo que toca el keyring / el bundle.
# En Git Bash, `node` está envuelto por winpty y eso rompe la carga del módulo NATIVO
# @napi-rs/keyring → `node.exe` bypassa el wrapper (TKT-0200).
# PERO en WSL el `node.exe` de Windows también aparece en el PATH (interop) y recibe rutas
# Unix que interpreta como Windows (/home/x → C:\home\x) → MODULE_NOT_FOUND en sdd-login.mjs.
# En WSL no hay winpty, así que ahí va el `node` de Linux. (TKT-0217)
specoe_node_bin() {
  if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
    echo node
  elif command -v node.exe >/dev/null 2>&1; then
    echo node.exe
  else
    echo node
  fi
}

# ----- Rango de Node certificado (SPEC-0164 P3 / ADR-004) -----
# MEDIDO, no elegido. El canal único del starter (.claude-bundle/hooks/ca-channel.mjs) se apoya
# en tls.setDefaultCACertificates + tls.getCACertificates. Medición 2026-07-28, misma máquina:
#   v20.20.2 → ninguna de las dos existe        v22.14.0 / v22.15.0 / v22.18.0 → falta setDefault
#   v22.19.0 → aparecen las dos                 v23.11.1 (última 23.x, EOL)    → falta setDefault
#   v24.18.0 · v25.9.0 · v26.5.0 → las dos existen
# Corridas verdes registradas del mecanismo completo: 22.22.2 (suites del bundle, P1/P2) y
# 26.5.0 (VM del incidente). Por eso el rango va de 22.19.0 a 26.x y Node 23 queda AFUERA.
# Antes el preflight pedía ">= 20 sin techo": la VM del incidente corría 26.5.0, dentro de lo
# declarado, y el canal no existía en 20 — un rango sin certificar es una promesa vacía.
# ESTE BLOQUE ESTÁ DUPLICADO EN specoe-setup-host.sh (:~51). Si cambia acá, cambia allá: los
# dos son entrypoints y el preflight corre antes de que el otro archivo esté garantizado.
SPECOE_NODE_MIN="22.19.0"
SPECOE_NODE_MAX_MAJOR="26"

# "22.19.0" → 22019000, para comparar sin depender de sort -V.
specoe_node_num() {
  local a b c
  IFS=. read -r a b c <<<"$1"
  a="${a%%[!0-9]*}"; b="${b%%[!0-9]*}"; c="${c%%[!0-9]*}"
  echo $(( ${a:-0} * 1000000 + ${b:-0} * 1000 + ${c:-0} ))
}

# CA local del piloto para el TLS del Hub. specoe-setup-host.sh lo deja en ~/.claude, pero
# si se corrió solo `setup.sh --login` no está y el login moría con
# UNABLE_TO_GET_ISSUER_CERT_LOCALLY sin decir de dónde sacarlo. El starter trae el CA en
# certs/, así que lo instalamos nosotros. Devuelve la ruta (vacío si no hay CA). (TKT-0217)
# SPEC-0167 P3: en una carpeta de room recortada NO hay certs/ (es material de máquina), así
# que ahí esta función solo puede devolver el CA que ya dejó el setup del host en ~/.claude.
#
# SPEC-0164 P3 (T3.2): la copia es INCONDICIONAL. Antes estaba condicionada a que el destino
# NO existiera, así que un .crt viejo, truncado o de otro emisor sobrevivía invisible: el
# archivo estaba, el canal fallaba igual y nada lo declaraba. La fuente canónica es el starter.
# Efecto colateral aceptado: si alguien reemplazó el .crt a mano a propósito, se pierde.
# OJO: esta función se usa como $(specoe_local_ca) — todo lo informativo va por `warn` (stderr),
# nunca por `log`, o contamina la ruta que devuelve.
specoe_local_ca() {
  local dst="$HOME/.claude/caddy-local-root.crt"
  local src="$SCRIPT_DIR/certs/caddy-root-ca.crt"
  if [ -f "$src" ]; then
    mkdir -p "$HOME/.claude"
    if ! cmp -s "$src" "$dst" 2>/dev/null; then
      warn "  CA local ausente o distinto al del starter — lo reemplazo desde $src en $dst."
    fi
    cp "$src" "$dst"
  fi
  # return 0 explícito: con set -e, un [ -f ] falso haría abortar al asignar $(specoe_local_ca).
  if [ -f "$dst" ]; then echo "$dst"; fi
  return 0
}

# ----- Lectura de un campo del yaml ANCLADA a su seccion (SPEC-0167 P2, T2.1) -----
# `specoe_yaml_get <archivo> <seccion>.<clave>` devuelve el valor de la clave DENTRO del
# bloque de su seccion. El validador de config leia el ultimo segmento del nombre con
# `grep -E "^\s*<clave>:" | head -1` sobre el archivo ENTERO: eso agarra la PRIMERA
# coincidencia en orden de archivo, asi que una clave homonima ubicada ANTES del campo
# objetivo gana y el check evalua un campo distinto del que declara evaluar. Andaba por el
# orden de las claves del template, no por construccion.
# Devuelve vacio si la seccion o la clave no estan. Quita comillas y comentario inline.
specoe_yaml_get() {
  local file="$1" section="${2%%.*}" key="${2#*.}"
  [ -f "$file" ] || return 0
  awk -v sec="$section" -v key="$key" -v q="'" '
    # Toda linea sin indentar abre un bloque top-level (y cierra el anterior).
    /^[^[:space:]]/ { inblock = (index($0, sec ":") == 1); next }
    !inblock { next }
    $0 !~ "^[[:space:]]+" key ":" { next }
    {
      v = $0
      sub("^[[:space:]]+" key ":[[:space:]]*", "", v)
      if (substr(v, 1, 1) == q) {                       # valor entre comillas simples
        v = substr(v, 2); i = index(v, q); if (i > 0) v = substr(v, 1, i - 1)
      } else if (substr(v, 1, 1) == "\"") {             # entre comillas dobles
        v = substr(v, 2); i = index(v, "\""); if (i > 0) v = substr(v, 1, i - 1)
      } else {                                          # pelado, con comentario inline opcional
        sub(/[[:space:]]*#.*$/, "", v); sub(/[[:space:]]+$/, "", v)
      }
      print v
      exit
    }
  ' "$file"
}

# ----- Universo del check de config (SPEC-0167 P2, ADR-003) -----
# CINCO campos. `paths.workspace-root` entra porque es un path absoluto al workspace del
# cliente: dejarlo en el valor del template apunta a una ruta que no existe en la maquina.
# Deliberadamente AFUERA: `specoe.role` y `hub.api-url`, porque los reescribe el propio
# instalador antes de que el check corra (el sed de specoe-add-room.sh y el de --hub de mas
# abajo). Compararlos daria falso positivo sobre una instalacion sana.
SPECOE_CONFIG_FIELDS="project.name project.vendor paths.workspace-root database.logical-name pasoe.instance-name"

# Fallback declarado de ADR-003: sentinelas literales del template, para cuando el yaml
# versionado del clone no se puede leer. Se desincronizan en silencio si el template cambia
# — por eso es fallback y por eso el check declara en la salida cuando corre por aca.
specoe_config_sentinel() {
  case "$1" in
    project.name) echo "MiCliente ERP" ;;
    project.vendor) echo "MiCliente SA" ;;
    paths.workspace-root) echo "C:/MiCliente/VSCode" ;;
    database.logical-name) echo "clientedb" ;;
    pasoe.instance-name) echo "oepas1" ;;
  esac
}

# ----- 0. Parse argumentos -----

HUB_URL=""
DO_HOST=1  # parte de máquina: pre-req + bundle de hooks + npm install
DO_LOGIN=1 # parte de usuario: login SDD (enrola equipo + tokens al keyring)
DO_ROOM=1  # parte de carpeta: config + .mcp.json
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub)
      HUB_URL="$2"
      shift 2
      ;;
    --host-only) # solo la parte de máquina (sin red: el login va después, ver specoe-setup-host.sh)
      DO_ROOM=0
      DO_LOGIN=0
      shift
      ;;
    --login) # solo el login SDD
      DO_HOST=0
      DO_ROOM=0
      shift
      ;;
    --room-only) # solo la parte de carpeta
      DO_HOST=0
      DO_LOGIN=0
      shift
      ;;
    --skip-login) # corrida completa sin login
      DO_LOGIN=0
      shift
      ;;
    --help | -h)
      sed -n '2,/^set -euo pipefail/p' "$SELF" | sed '$d'
      exit 0
      ;;
    *)
      err "Argumento desconocido: $1 (usar --help)"
      ;;
  esac
done

[ "$DO_HOST" = 1 ] || [ "$DO_ROOM" = 1 ] || [ "$DO_LOGIN" = 1 ] || err "--host-only, --login y --room-only son excluyentes."

# `--login` necesita el bundle (sdd-login.mjs vive en ~/.claude/scripts).
#
# SPEC-0167 P3 (T3.4). Antes esto prendía DO_HOST=1 para auto-instalar el bundle desde
# $SCRIPT_DIR/.claude-bundle (TKT-0217). Con la carpeta del room recortada ese directorio ya no
# existe ahi —el bundle es material de HOST y vive en ~/.claude— y la corrida caia en el warn
# ".claude-bundle no existe en el starter — saltando install", SEGUIA, y el login moria varias
# lineas mas abajo, lejos de la causa. `./setup.sh --login` es la remediacion exacta de
# MACHINE_NOT_AUTHORIZED: perder su reparacion en un warn no fatal es verde-falso.
# Ahora: o el material esta en ~/.claude y el login sigue, o corta ACA nombrando que correr.
if [ "$DO_LOGIN" = 1 ] && [ "$DO_HOST" = 0 ] && [ ! -f "${SPECOE_SDD_LOGIN_JS:-$HOME/.claude/scripts/sdd-login.mjs}" ]; then
  err "Falta ${SPECOE_SDD_LOGIN_JS:-$HOME/.claude/scripts/sdd-login.mjs}: esta máquina no tiene el bundle de hooks instalado, y sin él no hay login SDD.
  El bundle es de la MÁQUINA, no de esta carpeta: se instala con specoe-setup-host.sh — vive en el starter con el que preparaste la máquina, NO en la carpeta del room.
  Si no lo tenés a mano: git clone --depth 1 $SPECOE_STARTER_REPO specoe-starter && cd specoe-starter && ./specoe-setup-host.sh
  Cuando termine, volvé a esta carpeta y corré ./setup.sh --login"
fi

# ----- 1. Prereqs -----

log "Verificando prerrequisitos..."

if ! command -v node >/dev/null 2>&1; then
  # En WSL el `node.exe` de Windows se ve por el interop, pero no sirve: recibe rutas Unix y
  # las lee como Windows (MODULE_NOT_FOUND). Hace falta Node instalado DENTRO del WSL. (TKT-0217)
  if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
    err "node no encontrado dentro del WSL. El node.exe de Windows NO sirve acá (lee las rutas Unix como Windows). Instalá Node.js del rango certificado ($SPECOE_NODE_MIN a $SPECOE_NODE_MAX_MAJOR.x) en la distro: https://github.com/nodesource/distributions"
  fi
  err "node no encontrado. Instalar Node.js del rango certificado ($SPECOE_NODE_MIN a $SPECOE_NODE_MAX_MAJOR.x)."
fi

# Preflight de versión (SPEC-0164 P3 / ADR-004): rango certificado + comprobación de que la
# API sobre la que se apoya el canal exista en ESTA versión. El detalle de la medición y de
# por qué el rango es ése está en el bloque SPECOE_NODE_* de arriba.
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
node -e "const tls=require('node:tls');process.exit(typeof tls.setDefaultCACertificates==='function'&&typeof tls.getCACertificates==='function'?0:1)" 2>/dev/null \
  || err "Node v$NODE_VER está dentro del rango certificado pero NO expone tls.setDefaultCACertificates/getCACertificates.
  Sin esa API el canal TLS del starter no existe. Reportá esta versión a Integra Software (soporte@integrasoftware.biz) y usá mientras tanto un LTS 22.19+ o 24.x."
log "  Node v$NODE_VER OK (rango certificado $SPECOE_NODE_MIN a $SPECOE_NODE_MAX_MAJOR.x)"

command -v claude >/dev/null 2>&1 || warn "Claude Code no encontrado en PATH. Instalar desde https://claude.ai/code"

# El project.config.yaml solo hace falta para la parte de carpeta (room).
if [ "$DO_ROOM" = 1 ]; then
  [ -f project.config.yaml ] || err "project.config.yaml no existe en este directorio."
fi

# ----- 1.5. Instalar bundle .claude — solo host (parte de máquina) -----
if [ "$DO_HOST" = 1 ]; then
# Copia hooks + scripts del bundle a ~/.claude/. TODO el codigo del producto va con
# install_force (pisa siempre): un dev con el bundle viejo debe recibir los fixes. Se detectó
# que lo que iba con install_if_absent (package.json/lock + hooks de auth) NO llegaba
# a maquinas ya instaladas (patrón recurrente: primero el role-check, despues el license-check,
# despues el package.json). No hay config del usuario acá — las credenciales/licencia viven en
# el keyring/cache — asi que forzar es seguro.

log "Instalando .claude bundle..."

CLAUDE_HOME="$HOME/.claude"
BUNDLE_DIR="$SCRIPT_DIR/.claude-bundle"

if [ ! -d "$BUNDLE_DIR" ]; then
  # SPEC-0167 P3 (T3.4): esto era un warn no fatal y la corrida SEGUIA hasta el mensaje de
  # exito con el bundle sin instalar. Desde el recorte de la carpeta del room, .claude-bundle
  # no esta en un room —es material de MAQUINA y vive en ~/.claude— asi que este camino solo
  # se alcanza pidiendole a una carpeta que haga el trabajo del host. Corta y dice cual es el
  # canal que si existe, en vez de reportar exito sin haber instalado nada.
  err "No hay bundle de hooks en esta carpeta ($BUNDLE_DIR) y esta corrida incluye la parte de MÁQUINA.
  El bundle es de la máquina, no de la carpeta: se instala con specoe-setup-host.sh — vive en el starter con el que preparaste la máquina, NO en la carpeta del room.
  Si no lo tenés a mano: git clone --depth 1 $SPECOE_STARTER_REPO specoe-starter && cd specoe-starter && ./specoe-setup-host.sh
  Si lo que querías era configurar ESTA carpeta, corré ./setup.sh --room-only (y ./setup.sh --login para la identidad SDD)."
else
  mkdir -p "$CLAUDE_HOME/hooks" "$CLAUDE_HOME/scripts"

  # install_force — copia SIEMPRE (pisa el archivo del dev con la version del bundle).
  install_force() {
    local src="$1"
    local dst="$2"
    if [ ! -f "$src" ]; then
      warn "  [MISSING] $src — bundle incompleto"
      return
    fi
    cp "$src" "$dst"
    log "  [FORCE]   $dst"
  }

  # detectar cambio de deps ANTES de pisar el package.json: si el del
  # bundle difiere del instalado (o no habia), corremos npm install si o si. Asi una dep
  # nueva (ej. undici del fix del CA) llega tambien a maquinas con el bundle previo — el
  # gate por-dep no alcanzaba porque el npm install corria con el package.json viejo.
  DEPS_CHANGED=0
  if ! cmp -s "$BUNDLE_DIR/hooks/package.json" "$CLAUDE_HOME/hooks/package.json" 2>/dev/null; then
    DEPS_CHANGED=1
  fi

  # TODO el codigo del producto va force (un dev con un bundle viejo recibe los fixes;
  # install_if_absent no llegaba a bundles ya poblados).
  install_force "$BUNDLE_DIR/hooks/package.json"                  "$CLAUDE_HOME/hooks/package.json"
  install_force "$BUNDLE_DIR/hooks/package-lock.json"             "$CLAUDE_HOME/hooks/package-lock.json"
  # TKT-0221: sin el .npmrc (engine-strict=true) el `engines.node` del package.json de al lado
  # es un cartel, no un gate — npm avisa y sigue. Como el allowlist es POR ARCHIVO, omitirlo aca
  # dejaria el rango declarado sin nada que lo haga cumplir en la maquina del cliente.
  install_force "$BUNDLE_DIR/hooks/.npmrc"                        "$CLAUDE_HOME/hooks/.npmrc"
  install_force "$BUNDLE_DIR/hooks/ca-channel.mjs"                "$CLAUDE_HOME/hooks/ca-channel.mjs"
  install_force "$BUNDLE_DIR/hooks/specoe-role-check.mjs"         "$CLAUDE_HOME/hooks/specoe-role-check.mjs"
  install_force "$BUNDLE_DIR/hooks/specoe-license-check.mjs"      "$CLAUDE_HOME/hooks/specoe-license-check.mjs"
  install_force "$BUNDLE_DIR/hooks/specoe-room-bootstrap.mjs"     "$CLAUDE_HOME/hooks/specoe-room-bootstrap.mjs"
  install_force "$BUNDLE_DIR/hooks/secrets.mjs"                   "$CLAUDE_HOME/hooks/secrets.mjs"
  install_force "$BUNDLE_DIR/hooks/credentials.mjs"               "$CLAUDE_HOME/hooks/credentials.mjs"
  # TKT-0232: lo importan specoe-license-check.mjs (hooks/) y sdd-login.mjs (scripts/). Esta
  # lista es un allowlist por archivo, asi que un modulo nuevo que no se agregue aca NO llega
  # a la maquina y el import falla en la RESOLUCION — antes de que corra el catch del hook,
  # o sea sin mensaje y en cada arranque de Claude Code de esa maquina.
  install_force "$BUNDLE_DIR/hooks/sdd-identity.mjs"              "$CLAUDE_HOME/hooks/sdd-identity.mjs"
  install_force "$BUNDLE_DIR/scripts/provision-secrets.mjs"       "$CLAUDE_HOME/scripts/provision-secrets.mjs"
  install_force "$BUNDLE_DIR/scripts/sdd-login.mjs"               "$CLAUDE_HOME/scripts/sdd-login.mjs"
  # SPEC-0167 P3 (T3.4): el motor del verificador viaja al HOST. Antes no se instalaba en
  # ningun lado y specoe-verify-room.sh lo resolvia dentro de la carpeta del room
  # ($SCRIPT_DIR/.claude-bundle/scripts), que es justo lo que el recorte del room saca. Sus dos
  # imports son relativos a ../hooks/ (ca-channel.mjs y specoe-room-bootstrap.mjs), asi que
  # desde ~/.claude/scripts/ resuelven contra ~/.claude/hooks/, que este mismo bloque puebla.
  install_force "$BUNDLE_DIR/scripts/verify-room-serving.mjs"     "$CLAUDE_HOME/scripts/verify-room-serving.mjs"

  # Dependencias de los hooks. Corremos npm install si cambiaron las deps (DEPS_CHANGED) o si
  # falta node_modules / alguna dep clave (@modelcontextprotocol/sdk del bootstrap, undici del
  # CA dispatcher). DEPS_CHANGED cubre cualquier dep FUTURA sin tocar este gate.
  if [ -f "$CLAUDE_HOME/hooks/package.json" ]; then
    if [ "$DEPS_CHANGED" -eq 1 ] || [ ! -d "$CLAUDE_HOME/hooks/node_modules" ] || [ ! -d "$CLAUDE_HOME/hooks/node_modules/@modelcontextprotocol/sdk" ] || [ ! -d "$CLAUDE_HOME/hooks/node_modules/undici" ]; then
      log "  Instalando dependencias de los hooks (npm install)..."
      (cd "$CLAUDE_HOME/hooks" && npm install --silent) || warn "  npm install fallo — los hooks pueden no funcionar hasta resolverlo"
    fi
  fi
fi
fi # cierra: if DO_HOST (parte de máquina — bundle + npm)

# ===== Parte de usuario (login SDD — SPEC-0157) =====
if [ "$DO_LOGIN" = 1 ]; then

log "Login SDD (identidad por usuario)..."

# SPECOE_SDD_LOGIN_JS: override para test aislado (apunta al bundle del repo).
SDD_LOGIN_JS="${SPECOE_SDD_LOGIN_JS:-$HOME/.claude/scripts/sdd-login.mjs}"
[ -f "$SDD_LOGIN_JS" ] || err "Falta $SDD_LOGIN_JS — el bundle de hooks (material de MÁQUINA) no quedó instalado.
  Se instala con specoe-setup-host.sh — vive en el starter con el que preparaste la máquina, NO en la carpeta del room.
  Si no lo tenés a mano: git clone --depth 1 $SPECOE_STARTER_REPO specoe-starter && cd specoe-starter && ./specoe-setup-host.sh"

# URL del Hub: --hub > INTEGRA_HUB_API_URL > prompt con default (Enter = default).
LOGIN_HUB_URL="${HUB_URL:-${INTEGRA_HUB_API_URL:-}}"
if [ -z "$LOGIN_HUB_URL" ]; then
  if [ -t 0 ]; then
    read -rp "URL del Hub [https://hub.integra.local/api/v1]: " LOGIN_HUB_URL
  fi
  LOGIN_HUB_URL="${LOGIN_HUB_URL:-https://hub.integra.local/api/v1}"
fi

# Credenciales: env (no interactivo) o prompt. La clave nunca pasa por argv.
LOGIN_EMAIL="${INTEGRA_HUB_EMAIL:-}"
LOGIN_PASSWORD="${INTEGRA_HUB_PASSWORD:-}"
if [ -z "$LOGIN_EMAIL" ] || [ -z "$LOGIN_PASSWORD" ]; then
  [ -t 0 ] || err "Sin TTY y sin INTEGRA_HUB_EMAIL/INTEGRA_HUB_PASSWORD en el entorno — no puedo pedir credenciales. Setealas o corré con terminal interactiva."
  [ -n "$LOGIN_EMAIL" ] || read -rp "Email de tu usuario del Hub: " LOGIN_EMAIL
  if [ -z "$LOGIN_PASSWORD" ]; then
    read -rsp "Clave: " LOGIN_PASSWORD
    echo
  fi
fi

NODE_BIN="$(specoe_node_bin)"
# CA local del piloto para el TLS del Hub. Si falta, specoe_local_ca lo DEJA EN DISCO desde
# certs/ — que es todo lo que hace falta: sdd-login.mjs lee ese archivo por ca-channel.mjs.
# SPEC-0164 P1 (T1.7): ya NO se inyecta NODE_EXTRA_CA_CERTS en la linea de comando. Era el
# segundo mecanismo de CA del starter y el que ataba el login a una variable de entorno.
LOGIN_CA="$(specoe_local_ca)"
[ -n "$LOGIN_CA" ] || warn "  Sin CA local en ~/.claude/caddy-local-root.crt (en una carpeta de room no hay certs/: el CA es material de MÁQUINA y lo deja specoe-setup-host.sh). Si el Hub usa TLS del piloto, el login va a fallar con UNABLE_TO_GET_ISSUER_CERT_LOCALLY."

set +e
LOGIN_JSON="$(SDD_LOGIN_EMAIL="$LOGIN_EMAIL" SDD_LOGIN_PASSWORD="$LOGIN_PASSWORD" \
  SDD_LOGIN_HUB_URL="$LOGIN_HUB_URL" \
  "$NODE_BIN" "$SDD_LOGIN_JS" login)"
LOGIN_RC=$?
set -e
unset LOGIN_PASSWORD
[ -n "$LOGIN_JSON" ] || LOGIN_JSON='{}'

json_field() { "$NODE_BIN" -e "const o=JSON.parse(process.argv[1]);const v=process.argv[2].split('.').reduce((a,k)=>a?.[k],o);console.log(v??'')" "$1" "$2"; }

if [ "$LOGIN_RC" -ne 0 ]; then
  ERR_CODE="$(json_field "$LOGIN_JSON" code 2>/dev/null || true)"
  ERR_MSG="$(json_field "$LOGIN_JSON" message 2>/dev/null || true)"
  warn "Login FALLÓ${ERR_CODE:+ (código $ERR_CODE)}: ${ERR_MSG:-sin detalle}"
  if [ -n "$ERR_CODE" ] && [ -f "$SCRIPT_DIR/specoe-gate-messages.sh" ]; then
    # shellcheck source=specoe-gate-messages.sh
    source "$SCRIPT_DIR/specoe-gate-messages.sh"
    warn "  → $(specoe_gate_message "$ERR_CODE" || true)"
  fi
  # El fallo de TLS no trae `code` (lo tira fetch, no el Hub): sin esto el usuario ve el
  # error de OpenSSL pelado y no sabe qué hacer. (TKT-0217)
  case "$ERR_MSG" in
    *UNABLE_TO_GET_ISSUER_CERT_LOCALLY* | *SELF_SIGNED_CERT_IN_CHAIN* | *CERT_* | *DEPTH_ZERO_SELF_SIGNED_CERT*)
      warn "  → El Hub del piloto usa un TLS firmado por el CA de Integra y esta máquina no lo tiene."
      # SPEC-0167 P3 (T3.3): el CA y el instalador de máquina NO están en la carpeta del room
      # (certs/ y specoe-setup-host.sh quedan fuera del recorte), así que la remediación no
      # puede nombrarlos con './' ni con $SCRIPT_DIR: apunta al canal de host, que sí existe.
      warn "    Se instala con specoe-setup-host.sh — vive en el starter con el que preparaste la máquina, NO en esta carpeta. Copia el CA al trust del SO y a ~/.claude/caddy-local-root.crt."
      warn "    Si no lo tenés a mano: git clone --depth 1 $SPECOE_STARTER_REPO specoe-starter && cd specoe-starter && ./specoe-setup-host.sh"
      ;;
  esac
  err "Sin login no hay identidad SDD: el MCP integra-hub no va a poder operar. Corregí y reintentá con ./setup.sh --login"
fi

MACHINE_STATUS="$(json_field "$LOGIN_JSON" machineStatus)"
TENANT_SLUG="$(json_field "$LOGIN_JSON" tenantSlug)"
USER_ROLES="$("$NODE_BIN" -e "console.log((JSON.parse(process.argv[1]).roles??[]).join(', '))" "$LOGIN_JSON")"
ROBOT_CONFIGURED="$(json_field "$LOGIN_JSON" robot.configured)"
ROBOT_PROVISIONED="$(json_field "$LOGIN_JSON" robot.provisioned)"
ROBOT_STORED="$(json_field "$LOGIN_JSON" robot.tokenStored)"
ROBOT_POOL="$(json_field "$LOGIN_JSON" robot.seatPoolExhausted)"

log "  Login OK — tenant '$TENANT_SLUG'. UserSddToken + machineId guardados en el keyring."
log "  Roles SDD de tu usuario: ${USER_ROLES:-<ninguno>}"
[ -n "$USER_ROLES" ] || warn "  Tu usuario no tiene roles SDD concedidos — un ADMIN del tenant te los concede en el Hub (Administración → SDD → Roles por usuario)."

case "$MACHINE_STATUS" in
  ACTIVE)
    log "  Equipo autorizado (ACTIVE) — listo para operar."
    ;;
  PENDING)
    # shellcheck source=specoe-gate-messages.sh
    source "$SCRIPT_DIR/specoe-gate-messages.sh"
    warn "  Equipo enrolado en estado PENDING."
    warn "  → $(specoe_gate_message MACHINE_PENDING_APPROVAL)"
    ;;
  REVOKED)
    source "$SCRIPT_DIR/specoe-gate-messages.sh"
    warn "  → $(specoe_gate_message MACHINE_REVOKED)"
    ;;
  *)
    warn "  Estado del equipo: ${MACHINE_STATUS:-<desconocido>}"
    ;;
esac

if [ "$ROBOT_CONFIGURED" != "true" ]; then
  warn "  Robot del tenant: NO configurado — el alta automática de datos del robot no está disponible en este tenant. Si la esperabas, avisale al admin del Hub."
elif [ "$ROBOT_PROVISIONED" = "true" ] && [ "$ROBOT_STORED" = "true" ]; then
  log "  Robot del tenant: token nuevo emitido y guardado en el keyring."
elif [ "$ROBOT_PROVISIONED" = "true" ]; then
  warn "  Robot del tenant: token emitido pero NO se pudo persistir en el keyring — reintentá el login."
else
  log "  Robot del tenant: configurado (token vigente, no se re-emite)."
fi
[ "$ROBOT_POOL" = "true" ] && warn "  Pool de seats agotado en el tenant — un ADMIN tiene que liberar un seat o ampliar la licencia."

fi # cierra: if DO_LOGIN (parte de usuario — login SDD)

# ===== Parte de carpeta (room) =====
if [ "$DO_ROOM" = 1 ]; then

# ----- 2. Override hub.api-url si se paso --hub -----

if [ -n "$HUB_URL" ]; then
  log "Actualizando hub.api-url a $HUB_URL en project.config.yaml..."
  # Reemplaza la linea 'api-url: ...' dentro de la seccion hub
  # Soporta tanto "api-url:" como "  api-url:" indentado
  if grep -qE "^\s*api-url:" project.config.yaml; then
    sed -i.bak -E "s|^(\s*)api-url:.*|\1api-url: \"$HUB_URL\"|" project.config.yaml
    rm -f project.config.yaml.bak
  else
    warn "No se encontro 'api-url:' en project.config.yaml. Agregar manualmente bajo 'hub:'."
  fi
fi

# ----- 3. Validar config -----

log "Validando project.config.yaml..."

# Este check CORTA (SPEC-0167 P2, ADR-003). Antes solo verificaba que los cinco campos no
# estuvieran vacios, y el propio script admitia el hueco a continuacion: con los valores del
# template el check pasaba y el flujo fallaba varios pasos despues, lejos de la causa.
#
# Referencia contra la que se compara: el project.config.yaml VERSIONADO del propio clone,
# leido con `git show HEAD:...`. Se compara campo por campo (no el archivo entero) para no
# marcar como "sin editar" lo que el instalador mismo reescribe. `git show` lee del index,
# asi que funciona aunque el archivo no este materializado en el working tree.
# Si la carpeta no es un repo git —o HEAD no tiene el archivo— se cae al fallback por
# sentinelas y se DECLARA en la salida: un check degradado no puede confundirse con uno completo.
CONFIG_TEMPLATE_REF="$(mktemp)"
CONFIG_CHECK_MODE="versionado"
if ! ( git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
       && git show HEAD:project.config.yaml >"$CONFIG_TEMPLATE_REF" 2>/dev/null \
       && [ -s "$CONFIG_TEMPLATE_REF" ] ); then
  rm -f "$CONFIG_TEMPLATE_REF"
  CONFIG_TEMPLATE_REF=""
  CONFIG_CHECK_MODE="sentinelas"
  warn "  MODO DEGRADADO: no pude leer el project.config.yaml versionado (git show HEAD:project.config.yaml)."
  warn "  La deteccion de valores de template corre contra sentinelas literales, que pueden estar"
  warn "  desactualizadas respecto del template. Este check NO equivale al completo."
fi

CONFIG_EMPTY_FIELDS=""
CONFIG_TEMPLATE_FIELDS=""
for field in $SPECOE_CONFIG_FIELDS; do
  value="$(specoe_yaml_get project.config.yaml "$field")"
  if [ -z "$value" ] || [ "$value" = '""' ]; then
    CONFIG_EMPTY_FIELDS="$CONFIG_EMPTY_FIELDS $field"
    continue
  fi
  if [ -n "$CONFIG_TEMPLATE_REF" ]; then
    template_value="$(specoe_yaml_get "$CONFIG_TEMPLATE_REF" "$field")"
  else
    template_value="$(specoe_config_sentinel "$field")"
  fi
  if [ -n "$template_value" ] && [ "$value" = "$template_value" ]; then
    CONFIG_TEMPLATE_FIELDS="$CONFIG_TEMPLATE_FIELDS $field"
  fi
done
if [ -n "$CONFIG_TEMPLATE_REF" ]; then rm -f "$CONFIG_TEMPLATE_REF"; fi

if [ -n "$CONFIG_EMPTY_FIELDS" ] || [ -n "$CONFIG_TEMPLATE_FIELDS" ]; then
  warn "project.config.yaml todavia no describe a este cliente:"
  for field in $CONFIG_EMPTY_FIELDS; do
    warn "  - $field — VACIO"
  done
  for field in $CONFIG_TEMPLATE_FIELDS; do
    warn "  - $field — sigue en el valor del template ('$(specoe_yaml_get project.config.yaml "$field")')"
  done
  warn ""
  warn "  El corte es a proposito: con estos valores el resto del flujo falla mas adelante y lejos de la causa."
  warn "  Editá los campos de arriba en $(pwd)/project.config.yaml y volvé a correr el MISMO comando."
  warn "  Si esto salio de specoe-add-room.sh, la instanciacion del room es de DOS PASADAS: la primera clona la"
  warn "  carpeta, fija el rol y guarda la licencia (add-room imprime abajo que quedo hecho); la segunda, ya con"
  warn "  el yaml editado, completa la config. El yaml recien existe despues del clone, asi que no hay forma de"
  warn "  editarlo antes de la primera pasada."
  err "Config incompleta o sin editar:${CONFIG_EMPTY_FIELDS}${CONFIG_TEMPLATE_FIELDS} — editar project.config.yaml y reintentar."
fi

if [ "$CONFIG_CHECK_MODE" = "versionado" ]; then
  log "Config: los $(echo $SPECOE_CONFIG_FIELDS | wc -w | tr -d ' ') campos obligatorios estan completos y editados (comparados contra el yaml versionado del clone)."
else
  log "Config: campos obligatorios completos y distintos de las sentinelas del template (check en modo degradado)."
fi

# ----- 4. License -----

LICENSE_KEY="${SPECOE_LICENSE_KEY:-$(grep -E '^\s*key:' project.config.yaml | head -1 | sed 's/.*key: *//;s/"//g' || true)}"
if [ -z "$LICENSE_KEY" ]; then
  warn "No hay license key en env ni en yaml. Modo 'solo skills libres' activado."
  warn "Para licencia completa, setear license.key o SPECOE_LICENSE_KEY."
else
  log "License detectada: ${LICENSE_KEY:0:12}..."
fi

# ----- 5. Setup Claude Code hooks -----

log "Configurando .claude/ local..."
mkdir -p .claude

if [ ! -f .claude/settings.json ]; then
  warn ".claude/settings.json no existe — se esperaba estar en el starter. Saltando."
fi

# ----- 5.5. Generar .mcp.json -----
# El starter renderizado al repo publico NO trae .mcp.json (lleva el bearer del skill-server),
# asi que sin este paso Claude Code no conecta a los MCP. Genera/actualiza DOS servers:
#   - specoe (skill-server): placeholders, el SessionStart hook lo puebla con el JWT fresco.
#   - integra-hub (SPEC-0157): modo USER — la identidad sale del keyring (login SDD), el rol
#     es config de ESTA carpeta (INTEGRA_SDD_ROLE, claim sin firma que el Hub autoriza
#     server-side). SIN secretos act-as, SIN credenciales, SIN cuid de tenant: el tenant lo
#     resuelve el server a partir del token del usuario.
# Idempotente y preservador: no pisa `specoe` si ya existe ni borra otros servers; el entry
# `integra-hub` sí se regenera (es config derivada del yaml, no estado del dev).

log "Generando/actualizando .mcp.json (specoe + integra-hub modo USER)..."

ROOM_ROLE="$(grep -E "^\s*role:" project.config.yaml | head -1 | sed "s/.*role: *'\{0,1\}//;s/'.*//;s/ *#.*//" || true)"
MCP_HUB_URL="${HUB_URL:-$(grep -E '^\s*api-url:' project.config.yaml | head -1 | sed 's/.*api-url: *//;s/"//g' || true)}"
MCP_HUB_URL="${MCP_HUB_URL:-https://hub.integra.local/api/v1}"
[ -n "$ROOM_ROLE" ] || warn "  specoe.role está vacío en project.config.yaml — .mcp.json queda SIN INTEGRA_SDD_ROLE (el Hub va a responder SDD_SESSION_ROLE_CLAIM_MISSING). Fijalo con specoe-add-room.sh <ROL>."

NODE_BIN="$(specoe_node_bin)"
MCP_CA="$(specoe_local_ca)"

"$NODE_BIN" - "$ROOM_ROLE" "$MCP_HUB_URL" "$MCP_CA" <<'EOF'
const fs = require('fs');
const [role, hubUrl, caPath] = process.argv.slice(2);
let doc = { mcpServers: {} };
try {
  doc = JSON.parse(fs.readFileSync('.mcp.json', 'utf8'));
  if (!doc || typeof doc !== 'object') doc = { mcpServers: {} };
  if (!doc.mcpServers) doc.mcpServers = {};
} catch { /* no existe o invalido: se genera de cero */ }

// specoe: solo si falta (el hook de licencia lo re-escribe con el JWT fresco).
if (!doc.mcpServers.specoe) {
  doc.mcpServers.specoe = {
    type: 'sse',
    url: '${SPECOE_SKILL_SERVER_URL:-https://mcp.integra.local/sse}',
    headers: { Authorization: 'Bearer ${SPECOE_SKILL_JWT}' },
  };
  console.log('  [CREATE]  mcpServers.specoe');
} else {
  console.log('  [SKIP]    mcpServers.specoe (ya existe)');
}

// integra-hub: SIEMPRE al shape USER-mode (config derivada — sin secretos).
const env = {
  INTEGRA_HUB_API_URL: hubUrl,
  INTEGRA_SDD_IDENTITY_MODE: 'USER',
};
if (role) env.INTEGRA_SDD_ROLE = role;
if (caPath) env.NODE_EXTRA_CA_CERTS = caPath;
doc.mcpServers['integra-hub'] = {
  command: 'node',
  args: ['node_modules/integra-hub-mcp/dist/index.js'],
  env,
};
console.log(`  [WRITE]   mcpServers.integra-hub (modo USER${role ? ', rol ' + role : ', SIN rol'})`);

fs.writeFileSync('.mcp.json', JSON.stringify(doc, null, 2) + '\n');
EOF

fi # cierra: if DO_ROOM (parte de carpeta — config + .mcp.json)

# ----- 6. Next steps -----

log "Setup base completado."
# Sin chequear DO_HOST: con --login el bundle puede haberse instalado en la misma corrida
# (auto-run de la parte de máquina, TKT-0217) y el mensaje que importa sigue siendo el del login.
if [ "$DO_ROOM" = 0 ] && [ "$DO_LOGIN" = 1 ]; then
  log "  (login: identidad SDD guardada en el keyring de la máquina)"
elif [ "$DO_ROOM" = 0 ]; then
  log "  (host-only: bundle de hooks + dependencias instalados en ~/.claude)"
else
  log ""
  # SPEC-0167 P2: el paso 1 era "Revisar y completar project.config.yaml", o sea DESPUES de
  # que la instalacion ya habia declarado la config valida. Con el check que corta, si llegaste
  # hasta aca el yaml ya esta editado: instruir completarlo ahora es instruir el orden inverso.
  log "Proximos pasos:"
  log "  1. Activar license (el SessionStart hook lo hace automaticamente al abrir Claude Code)"
  log "  2. Iniciar Claude Code: claude"
  log "  3. Ver docs/QUICKSTART-VSCODE.md para el arranque en VSCode"
  log "  (project.config.yaml ya paso el check de config: campos obligatorios completos y editados)"
  log ""
  HUB_SHOW=$(grep -E '^\s*api-url:' project.config.yaml | head -1 | sed 's/.*api-url: *//;s/"//g' || true)
  log "Hub: ${HUB_SHOW:-<no configurado>}"
  log "(default piloto interno: hub.integra.local. Suite on-premise: contactar a Integra Software)"
fi
