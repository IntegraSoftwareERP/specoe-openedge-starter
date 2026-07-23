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

# ----- 1. Prereqs -----

log "Verificando prerrequisitos..."

command -v node >/dev/null 2>&1 || err "node no encontrado. Instalar Node.js 20+."
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\)\..*/\1/')
[ "$NODE_MAJOR" -ge 20 ] || err "Node $NODE_MAJOR detectado. Se requiere 20+."

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
  warn ".claude-bundle no existe en el starter — saltando install. Si Claude Code no autentica al Hub, contactar a Integra Software."
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
  install_force "$BUNDLE_DIR/hooks/specoe-role-check.mjs"         "$CLAUDE_HOME/hooks/specoe-role-check.mjs"
  install_force "$BUNDLE_DIR/hooks/specoe-license-check.mjs"      "$CLAUDE_HOME/hooks/specoe-license-check.mjs"
  install_force "$BUNDLE_DIR/hooks/specoe-room-bootstrap.mjs"     "$CLAUDE_HOME/hooks/specoe-room-bootstrap.mjs"
  install_force "$BUNDLE_DIR/hooks/secrets.mjs"                   "$CLAUDE_HOME/hooks/secrets.mjs"
  install_force "$BUNDLE_DIR/hooks/credentials.mjs"               "$CLAUDE_HOME/hooks/credentials.mjs"
  install_force "$BUNDLE_DIR/scripts/provision-secrets.mjs"       "$CLAUDE_HOME/scripts/provision-secrets.mjs"
  install_force "$BUNDLE_DIR/scripts/sdd-login.mjs"               "$CLAUDE_HOME/scripts/sdd-login.mjs"

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
[ -f "$SDD_LOGIN_JS" ] || err "Falta $SDD_LOGIN_JS — corré primero la parte de máquina (./setup.sh --host-only o specoe-setup-host.sh)."

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

# node.exe bypassa el wrapper winpty de Git Bash que rompe @napi-rs/keyring (TKT-0200).
NODE_BIN="node"
command -v node.exe >/dev/null 2>&1 && NODE_BIN="node.exe"
# CA local del piloto para el TLS del Hub (si está — specoe-setup-host.sh lo copia).
LOGIN_CA=""
[ -f "$HOME/.claude/caddy-local-root.crt" ] && LOGIN_CA="$HOME/.claude/caddy-local-root.crt"

set +e
LOGIN_JSON="$(SDD_LOGIN_EMAIL="$LOGIN_EMAIL" SDD_LOGIN_PASSWORD="$LOGIN_PASSWORD" \
  SDD_LOGIN_HUB_URL="$LOGIN_HUB_URL" NODE_EXTRA_CA_CERTS="$LOGIN_CA" \
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

# Validator ligero en bash — chequea que campos obligatorios no esten vacios.
for field in "project.name" "project.vendor" "database.logical-name" "pasoe.instance-name"; do
  value=$(grep -E "^\s*${field##*.}:" project.config.yaml | head -1 | sed 's/.*: *//;s/"//g' || true)
  if [ -z "$value" ] || [ "$value" = '""' ]; then
    err "Campo obligatorio vacio: $field — editar project.config.yaml"
  fi
done

log "Config basica: campos obligatorios presentes."
warn "  ATENCION: este check solo verifica que los campos NO esten vacios."
warn "  Si project.config.yaml tiene los valores de template ('MiCliente ERP', 'oepas1', etc.) sin editar,"
warn "  este check pasa pero el resto del flow puede fallar. Editar el yaml en Paso 3 y validar real con smoke-test (Paso 5)."

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

NODE_BIN="node"
command -v node.exe >/dev/null 2>&1 && NODE_BIN="node.exe"
MCP_CA=""
[ -f "$HOME/.claude/caddy-local-root.crt" ] && MCP_CA="$HOME/.claude/caddy-local-root.crt"

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
if [ "$DO_ROOM" = 0 ] && [ "$DO_LOGIN" = 1 ] && [ "$DO_HOST" = 0 ]; then
  log "  (login: identidad SDD guardada en el keyring de la máquina)"
elif [ "$DO_ROOM" = 0 ]; then
  log "  (host-only: bundle de hooks + dependencias instalados en ~/.claude)"
else
  log ""
  log "Proximos pasos:"
  log "  1. Revisar y completar project.config.yaml"
  log "  2. Activar license (el SessionStart hook lo hace automaticamente al abrir Claude Code)"
  log "  3. Iniciar Claude Code: claude"
  log "  4. Ver docs/QUICKSTART-VSCODE.md para el arranque en VSCode"
  log ""
  HUB_SHOW=$(grep -E '^\s*api-url:' project.config.yaml | head -1 | sed 's/.*api-url: *//;s/"//g' || true)
  log "Hub: ${HUB_SHOW:-<no configurado>}"
  log "(default piloto interno: hub.integra.local. Suite on-premise: contactar a Integra Software)"
fi
