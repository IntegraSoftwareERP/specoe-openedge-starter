#!/usr/bin/env bash
# specoe-add-room.sh — Instancia UN room de un rol, 1 vez por room (piloto Integra).
#
# Núcleo de la parte por-rol. NO toca hosts / CA / pre-req / bundle — eso lo hace
# specoe-setup-host.sh (1 vez por máquina). Acá solo lo específico del room, EN ESTE ORDEN:
#   1. Clona/actualiza el starter en la carpeta del room.  2. Fija specoe.role (y specoe.tenant
#      y specoe.work-repo si se declararon) en su yaml.
#   3. Guarda la licencia en el keyring bajo account=<ROL> — o '<tenantSlug>:<ROL>' cuando el
#      room declara tenant (aislada por rol → multi-rol; por tenant → multi-tenant).
#   4. Chequea la identidad SDD de la máquina (token + machineId en el keyring).
#   5. setup.sh --room-only (config + .mcp.json) — ÚLTIMO: su check de config puede cortar.
#
# Uso:
#   ./specoe-add-room.sh <ROL> [LICENSE_KEY] [--tenant <slug>] [--work-repo <ruta>] [--dir <carpeta>] [--hub <url>] [--repo <url>]
#     <ROL> = DISCOVERY | ENGINEERING | ADVERSARIAL | CC_DEV
#   La LICENSE_KEY es obligatoria la PRIMERA vez. Despues queda en el keyring y se puede omitir:
#   la segunda pasada (y cualquier reintento) la lee de ahi por su account (TKT-0307).
#   Los wrappers specoe-room-<rol>.sh llaman a este núcleo con el rol y el --dir por defecto.
#
# SPEC-0187 P7 — `--tenant <slug>` es el slug del tenant del Hub (el `tenantSlug` que devuelve
# el login SDD, NO el Tenant.id del contrato scoped). Sin el flag, la carpeta queda en modo
# single-tenant y la licencia va bajo el rol pelado: el piloto instalado no cambia.
#
# TKT-0317 — `--work-repo <ruta>` es el checkout LOCAL del repo donde vive el codigo sobre el que
# trabaja este room. NO es `--repo`, que es la URL del starter que se clona en la carpeta. La
# distincion es el punto del ticket: la carpeta del room es un clon shallow del starter y las
# herramientas de aislamiento del agente operan sobre el cwd, asi que sin esta declaracion apuntan
# a ese clon — repo equivocado. Sin el flag el room no declara repo de trabajo y la sesion lo dice
# al arrancar (specoe-room-bootstrap.mjs) en vez de dejar que se descubra al primer worktree.

set -euo pipefail

HUB_URL="https://hub.integra.local/api/v1"
STARTER_REPO="https://github.com/IntegraSoftwareERP/specoe-openedge-starter.git"
DEST_DIR=""
ROLE=""
LICENSE_KEY=""
TENANT_SLUG=""
WORK_REPO=""

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

# Acceso al keyring en DOS funciones y no inline (TKT-0307): asi la suite
# (scripts/test-add-room-license.sh) ejerce la resolucion de la key —que es donde estaba el bug—
# sin tocar el almacen real de la maquina que corre el test.
#
# El `node -e` de la lectura va en UNA linea: en Git Bash un -e multilinea no es confiable (misma
# nota que scripts/check-vendor-drift.sh). getPassword() TIRA cuando la entrada no existe, asi que
# el try/catch es la unica forma de distinguir "no esta" de "el keyring no anda" sin ruido.
specoe_keyring_read() { # $1 = account. Imprime la key por stdout; exit != 0 si no hay nada.
  [ -d "$HOME/.claude/hooks" ] || return 1
  ( cd "$HOME/.claude/hooks" && "$(specoe_node_bin)" -e "const { Entry } = require('@napi-rs/keyring'); let v = null; try { v = new Entry('specoe-license', process.argv[1]).getPassword(); } catch { process.exit(1); } if (!v) { process.exit(1); } process.stdout.write(v);" "$1" ) 2>/dev/null
}

specoe_keyring_write() { # $1 = account, $2 = key. Verifica post-escritura: sin eso reporta verde falso.
  ( cd "$HOME/.claude/hooks" && "$(specoe_node_bin)" -e "
const { Entry } = require('@napi-rs/keyring');
const [key, account] = [process.argv[1], process.argv[2]];
const entry = new Entry('specoe-license', account);
entry.setPassword(key);
if (entry.getPassword() !== key) throw new Error('verificacion post-escritura fallo: la key no quedo persistida');
" "$2" "$1" ) 2>&1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)  DEST_DIR="$2"; shift 2 ;;
    --tenant) TENANT_SLUG="$2"; shift 2 ;;
    --work-repo) WORK_REPO="$2"; shift 2 ;;
    --hub)  HUB_URL="$2";  shift 2 ;;
    --repo) STARTER_REPO="$2"; shift 2 ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    -*) err "Opción desconocida: $1 (ver --help)" ;;
    *)
      if   [ -z "$ROLE" ];        then ROLE="$1"; shift
      elif [ -z "$LICENSE_KEY" ]; then LICENSE_KEY="$1"; shift
      else err "Argumento inesperado: $1"; fi
      ;;
  esac
done

[ -n "$ROLE" ]        || err "Falta el rol. Uso: ./specoe-add-room.sh <ROL> [LICENSE_KEY]"
case "$ROLE" in
  DISCOVERY|ENGINEERING|ADVERSARIAL|CC_DEV) : ;;
  *) err "Rol inválido: '$ROLE'. Valores: DISCOVERY | ENGINEERING | ADVERSARIAL | CC_DEV" ;;
esac
# Default de carpeta según el rol (discovery-room, engineering-room, ...).
[ -n "$DEST_DIR" ] || DEST_DIR="$(echo "$ROLE" | tr 'A-Z_' 'a-z-')-room"

# ----- 0b. La license key: de argv, o la que una pasada anterior ya dejo en el keyring -----
# El account bajo el que vive la key: el rol pelado, o '<tenantSlug>:<ROL>' cuando el room declara
# tenant (SPEC-0187 P7). Se resuelve ACA —antes de tocar el disco— porque de el depende si esta
# corrida necesita que le pasen la key.
LICENSE_ACCOUNT="$ROLE"
[ -z "$TENANT_SLUG" ] || LICENSE_ACCOUNT="$TENANT_SLUG:$ROLE"

# TKT-0307 — la instalacion es de DOS PASADAS (ver el paso 5) y la key la guarda la PRIMERA. Que la
# segunda la volviera a exigir convertia un reintento en un corte con exit 1 y obligaba al dev a
# tener la key a mano dos veces. Si el account ya la tiene, se reusa; solo se pide cuando no esta.
LICENSE_FROM_KEYRING=0
if [ -z "$LICENSE_KEY" ]; then
  if LICENSE_KEY="$(specoe_keyring_read "$LICENSE_ACCOUNT")" && [ -n "$LICENSE_KEY" ]; then
    LICENSE_FROM_KEYRING=1
    log "License key: reusando la que ya esta en el keyring (account=$LICENSE_ACCOUNT) — no hace falta pasarla de nuevo."
  else
    err "Falta la license key y el keyring tampoco la tiene bajo account='$LICENSE_ACCOUNT'.
  Uso: ./specoe-add-room.sh <ROL> <LICENSE_KEY> [--tenant <slug>]
  Si ya la habias guardado, revisá que el account coincida: es '<ROL>' cuando el room es single-tenant y '<tenantSlug>:<ROL>' cuando pasás --tenant. Cambiar el --tenant entre pasadas cambia el account."
  fi
fi

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
# CONSERVA (14). Lista INCLUSIVA: se enumera lo que se conserva, una entrada por linea con
# barra inicial. No son negaciones sobre '/*' — asi una entrada NUEVA del starter no llega al
# room por omision, que es el default seguro (y la contrapartida: cuando el starter suma algo
# que el room necesita, se agrega ACA a proposito).
#
# '/vendor/' es exactamente ese caso (SPEC-0165 P4 / T4.4, ADR-008): el .mcp.json que escribe
# setup.sh apunta al bundle del MCP integra-hub con path RELATIVO al cwd del room, asi que el
# artefacto tiene que estar dentro de la carpeta recortada o el entry apunta a la nada. Entra
# ACA a proposito, no por omision.
SPECOE_ROOM_KEEP='/.claude/
/.gitattributes
/.gitignore
/project.config.yaml
/setup.sh
/specoe-add-room.sh
/specoe-gate-messages.sh
/specoe-launch-thinclient.sh
/specoe-verify-room.sh
/specoe-yaml.sh
/README.md
/VERSION
/vendor/
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
  # '.specoe-config-pending' lo escribe el check de config de setup.sh cuando corta (TKT-0307) y lo
  # cubre el .gitignore del starter — pero un room clonado ANTES de esa linea no la tiene todavia,
  # y ahi el archivo aparece como untracked y frenaria la segunda pasada. Se nombra aca tambien.
  divergence="$(git -C "$DEST_DIR" status --porcelain)"
  unexpected="$(printf '%s\n' "$divergence" | grep -v -e '^$' -e '^ M project\.config\.yaml$' -e '^?? \.mcp\.json$' -e '^?? \.specoe-config-pending$' || true)"
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

# ----- 1b. El artefacto del MCP llego a la carpeta (SPEC-0165 P4 / T4.3) -----
# El --room-only de mas abajo escribe el entry integra-hub del .mcp.json apuntando a este bundle
# con path RELATIVO al cwd del room, y corta si no esta. Lo chequeamos tambien aca porque desde
# aca se puede nombrar la causa que el room solo no ve: el recorte. La carpeta del room NO es un
# clon completo del starter — la arma SPECOE_ROOM_KEEP, lista INCLUSIVA — asi que un starter con
# el release correcto igual deja el room SIN el artefacto si '/vendor/' no esta en esa lista.
# Va antes del keyring y de la identidad: si el artefacto no llego, el room no sirve igual.
[ -f "$DEST_DIR/vendor/integra-hub-mcp.mjs" ] || err "Falta el MCP integra-hub en '$DEST_DIR': no esta 'vendor/integra-hub-mcp.mjs'.
  Sin ese archivo el room no levanta el MCP integra-hub, asi que corto aca en vez de dejar la carpeta a medio configurar y terminar en verde.
  Hay DOS causas posibles y hay que descartar las dos:
    a) el starter que se clona ($STARTER_REPO) es anterior al release que vendoriza el MCP — actualizá el release y volvé a correr el MISMO comando;
    b) '/vendor/' no quedo en SPECOE_ROOM_KEEP (la lista INCLUSIVA de ESTE script): entonces el clon del room NO lo trae aunque el starter lo tenga.
  Para distinguirlas: git -C \"$DEST_DIR\" sparse-checkout list   (si '/vendor/' no figura, es (b))."

# ----- 2. Fijar el rol en el yaml de la carpeta -----
# specoe.role es la DECLARACIÓN del room: la consumen los launchers/UI para saber
# qué rol abrir acá. NO la leen los hooks ni termina en el .mcp.json (SPEC-0187 P2):
# el rol efectivo lo declara cada SESIÓN exportando INTEGRA_SDD_ROLE en su entorno,
# y el Hub lo autoriza server-side (claim x-sdd-role sin firma, SPEC-0157).
log "Fijando specoe.role='$ROLE' en project.config.yaml..."
sed -i.bak "s|role: '[^']*'|role: '$ROLE'|" "$DEST_DIR/project.config.yaml" && rm -f "$DEST_DIR/project.config.yaml.bak"

# SPEC-0187 P7 — specoe.tenant: la DECLARACION del tenant de este room. La consume el launcher
# (la exporta como INTEGRA_SDD_TENANT) y el hook de licencia la lee del yaml cuando la carpeta
# se abre a mano. La escritura va por specoe_yaml_set y no por un sed: el yaml de un room ya
# instalado es anterior a la clave, y un sed de reemplazo no tendria sobre que actuar — la
# corrida terminaria en verde con el tenant sin declarar, que es justo el estado que hace caer
# la sesion al fallback legacy sin que nadie lo note.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "$TENANT_SLUG" ]; then
  [ -f "$SCRIPT_DIR/specoe-yaml.sh" ] || err "Falta $SCRIPT_DIR/specoe-yaml.sh: no puedo declarar specoe.tenant='$TENANT_SLUG' en la carpeta.
  Corto en vez de seguir: el room quedaria con la licencia guardada bajo el tenant y sin declararlo, o sea sin poder encontrarla.
  Actualizá el starter (git -C \"$SCRIPT_DIR\" pull --ff-only) y volvé a correr el MISMO comando."
  # shellcheck source=specoe-yaml.sh
  source "$SCRIPT_DIR/specoe-yaml.sh"
  log "Fijando specoe.tenant='$TENANT_SLUG' en project.config.yaml..."
  specoe_yaml_set "$DEST_DIR/project.config.yaml" specoe.tenant "$TENANT_SLUG"
fi

# ----- 2b. TKT-0317 — specoe.work-repo: el repo donde vive el CODIGO de este room -----
# El room sabe su rol y su tenant, pero no sabia cual es su repo de trabajo, y las herramientas de
# aislamiento del agente asumen que el cwd lo es. El cwd es esta carpeta: un clon shallow del
# starter. Con la declaracion, el agente sabe donde correr `git worktree add`.
#
# Se escribe con specoe_yaml_set por lo mismo que el tenant: el yaml de un room ya instalado es
# anterior a la clave y un sed de reemplazo no tendria sobre que actuar.
#
# NO se corta cuando la ruta todavia no existe: un room se puede instalar antes de clonar el repo
# del codigo, y cortar ahi por algo recuperable dejaria la carpeta a medio configurar. Se declara
# igual y se avisa — y el chequeo que importa lo repite cada arranque de sesion el hook
# specoe-room-bootstrap.mjs, que es donde el dato se consume.
if [ -n "$WORK_REPO" ]; then
  [ -f "$SCRIPT_DIR/specoe-yaml.sh" ] || err "Falta $SCRIPT_DIR/specoe-yaml.sh: no puedo declarar specoe.work-repo='$WORK_REPO' en la carpeta.
  Corto en vez de seguir: el room quedaria sin saber cual es su repo de trabajo, que es justo lo que este flag viene a declarar.
  Actualizá el starter (git -C \"$SCRIPT_DIR\" pull --ff-only) y volvé a correr el MISMO comando."
  # shellcheck source=specoe-yaml.sh
  source "$SCRIPT_DIR/specoe-yaml.sh"
  # Barras normales: el valor lo consumen Git Bash, node y VSCode, y los tres entienden 'C:/x/y'.
  # Con backslashes, la ruta pasa por shells que los leen como escapes y llega partida.
  WORK_REPO_NORM="${WORK_REPO//\\//}"
  log "Fijando specoe.work-repo='$WORK_REPO_NORM' en project.config.yaml..."
  specoe_yaml_set "$DEST_DIR/project.config.yaml" specoe.work-repo "$WORK_REPO_NORM"
  if [ ! -e "$WORK_REPO_NORM/.git" ]; then
    warn "  ⚠ '$WORK_REPO_NORM' no es un repo git ahora mismo (no tiene .git)."
    warn "    La declaracion queda escrita igual. Si todavia no clonaste el repo del codigo, clonalo ahi."
    warn "    Si la ruta esta mal, corregí specoe.work-repo en '$DEST_DIR/project.config.yaml' — cada sesion del room lo vuelve a chequear y lo dice."
  fi
fi

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
#
# SPEC-0187 P7 — con tenant declarado el account es '<tenantSlug>:<ROL>': dos tenants en la
# misma maquina tienen licencias distintas para el MISMO rol, y con el account pelado la segunda
# pisaba a la primera. Sin --tenant el account sigue siendo el rol pelado (piloto intacto).
# ($LICENSE_ACCOUNT y $LICENSE_KEY quedaron resueltos en el paso 0b, antes de tocar el disco.)
KEYRING_OK=0
NODE_BIN="$(specoe_node_bin)"
if [ "$LICENSE_FROM_KEYRING" = 1 ]; then
  # La key SALIO de este mismo account: reescribirla no agrega nada y el log diria "guardando" una
  # key que el dev no paso, que es justo la confusion que TKT-0307 cierra.
  log "License key ya presente en el keyring (account=$LICENSE_ACCOUNT): no se reescribe."
  KEYRING_OK=1
elif keyring_out="$(specoe_keyring_write "$LICENSE_ACCOUNT" "$LICENSE_KEY")"; then
  # Capturamos stdout+stderr del proceso: NO silenciamos el error (el fallo mudo era el bug).
  # La verificacion post-escritura con getPassword() vive dentro de specoe_keyring_write.
  log "Guardando la license key en el keyring (account=$LICENSE_ACCOUNT)..."
  log "  License key guardada y verificada en el keyring (account=$LICENSE_ACCOUNT)."
  KEYRING_OK=1
else
  warn "  ⚠ NO se pudo persistir la license key en el keyring (account=$LICENSE_ACCOUNT) usando '$NODE_BIN'."
  warn "    Detalle real del error: ${keyring_out:-<el proceso no devolvió salida>}"
  warn "    → Sin la key en el keyring, el hook specoe-license-check NO valida y el MCP 'specoe' dará 401."
  warn "    Recuperá con UNA de estas opciones:"
  warn "      a) A mano con el mismo binario:  cd ~/.claude/hooks && $NODE_BIN -e \"const {Entry}=require('@napi-rs/keyring'); new Entry('specoe-license','$LICENSE_ACCOUNT').setPassword('$LICENSE_KEY')\"  → luego Reload Window en VSCode."
  warn "      b) Fallback env var:   exportá SPECOE_LICENSE_KEY antes de abrir el room."
fi

# ----- 4. Estado de la identidad SDD del equipo (SPEC-0157) -----
# Tambien ANTES del --room-only, por la misma razon que el bloque 3 (ADR-005): usa
# $HOME/.claude/scripts/sdd-login.mjs y $SCRIPT_DIR —el directorio de ESTE script, no el del
# room— asi que no depende del estado que deja el --room-only.
# El room declara el rol; la identidad (token de usuario + machineId) es de la
# MÁQUINA y la deja el login de specoe-setup-host.sh. Chequeo accionable acá:
# sin ese material, la sesión del room no va a poder operar contra el Hub.
# ($SCRIPT_DIR ya quedo resuelto en el bloque 2, con el mismo criterio.)
# SPEC-0187 P7 — con tenant declarado el status se pregunta POR ESE tenant: una maquina con
# identidad de otro tenant no es una maquina lista para ESTE room, y decir que si seria el
# verde falso que la fase cierra.
if [ -f "$HOME/.claude/scripts/sdd-login.mjs" ]; then
  if ( cd "$HOME/.claude/scripts" && INTEGRA_SDD_TENANT="$TENANT_SLUG" "$NODE_BIN" sdd-login.mjs status >/dev/null 2>&1 ); then
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
    warn "  - la license key guardada y verificada en el keyring (account=$LICENSE_ACCOUNT)."
  else
    warn "  - la license key NO quedo en el keyring (ver el detalle mas arriba y recuperala antes de seguir)."
  fi
  # El archivo lo escribe SOLO el corte del check de config; --room-only puede cortar por otras
  # causas (falta el vendor, etc.), asi que se nombra si esta, no porque el subshell haya fallado.
  if [ -f "$DEST_DIR/.specoe-config-pending" ]; then
    warn "  - los campos que faltan editar quedaron ademas en '$DEST_DIR/.specoe-config-pending', uno por linea (de ahi los lee el plugin de VSCode, que no ve esta salida)."
  fi
  if [ "$KEYRING_OK" = 1 ]; then
    err "Instalacion de DOS PASADAS: editá '$DEST_DIR/project.config.yaml' y volvé a correr el MISMO comando.
  La license key NO hace falta de nuevo: ya quedo en el keyring (account=$LICENSE_ACCOUNT) y la segunda pasada la lee de ahi (TKT-0307)."
  else
    err "Instalacion de DOS PASADAS: editá '$DEST_DIR/project.config.yaml' y volvé a correr el MISMO comando, esta vez CON la license key (no quedo en el keyring, ver arriba)."
  fi
fi

log ""
log "Room $ROLE listo en '$DEST_DIR'. Abrilo en VSCode: code \"$DEST_DIR\""
