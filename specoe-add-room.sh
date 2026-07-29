#!/usr/bin/env bash
# specoe-add-room.sh — Instancia UN room de un rol, 1 vez por room (piloto Integra).
#
# Núcleo de la parte por-rol. NO toca hosts / CA / pre-req / bundle — eso lo hace
# specoe-setup-host.sh (1 vez por máquina). Acá solo lo específico del room, EN ESTE ORDEN:
#   1. Clona/actualiza el starter en la carpeta del room.  2. Fija specoe.role en su yaml.
#   3. Guarda la licencia en el keyring bajo account=<ROL> (aislada por rol → multi-rol).
#   4. Chequea la identidad SDD de la máquina (token + machineId en el keyring).
#   5. setup.sh --room-only (config + .mcp.json) — ÚLTIMO: su check de config puede cortar.
#
# Uso:
#   ./specoe-add-room.sh <ROL> <LICENSE_KEY> [--dir <carpeta>] [--hub <url>] [--repo <url>]
#     <ROL> = DISCOVERY | ENGINEERING | ADVERSARIAL | CC_DEV
#   Los wrappers specoe-room-<rol>.sh llaman a este núcleo con el rol y el --dir por defecto.

set -euo pipefail

HUB_URL="https://hub.integra.local/api/v1"
STARTER_REPO="https://github.com/IntegraSoftwareERP/specoe-openedge-starter.git"
DEST_DIR=""
ROLE=""
LICENSE_KEY=""

log()  { echo -e "\033[1;34m[specoe-room]\033[0m $*"; }
warn() { echo -e "\033[1;33m[specoe-room]\033[0m $*" >&2; }
err()  { echo -e "\033[1;31m[specoe-room]\033[0m $*" >&2; exit 1; }

# En Git Bash `node` va envuelto por winpty y rompe @napi-rs/keyring → `node.exe` (TKT-0200).
# En WSL el node.exe de Windows también está en el PATH por el interop, pero recibe rutas Unix
# que lee como Windows → MODULE_NOT_FOUND. Ahí no hay winpty: va el node de Linux. (TKT-0217)
specoe_node_bin() {
  if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
    echo node
  elif command -v node.exe >/dev/null 2>&1; then
    echo node.exe
  else
    echo node
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)  DEST_DIR="$2"; shift 2 ;;
    --hub)  HUB_URL="$2";  shift 2 ;;
    --repo) STARTER_REPO="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) err "Opción desconocida: $1 (ver --help)" ;;
    *)
      if   [ -z "$ROLE" ];        then ROLE="$1"; shift
      elif [ -z "$LICENSE_KEY" ]; then LICENSE_KEY="$1"; shift
      else err "Argumento inesperado: $1"; fi
      ;;
  esac
done

[ -n "$ROLE" ]        || err "Falta el rol. Uso: ./specoe-add-room.sh <ROL> <LICENSE_KEY>"
[ -n "$LICENSE_KEY" ] || err "Falta la license key. Uso: ./specoe-add-room.sh <ROL> <LICENSE_KEY>"
case "$ROLE" in
  DISCOVERY|ENGINEERING|ADVERSARIAL|CC_DEV) : ;;
  *) err "Rol inválido: '$ROLE'. Valores: DISCOVERY | ENGINEERING | ADVERSARIAL | CC_DEV" ;;
esac
# Default de carpeta según el rol (discovery-room, engineering-room, ...).
[ -n "$DEST_DIR" ] || DEST_DIR="$(echo "$ROLE" | tr 'A-Z_' 'a-z-')-room"

# Como conseguir el canal de HOST desde una carpeta de room recortada (SPEC-0167 P3): el
# instalador de maquina (specoe-setup-host.sh, install-specoe.sh, certs/) NO esta dentro de la
# carpeta del room, asi que nombrarlo con './' manda al dev a un archivo que no existe.
specoe_host_hint() {
  echo "specoe-setup-host.sh — vive en el starter con el que preparaste la maquina, NO en la carpeta del room. Si no lo tenés a mano: git clone --depth 1 $STARTER_REPO specoe-starter && cd specoe-starter && ./specoe-setup-host.sh"
}

# El host se corre antes: avisamos si el bundle no está (pero no bloqueamos — setup.sh --room-only
# no lo necesita; el hook sí, al abrir Claude Code).
[ -f "$HOME/.claude/hooks/specoe-license-check.mjs" ] || \
  warn "El bundle de hooks no está en ~/.claude — corré $(specoe_host_hint)"

# ----- Conjunto firmado de la carpeta del room (SPEC-0167 P3, Q3) -----
# La carpeta del room lleva SOLO lo que el room usa para operar y para re-provisionarse a si
# mismo. El instalador de MAQUINA (install-specoe.sh, specoe-setup-host.sh, los cuatro wrappers
# por rol, certs/, docker/, examples/) y el bundle de hooks (.claude-bundle/, material de host
# que vive en ~/.claude despues del setup-host) NO entran.
#
# CONSERVA (12). Lista INCLUSIVA: se enumera lo que se conserva, una entrada por linea con
# barra inicial. No son negaciones sobre '/*' — asi una entrada NUEVA del starter no llega al
# room por omision, que es el default seguro (y la contrapartida: cuando el starter suma algo
# que el room necesita, se agrega ACA a proposito).
SPECOE_ROOM_KEEP='/.claude/
/.gitattributes
/.gitignore
/project.config.yaml
/setup.sh
/specoe-add-room.sh
/specoe-gate-messages.sh
/specoe-launch-thinclient.sh
/specoe-verify-room.sh
/README.md
/VERSION
/docs/QUICKSTART-VSCODE.md'

# EXCLUYE (11). Se enumeran aparte porque el exit code del sparse-checkout NO es evidencia:
# --no-cone acepta patrones que no corresponden a ninguna ruta real sin emitir error, y en
# Git Bash la conversion de rutas de MSYS destroza los patrones que empiezan con barra si se
# pasan por argv. Las dos cosas juntas producen un recorte que no se aplica CON EXIT 0. Por
# eso despues de aplicarlo se verifica entrada por entrada contra el disco.
SPECOE_ROOM_DROP='install-specoe.sh
specoe-setup-host.sh
specoe-room-discovery.sh
specoe-room-engineering.sh
specoe-room-adversarial.sh
specoe-room-ccdev.sh
CHANGELOG.md
.claude-bundle
certs
docker
examples'

SPECOE_GIT_MIN="2.25.0"

specoe_ver_num() {
  local a b c
  IFS=. read -r a b c <<<"$1"
  a="${a%%[!0-9]*}"; b="${b%%[!0-9]*}"; c="${c%%[!0-9]*}"
  echo $(( ${a:-0} * 1000000 + ${b:-0} * 1000 + ${c:-0} ))
}

# Sin `git sparse-checkout` (2.25+) no hay recorte posible. Cortamos ANTES de clonar: un
# recorte que falla abierto deja el room con el instalador completo adentro y el instalador
# reportando exito, que es el defecto original con una capa mas de disfraz.
specoe_require_git_sparse() {
  local ver
  ver="$(git --version | awk '{print $3}')"
  if [ "$(specoe_ver_num "$ver")" -lt "$(specoe_ver_num "$SPECOE_GIT_MIN")" ]; then
    err "git $ver detectado y hace falta $SPECOE_GIT_MIN o superior para recortar la carpeta del room (git sparse-checkout).
  Sin el recorte la carpeta quedaria con el instalador completo adentro, asi que corto en vez de seguir.
  Actualizá git (https://git-scm.com/downloads) y volvé a correr el MISMO comando."
  fi
}

# Aplica (o refresca) el recorte sobre una carpeta que ya es repo git.
# --no-cone, no cone: el modo cone materializa SIEMPRE todos los archivos de la raiz y solo
# excluye directorios, y SIETE de las once entradas a excluir son archivos de raiz.
# Por --stdin, nunca por argv: en Git Bash MSYS convierte '/setup.sh' en una ruta absoluta de
# Windows y el recorte no se aplica, con exit 0.
specoe_sparse_apply() {
  local dir="$1"
  git -C "$dir" sparse-checkout init --no-cone
  printf '%s\n' "$SPECOE_ROOM_KEEP" | git -C "$dir" sparse-checkout set --no-cone --stdin
}

# Verificacion POST-aplicacion: el disco, no el exit code.
specoe_sparse_verify() {
  local dir="$1" entry leftover=""
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    if [ -e "$dir/$entry" ]; then
      leftover="$leftover
  - $entry"
    fi
  done <<< "$SPECOE_ROOM_DROP"
  if [ -n "$leftover" ]; then
    err "El recorte de la carpeta del room NO se aplico: sigue habiendo entradas excluidas en '$dir':$leftover
  Corto en vez de seguir — una carpeta con el instalador adentro reportando exito es el defecto que este paso viene a evitar.
  Revisá la version de git ($(git --version)) y que el sparse-checkout se haya aplicado: git -C \"$dir\" sparse-checkout list"
  fi
}

# ----- 1. Clonar/actualizar la carpeta del room -----
specoe_require_git_sparse
if [ -d "$DEST_DIR/.git" ]; then
  log "Actualizando '$DEST_DIR'..."

  # Divergencia ESPERADA y acotada (SPEC-0167 P3, ADR-004). El working tree de un room NUNCA
  # esta limpio: el sed de mas abajo reescribe specoe.role sobre project.config.yaml —que es un
  # archivo TRACKED— en toda instanciacion, y el dev ademas lo edita con los valores del cliente.
  # Lo que el instalador pone es eso y el .mcp.json que genera setup.sh (untracked hasta que la
  # carpeta reciba el .gitignore que lo cubre). CUALQUIER otra entrada es trabajo que el
  # instalador no puso: no se recorta ni se borra nada, se corta y se pide intervencion.
  divergence="$(git -C "$DEST_DIR" status --porcelain)"
  unexpected="$(printf '%s\n' "$divergence" | grep -v -e '^$' -e '^ M project\.config\.yaml$' -e '^?? \.mcp\.json$' || true)"
  if [ -n "$unexpected" ]; then
    err "La carpeta '$DEST_DIR' tiene cambios locales que este instalador no puso:
$unexpected
  No toco nada: aplicar el recorte o actualizar acá puede destruir trabajo tuyo.
  Resolvelos (commit, stash o descarte segun corresponda) y volvé a correr el MISMO comando."
  fi

  # Recorte retroactivo: una carpeta instanciada ANTES de este cambio tiene el instalador
  # adentro. Se aplica aca, con la divergencia ya verificada como esperada.
  specoe_sparse_apply "$DEST_DIR"

  # El pull ya NO degrada a warn. El '|| warn "pull fallo (cambios locales?). Sigo con lo que
  # hay."' se tragaba la falla pese al `set -euo pipefail` —el cortocircuito la capturaba— y la
  # corrida terminaba en el mensaje de exito: el dev creia que actualizo y seguia con el starter
  # viejo. Si el pull falla, corta nombrando el archivo del conflicto.
  if ! pull_out="$(git -C "$DEST_DIR" pull --ff-only 2>&1)"; then
    err "La actualizacion de '$DEST_DIR' FALLO y corto (antes esto era un warn y la corrida seguia con el starter viejo):
$pull_out
  Archivos con cambios locales en la carpeta:
$(git -C "$DEST_DIR" status --porcelain || true)
  Si el conflicto es project.config.yaml, el template cambio y tu config tiene lo del cliente: resolvelo a mano (git -C \"$DEST_DIR\" diff project.config.yaml) y volvé a correr el MISMO comando."
  fi
  printf '%s\n' "$pull_out"
else
  log "Clonando el starter en '$DEST_DIR' (room $ROLE, contenido recortado)..."
  git clone --depth 1 --no-checkout "$STARTER_REPO" "$DEST_DIR"
  specoe_sparse_apply "$DEST_DIR"
  git -C "$DEST_DIR" checkout
fi
specoe_sparse_verify "$DEST_DIR"
[ -f "$DEST_DIR/setup.sh" ] || err "El starter no tiene setup.sh en '$DEST_DIR'. ¿Repo correcto?"

# ----- 2. Fijar el rol en el yaml de la carpeta -----
# ANTES del --room-only: el .mcp.json que genera setup.sh lee specoe.role para
# cablear INTEGRA_SDD_ROLE (el rol es config del room — claim x-sdd-role sin
# firma que el Hub autoriza server-side, SPEC-0157).
log "Fijando specoe.role='$ROLE' en project.config.yaml..."
sed -i.bak "s|role: '[^']*'|role: '$ROLE'|" "$DEST_DIR/project.config.yaml" && rm -f "$DEST_DIR/project.config.yaml.bak"

# ----- 3. Licencia en el keyring, account = rol (aislada → multi-rol) -----
# ANTES del --room-only (SPEC-0167 P2 / T2.4, ADR-005): el check de config de setup.sh CORTA
# cuando el project.config.yaml sigue con los valores del template, y corre dentro del subshell
# del --room-only. Con `set -euo pipefail` y sin capturar ese subshell, el corte abortaba el
# script ahi y este bloque no se ejecutaba nunca. Como el yaml solo existe desde el clone de
# mas arriba, el dev no puede editarlo antes: la PRIMERA corrida de cualquier rol, en cualquier
# maquina, terminaba en error con la carpeta clonada, el rol fijado y SIN licencia en el keyring
# — el estado parcial peor de los dos, porque el sintoma que ve despues es un 401 del MCP.
# Este bloque no depende de nada que produzca el --room-only: corre desde $HOME/.claude/hooks y
# consume solo $LICENSE_KEY y $ROLE, parseados de argv. No lee project.config.yaml ni .mcp.json.
log "Guardando la license key en el keyring (account=$ROLE)..."
KEYRING_OK=0
NODE_BIN="$(specoe_node_bin)"
# Capturamos stdout+stderr del proceso: NO silenciamos el error (el fallo mudo era el bug).
# Verificamos post-escritura con getPassword() para no reportar éxito falso.
if keyring_out="$( ( cd "$HOME/.claude/hooks" && "$NODE_BIN" -e "
const { Entry } = require('@napi-rs/keyring');
const [key, role] = [process.argv[1], process.argv[2]];
const entry = new Entry('specoe-license', role);
entry.setPassword(key);
if (entry.getPassword() !== key) throw new Error('verificacion post-escritura fallo: la key no quedo persistida');
" "$LICENSE_KEY" "$ROLE" ) 2>&1 )"; then
  log "  License key guardada y verificada en el keyring (account=$ROLE)."
  KEYRING_OK=1
else
  warn "  ⚠ NO se pudo persistir la license key en el keyring (account=$ROLE) usando '$NODE_BIN'."
  warn "    Detalle real del error: ${keyring_out:-<el proceso no devolvió salida>}"
  warn "    → Sin la key en el keyring, el hook specoe-license-check NO valida y el MCP 'specoe' dará 401."
  warn "    Recuperá con UNA de estas opciones:"
  warn "      a) A mano con el mismo binario:  cd ~/.claude/hooks && $NODE_BIN -e \"const {Entry}=require('@napi-rs/keyring'); new Entry('specoe-license','$ROLE').setPassword('$LICENSE_KEY')\"  → luego Reload Window en VSCode."
  warn "      b) Fallback env var:   exportá SPECOE_LICENSE_KEY antes de abrir el room."
fi

# ----- 4. Estado de la identidad SDD del equipo (SPEC-0157) -----
# Tambien ANTES del --room-only, por la misma razon que el bloque 3 (ADR-005): usa
# $HOME/.claude/scripts/sdd-login.mjs y $SCRIPT_DIR —el directorio de ESTE script, no el del
# room— asi que no depende del estado que deja el --room-only.
# El room declara el rol; la identidad (token de usuario + machineId) es de la
# MÁQUINA y la deja el login de specoe-setup-host.sh. Chequeo accionable acá:
# sin ese material, la sesión del room no va a poder operar contra el Hub.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$HOME/.claude/scripts/sdd-login.mjs" ]; then
  if ( cd "$HOME/.claude/scripts" && "$NODE_BIN" sdd-login.mjs status >/dev/null 2>&1 ); then
    log "Identidad SDD: token de usuario + machineId presentes en el keyring."
  else
    warn "Identidad SDD INCOMPLETA: falta el token de usuario o el machineId en el keyring."
    warn "  → Corré el login desde la carpeta del room: ./setup.sh --login . Sin eso, el MCP integra-hub del room no autentica."
  fi
else
  warn "No está ~/.claude/scripts/sdd-login.mjs (bundle de hooks + login de la maquina)."
  warn "  → Corré $(specoe_host_hint)"
fi
if [ -f "$SCRIPT_DIR/specoe-gate-messages.sh" ]; then
  log "Si el Hub responde 403 en la sesión, traducí el código a instrucción con:"
  log "  bash \"$SCRIPT_DIR/specoe-gate-messages.sh\" <CODIGO> $ROLE   (ej: MACHINE_PENDING_APPROVAL, SDD_ROLE_NOT_GRANTED)"
fi

# ----- 5. Config de la carpeta (sin bundle) — ULTIMO paso, porque puede cortar -----
# El check de config de setup.sh corta cuando el yaml sigue con los valores del template
# (SPEC-0167 P2). Va al final para que ese corte no se lleve puesto nada de lo de arriba, y
# capturamos el subshell para decir con precision que quedo hecho y que falta.
log "Configurando la carpeta (setup.sh --room-only) con --hub $HUB_URL ..."
if ! ( cd "$DEST_DIR" && bash setup.sh --room-only --hub "$HUB_URL" ); then
  warn ""
  warn "La configuracion de la carpeta corto (el detalle esta arriba). Esta primera pasada YA dejo:"
  warn "  - '$DEST_DIR' clonado, con specoe.role='$ROLE' fijado."
  if [ "$KEYRING_OK" = 1 ]; then
    warn "  - la license key guardada y verificada en el keyring (account=$ROLE)."
  else
    warn "  - la license key NO quedo en el keyring (ver el detalle mas arriba y recuperala antes de seguir)."
  fi
  err "Instalacion de DOS PASADAS: editá '$DEST_DIR/project.config.yaml' y volvé a correr el MISMO comando."
fi

log ""
log "Room $ROLE listo en '$DEST_DIR'. Abrilo en VSCode: code \"$DEST_DIR\""
