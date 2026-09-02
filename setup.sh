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
# tenant — el tenant lo resuelve el server a partir del token. El rol es de la
# SESIÓN (SPEC-0187 P2): viaja como claim sin firma en INTEGRA_SDD_ROLE, exportada
# en el entorno del proceso por el launcher CLI o el plugin VSCode — el .mcp.json
# NO lo porta, el subproceso MCP lo hereda del entorno. El Hub lo autoriza
# server-side contra los roles concedidos a tu usuario.
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

# ----- Lectura/escritura de campos del yaml ANCLADAS a su seccion (SPEC-0167 P2, T2.1) -----
# `specoe_yaml_get` y `specoe_yaml_set` viven en specoe-yaml.sh desde SPEC-0187 P7: los
# necesitan tambien el launcher (exporta el tenant del room) y specoe-add-room.sh (lo fija).
# Una segunda copia del parser reintroduce el defecto que el helper vino a cerrar — dos
# lecturas del MISMO archivo con criterios distintos (TKT-0256).
# shellcheck source=specoe-yaml.sh
if [ -f "$SCRIPT_DIR/specoe-yaml.sh" ]; then
  source "$SCRIPT_DIR/specoe-yaml.sh"
else
  err "Falta $SCRIPT_DIR/specoe-yaml.sh — el helper que lee y escribe el project.config.yaml.
  Sin el, este instalador no puede resolver ni el rol ni el tenant de la carpeta, asi que corto en vez de seguir con valores vacios.
  Actualizá el starter de esta carpeta (git -C \"$SCRIPT_DIR\" pull --ff-only) y volvé a correr el MISMO comando."
fi

# ----- Universo del check de config (SPEC-0167 P2, ADR-003; partido en TKT-0309) -----
# BASE: lo que TODA carpeta necesita, sea un room SDD o un proyecto ERP.
# `paths.workspace-root` entra porque es un path absoluto al workspace del cliente: dejarlo en
# el valor del template apunta a una ruta que no existe en la maquina.
# Deliberadamente AFUERA: `specoe.role` y `hub.api-url`, porque los reescribe el propio
# instalador antes de que el check corra (el sed de specoe-add-room.sh y el de --hub de mas
# abajo). Compararlos daria falso positivo sobre una instalacion sana.
SPECOE_CONFIG_FIELDS_BASE="project.name project.vendor paths.workspace-root"

# ERP: los DOS campos del backend OpenEdge. Estaban en la lista unica hasta TKT-0309, asi que
# el alta de CUALQUIER room cortaba hasta que el dev declarara una base Progress y una instancia
# PASOE — que pueden no existir todavia, o no conocerse, cuando se instala un Discovery.
# Medido sobre el starter: el UNICO consumidor de los dos es `docker/gradle/build.gradle`
# (`pasoeInstance = '{{pasoe.instance-name}}'`), el build del webapp PASOE. Ni los hooks del
# bundle, ni el launcher, ni el plugin, ni el MCP los leen — y `docker/` ni siquiera queda en la
# carpeta de un room (specoe-add-room.sh lo recorta en SPECOE_ROOM_DROP). La lista obligatoria
# no coincidia con lo que el sistema consume: eso es el bug, no una preferencia de diseño.
SPECOE_CONFIG_FIELDS_ERP="database.logical-name pasoe.instance-name"

# `specoe_config_fields <yaml>` — universo obligatorio PARA ESTA CARPETA.
#
# Discriminador: `specoe.role`. Es la DECLARACION del room (la fija specoe-add-room.sh en su
# paso 2, ANTES del `setup.sh --room-only` del paso 5), asi que cuando el check corre sobre un
# room ya esta escrita. Vacia = no es un room SDD: es el proyecto ERP del cliente, y ahi los dos
# campos del backend siguen siendo obligatorios (el gate no se elimina, se acota).
#
# Falla hacia el comportamiento anterior: si el yaml no se puede leer o la clave no esta, el rol
# sale vacio y se exige el universo completo. Un starter viejo no relaja el check por accidente.
specoe_config_fields() {
  local role
  role="$(specoe_yaml_get "${1:-project.config.yaml}" specoe.role)"
  if [ -n "$role" ]; then
    echo "$SPECOE_CONFIG_FIELDS_BASE"
  else
    echo "$SPECOE_CONFIG_FIELDS_BASE $SPECOE_CONFIG_FIELDS_ERP"
  fi
}

# Fallback declarado de ADR-003: sentinelas literales del template, para cuando el yaml
# versionado del clone no se puede leer. Se desincronizan en silencio si el template cambia
# — por eso es fallback y por eso el check declara en la salida cuando corre por aca.
#
# TKT-0307 — los cinco valen 'CAMBIAR-ME' y no un valor plausible. El caso que lo motiva es
# `pasoe.instance-name`, cuyo valor de template era `oepas1`: tambien es una instancia PASOE real
# y frecuente, asi que el dev que lo dejaba porque le servia seguia contando como "sin editar" y
# el gate lo mandaba a cambiar algo que ya estaba bien. Una sentinela que nadie puede querer de
# verdad hace que "sin editar" y "editado" sean estados distinguibles sin ambiguedad.
# scripts/test-config-gate-fields.sh verifica que estos literales sigan siendo los del template.
specoe_config_sentinel() {
  case "$1" in
    project.name) echo "CAMBIAR-ME" ;;
    project.vendor) echo "CAMBIAR-ME" ;;
    paths.workspace-root) echo "CAMBIAR-ME" ;;
    database.logical-name) echo "CAMBIAR-ME" ;;
    pasoe.instance-name) echo "CAMBIAR-ME" ;;
  esac
}

# ----- 0. Parse argumentos -----

HUB_URL=""
DO_HOST=1  # parte de máquina: pre-req + bundle de hooks + sus dependencias vendorizadas
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
  # TKT-0314 — con el vendorizado esto ya no gobierna el npm install: lo hace el chequeo de
  # abajo. Sigue vivo para el unico caso que el chequeo no ve — una dependencia que resuelve
  # por node_modules (plataforma fuera del vendor) con el arbol local en versiones viejas.
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
  # TKT-0314 — el resolvedor de dependencias. Lo importan credentials.mjs, secrets.mjs,
  # specoe-license-check.mjs y specoe-room-bootstrap.mjs: si NO llega al host, esos cuatro
  # fallan en la RESOLUCION del import, o sea antes de su propio catch y sin mensaje.
  install_force "$BUNDLE_DIR/hooks/vendor-deps.mjs"               "$CLAUDE_HOME/hooks/vendor-deps.mjs"
  # ----- TKT-0321: los hooks del Hub -----
  #
  # Estos cuatro archivos son de `integra-hub` y viajan vendorizados (vendor/MANIFEST.json los
  # declara con su sourceSha). Hasta TKT-0321 se instalaban a mano, con `cp`, y SOLO en maquinas
  # que tuvieran ese repo clonado. El dev de un tenant no lo clona: consume el Hub por el MCP
  # vendorizado, asi que en su maquina NO habia ninguno de los tres — medido el 2026-08-11, cero
  # archivos y cero entradas en su settings.json. O sea que el gate de ack-task y el verificador
  # de claims, para el, no existian.
  #
  # El orden de estas cuatro lineas no importa (son copias), pero la PRESENCIA de cada una si:
  # el allowlist es POR ARCHIVO y un modulo que no este aca no llega, con el import fallando en
  # la RESOLUCION — antes del catch del hook, o sea sin mensaje y en cada arranque (TKT-0232).
  #
  # `hub-channel.mjs` va PRIMERO en la lista a proposito de lectura: es la dependencia de los
  # otros dos y la que decide con que identidad se habla al Hub.
  install_force "$BUNDLE_DIR/hooks/hub-channel.mjs"               "$CLAUDE_HOME/hooks/hub-channel.mjs"
  install_force "$BUNDLE_DIR/hooks/ack-task-session-init.mjs"     "$CLAUDE_HOME/hooks/ack-task-session-init.mjs"
  install_force "$BUNDLE_DIR/hooks/ack-task-enforcer.mjs"         "$CLAUDE_HOME/hooks/ack-task-enforcer.mjs"
  install_force "$BUNDLE_DIR/hooks/executable-verification-hub-mutation.mjs" "$CLAUDE_HOME/hooks/executable-verification-hub-mutation.mjs"
  # ----- TKT-0325 / TKT-0327: los dos hooks de disciplina de git -----
  #
  # Mismo agujero que arriba, un ticket despues: los dos vivian SOLO en la maquina del Operador,
  # que es la unica que clona integra-hub y corre su `hooks/install.mjs`. Para todo el resto la
  # regla que cada uno hace cumplir estaba escrita y sin diente.
  #
  # `block-destructive-outside-worktree.mjs` se vendoriza DESPUES de TKT-0327 a proposito: hasta
  # ese arreglo tenia un fail-OPEN en Windows (un path nativo entrecomillado no se bloqueaba) y
  # repartirlo antes habria distribuido el hueco junto con el freno.
  install_force "$BUNDLE_DIR/hooks/block-destructive-outside-worktree.mjs" "$CLAUDE_HOME/hooks/block-destructive-outside-worktree.mjs"
  install_force "$BUNDLE_DIR/hooks/block-no-verify.mjs"           "$CLAUDE_HOME/hooks/block-no-verify.mjs"

  # TKT-0362 — el auditor de los tres de arriba. Un hook puede no correr por tres motivos que
  # desde adentro de una sesion se ven identicos: no pasa nada. Este los distingue al arrancar.
  # Lee DOS manifiestos porque hay dos canales: el `integra-hooks-manifest.json` que escribe el
  # install.mjs de integra-hub (la maquina del Operador) y el `vendor/MANIFEST.json` de ACA, que
  # es el unico que tiene el dev de un tenant -- no clona integra-hub y nunca corre aquel script.
  install_force "$BUNDLE_DIR/hooks/hooks-audit.mjs"               "$CLAUDE_HOME/hooks/hooks-audit.mjs"

  # El slash command del gate. Sin el, el enforcer bloquea y el dev no tiene con que destrabarse:
  # el mensaje del bloqueo dice "corre /ack-task" y ese comando no existiria en su Claude Code.
  # `~/.claude/commands/` no lo poblaba nadie hasta ahora — de ahi el mkdir.
  mkdir -p "$CLAUDE_HOME/commands"
  install_force "$BUNDLE_DIR/commands/ack-task.md"                "$CLAUDE_HOME/commands/ack-task.md"
  install_force "$BUNDLE_DIR/scripts/provision-secrets.mjs"       "$CLAUDE_HOME/scripts/provision-secrets.mjs"
  install_force "$BUNDLE_DIR/scripts/sdd-login.mjs"               "$CLAUDE_HOME/scripts/sdd-login.mjs"
  # SPEC-0187 P5: el CLI del canal de identidad. Es la interfaz que consumen los procesos de
  # AFUERA del bundle (el plugin VSCode por child_process) — si no viaja al host, el consumidor
  # no tiene canal y vuelve a armarse su propio almacen de credenciales, que es el doble login
  # que la SPEC cierra. Importa ./sdd-login.mjs y ../hooks/{secrets,sdd-identity}.mjs, todos ya
  # en esta misma lista.
  install_force "$BUNDLE_DIR/scripts/specoe-identity.mjs"         "$CLAUDE_HOME/scripts/specoe-identity.mjs"
  # SPEC-0167 P3 (T3.4): el motor del verificador viaja al HOST. Antes no se instalaba en
  # ningun lado y specoe-verify-room.sh lo resolvia dentro de la carpeta del room
  # ($SCRIPT_DIR/.claude-bundle/scripts), que es justo lo que el recorte del room saca. Sus dos
  # imports son relativos a ../hooks/ (ca-channel.mjs y specoe-room-bootstrap.mjs), asi que
  # desde ~/.claude/scripts/ resuelven contra ~/.claude/hooks/, que este mismo bloque puebla.
  install_force "$BUNDLE_DIR/scripts/verify-room-serving.mjs"     "$CLAUDE_HOME/scripts/verify-room-serving.mjs"

  # ----- Dependencias de los hooks (TKT-0314) -----
  #
  # Antes esto era un `npm install` en la maquina del CLIENTE, con `|| warn` y la corrida
  # siguiendo de largo hasta el banner de exito. En una VM Windows del piloto ese npm aborta con
  # `Assertion failed: new_time >= loop->time, file src\win\core.c, line 327` —una assertion del
  # event loop de libuv, no un fallo de red— y no hay camino de recuperacion desde la maquina del
  # dev: reintentar, `npm ci`, borrar node_modules, resincronizar el reloj y reiniciar fallan
  # igual. El unico que funciono fue copiar node_modules desde otra maquina, que no es una
  # instruccion que se le pueda dar a un cliente.
  #
  # Ahora las dependencias VIAJAN vendorizadas en el bundle (mismo criterio que el MCP y el
  # plugin) y este bloque solo las copia y VERIFICA. El npm install queda como fallback para las
  # plataformas que el vendor no cubre, y su fallo ya no es un warn: si despues de todo los hooks
  # no pueden resolver sus dependencias, el host NO esta listo y la corrida corta aca.
  if [ -d "$BUNDLE_DIR/hooks/vendor" ]; then
    # Se borra antes de copiar: el vendor lo administra el instalador entero (no hay config del
    # usuario adentro) y una copia vieja podria dejar un .node de una version que ya no es la que
    # el loader del keyring espera.
    rm -rf "$CLAUDE_HOME/hooks/vendor"
    cp -R "$BUNDLE_DIR/hooks/vendor" "$CLAUDE_HOME/hooks/vendor"
    log "  [FORCE]   $CLAUDE_HOME/hooks/vendor (dependencias vendorizadas)"

    # TKT-0335 — @napi-rs/keyring es el UNICO paquete vendorizado que un consumidor puede pedir
    # por `require()` PELADO en vez de por el loader de vendor-deps.mjs: specoe-add-room.sh
    # (specoe_keyring_read/write) hace `require('@napi-rs/keyring')` desde $CLAUDE_HOME/hooks
    # porque es Bash y no puede importar un modulo ESM con path relativo. Ese require() resuelve
    # por Node module resolution — sube directorios desde el cwd buscando
    # node_modules/@napi-rs/keyring — y sin este paso nunca lo encuentra, aunque vendor/keyring/
    # este completo y su hash sea correcto: el check de vendor-deps.mjs de mas abajo prueba el
    # import() POR PATH (el camino que usan los hooks .mjs), no el require() pelado, asi que
    # reportaba "OK" sobre una instalacion que specoe-add-room.sh no podia usar.
    # Corre SIEMPRE, no solo cuando `uname` da Linux: el gap es de Node module resolution, no de
    # plataforma — cualquiera de las 5 de vendor/MANIFEST.json lo pisa igual sin este mapeo.
    rm -rf "$CLAUDE_HOME/hooks/node_modules/@napi-rs/keyring"
    mkdir -p "$CLAUDE_HOME/hooks/node_modules/@napi-rs"
    cp -R "$CLAUDE_HOME/hooks/vendor/keyring" "$CLAUDE_HOME/hooks/node_modules/@napi-rs/keyring"
    log "  [FORCE]   $CLAUDE_HOME/hooks/node_modules/@napi-rs/keyring (mapeo para require() pelado)"
  else
    warn "  [MISSING] $BUNDLE_DIR/hooks/vendor — bundle sin dependencias vendorizadas; queda el npm install de fallback"
  fi

  # El chequeo corre POR EL MISMO CAMINO que usan los hooks (vendor primero, node_modules
  # despues): un probe que importara distinto no probaria nada.
  # `$(specoe_node_bin)` y no `node` pelado: en Git Bash el `node` del PATH esta envuelto por
  # winpty y eso rompe la carga del modulo NATIVO del keyring, que es justo lo que se mide aca.
  DEPS_NODE_BIN="$(specoe_node_bin)"
  set +e
  DEPS_REPORT="$("$DEPS_NODE_BIN" "$CLAUDE_HOME/hooks/vendor-deps.mjs" --check 2>&1)"
  DEPS_STATUS=$?
  set -e

  # Cuando corre el fallback de npm. Dos casos, y el segundo es el que el probe solo no ve:
  #   1. alguna dependencia no resuelve por ningun camino;
  #   2. alguna resuelve por node_modules Y el package.json del bundle cambio — el arbol local
  #      satisface el import pero con las versiones viejas, que es como una dep nueva no llegaba
  #      a maquinas ya instaladas antes de que existiera DEPS_CHANGED.
  # Si TODAS resuelven por vendor, DEPS_CHANGED es irrelevante: el vendor se acaba de pisar
  # entero con el del bundle.
  NEEDS_NPM=0
  if [ "$DEPS_STATUS" -ne 0 ]; then
    NEEDS_NPM=1
  elif [ "$DEPS_CHANGED" -eq 1 ] && printf '%s\n' "$DEPS_REPORT" | grep -q ' node_modules'; then
    NEEDS_NPM=1
  fi

  if [ "$NEEDS_NPM" -eq 1 ]; then
    log "  Dependencias que el vendor no cubre en esta plataforma ($(uname -s)/$(uname -m)) — npm install de fallback..."
    if [ -f "$CLAUDE_HOME/hooks/package.json" ]; then
      (cd "$CLAUDE_HOME/hooks" && npm install --silent) || warn "  npm install fallo"
    fi
    set +e
    DEPS_REPORT="$("$DEPS_NODE_BIN" "$CLAUDE_HOME/hooks/vendor-deps.mjs" --check 2>&1)"
    DEPS_STATUS=$?
    set -e
  fi

  # TKT-0335 — el probe de arriba (vendor-deps.mjs --check) mide el camino de import() POR PATH
  # que usan los hooks .mjs; NO mide el require() PELADO que usa specoe-add-room.sh (Bash, no
  # puede importar vendor-deps.mjs). Sin este segundo probe el check reportaba "OK" sobre una
  # instalacion donde specoe-add-room.sh seguia rompiendo con 'Cannot find module
  # @napi-rs/keyring': son dos mecanismos de resolucion de Node distintos y el gate terminal
  # tiene que cubrir los dos, no solo el que los hooks .mjs usan.
  set +e
  KEYRING_REQUIRE_REPORT="$(cd "$CLAUDE_HOME/hooks" && "$DEPS_NODE_BIN" -e "require('@napi-rs/keyring').Entry" 2>&1)"
  KEYRING_REQUIRE_STATUS=$?
  set -e
  if [ "$KEYRING_REQUIRE_STATUS" -eq 0 ]; then
    DEPS_REPORT="$DEPS_REPORT
@napi-rs/keyring (require pelado, specoe-add-room.sh) node_modules"
  else
    DEPS_STATUS=1
    DEPS_REPORT="$DEPS_REPORT
@napi-rs/keyring (require pelado, specoe-add-room.sh) FALTA — $KEYRING_REQUIRE_REPORT"
  fi

  if [ "$DEPS_STATUS" -ne 0 ]; then
    err "Las dependencias de los hooks NO quedaron resueltas. El host NO esta listo.

  Estado por dependencia (vendor = copia del bundle, node_modules = npm local, FALTA = ninguna):
$(printf '%s\n' "$DEPS_REPORT" | sed 's/^/    /')

  QUE SIGNIFICA: sin el binding nativo de @napi-rs/keyring no hay keyring, y sin keyring
  specoe-add-room.sh no puede persistir la license key ('la license key NO quedo en el keyring'),
  el hook specoe-license-check no valida y el MCP specoe responde 401. Nada de eso se va a
  parecer a este error cuando aparezca, asi que la corrida corta ACA y no anuncia 'Host listo'.

  COMO SALIR:
   1. Verifica que el bundle traiga el vendor: ls $BUNDLE_DIR/hooks/vendor
      Si no existe, el starter que estas usando es anterior a TKT-0314: actualizalo
      (git -C <starter> pull) y volve a correr specoe-setup-host.sh.
   2. Si el vendor existe pero tu plataforma no esta cubierta ($(uname -s)/$(uname -m)),
      el fallback es el npm install que acaba de fallar. Su salida esta arriba de este mensaje.
   3. Pedi al equipo de Integra que agregue tu plataforma al vendor citando TKT-0314 y el
      resultado de: node -p \"process.platform + '/' + process.arch\""
  fi

  log "  Dependencias de los hooks OK:"
  printf '%s\n' "$DEPS_REPORT" | sed 's/^/    /'
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

# SPEC-0187 P7 — el login guarda la identidad bajo las claves de ESE tenant. Si la carpeta no
# declara ninguno, se lo dejamos declarado con el slug que acaba de devolver el Hub: sin eso,
# una carpeta con dos tenants en la maquina no sabria cual de las dos identidades es la suya, y
# la sesion arrancaria con el aviso de "no declara tenant" el primer dia. No se pisa un tenant
# ya declarado: si la carpeta dice otro, esa declaracion es del operador y el aviso del arranque
# es la respuesta correcta, no una reescritura silenciosa.
if [ -n "$TENANT_SLUG" ] && [ -f project.config.yaml ]; then
  ROOM_TENANT_ACTUAL="$(specoe_yaml_get project.config.yaml specoe.tenant)"
  if [ -z "$ROOM_TENANT_ACTUAL" ]; then
    specoe_yaml_set project.config.yaml specoe.tenant "$TENANT_SLUG"
    log "  specoe.tenant='$TENANT_SLUG' declarado en project.config.yaml (lo exporta el launcher como INTEGRA_SDD_TENANT)."
  elif [ "$ROOM_TENANT_ACTUAL" != "$TENANT_SLUG" ]; then
    warn "  Esta carpeta declara specoe.tenant='$ROOM_TENANT_ACTUAL' y el login fue del tenant '$TENANT_SLUG'."
    warn "    → No lo piso: si la carpeta es del otro tenant, hacé el login con el usuario de ESE tenant; si la declaracion esta mal, corregila a mano."
  fi
fi
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

# Este check CORTA (SPEC-0167 P2, ADR-003). Antes solo verificaba que los campos obligatorios no
# estuvieran vacios, y el propio script admitia el hueco a continuacion: con los valores del
# template el check pasaba y el flujo fallaba varios pasos despues, lejos de la causa.
#
# QUE campos son obligatorios lo decide la carpeta, no el script (TKT-0309): un room SDD pide el
# universo BASE; el proyecto ERP pide ademas los dos del backend OpenEdge. Ver
# `specoe_config_fields` mas arriba.
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

SPECOE_CONFIG_FIELDS="$(specoe_config_fields project.config.yaml)"
CONFIG_ROOM_ROLE="$(specoe_yaml_get project.config.yaml specoe.role)"
if [ -n "$CONFIG_ROOM_ROLE" ]; then
  log "  Carpeta declarada como room SDD (specoe.role='$CONFIG_ROOM_ROLE'): el check NO exige los campos del backend OpenEdge ($SPECOE_CONFIG_FIELDS_ERP) — no los lee nada del flujo SDD (TKT-0309)."
else
  log "  Carpeta sin specoe.role: se valida como proyecto ERP, con los campos del backend OpenEdge incluidos."
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

# TKT-0307 — el corte deja ademas un archivo legible por maquina con UN campo pendiente por linea.
# Por que: cuando el alta la dispara el plugin de VSCode, esta salida vive en un terminal que muere
# con el proceso y se lleva la remediacion puesta — el dev ve "exit code: 1" y nada mas. El archivo
# es el unico canal que sobrevive al terminal, y lo escribe el MISMO paso que decide el corte: si la
# lista viviera del lado del plugin serian dos criterios para el mismo gate, que es el defecto que
# TKT-0256 cerro en la lectura del yaml. Su PRESENCIA es el estado "config sin terminar": lo escribe
# el corte y lo borra el paso que pasa, mas abajo.
CONFIG_PENDING_FILE=".specoe-config-pending"

if [ -n "$CONFIG_EMPTY_FIELDS" ] || [ -n "$CONFIG_TEMPLATE_FIELDS" ]; then
  : >"$CONFIG_PENDING_FILE"
  for field in $CONFIG_EMPTY_FIELDS $CONFIG_TEMPLATE_FIELDS; do
    echo "$field" >>"$CONFIG_PENDING_FILE"
  done
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

# La config quedo completa: se borra la marca del corte anterior. Sin esto, un room que YA paso
# seguiria mostrando campos pendientes al plugin — el archivo es estado, no bitacora.
rm -f "$CONFIG_PENDING_FILE"

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
#   - integra-hub (SPEC-0157): modo USER — la identidad sale del keyring (login SDD). El rol
#     NO va en este archivo (SPEC-0187 P2): es de la SESIÓN — INTEGRA_SDD_ROLE la exporta el
#     launcher CLI o el plugin VSCode y el subproceso MCP la hereda del entorno, así hook,
#     cliente MCP y header x-sdd-role leen EL MISMO valor por construcción. SIN secretos
#     act-as, SIN credenciales, SIN cuid de tenant: el tenant lo resuelve el server a partir
#     del token del usuario.
# Idempotente y preservador: no pisa `specoe` si ya existe ni borra otros servers; el entry
# `integra-hub` sí se regenera (es config derivada del yaml, no estado del dev) — y esa
# regeneración es también la migración: una re-corrida sobre un .mcp.json viejo que traía
# INTEGRA_SDD_ROLE la elimina.

# Precondicion dura del artefacto del MCP (SPEC-0165 P4 / T4.2). El entry integra-hub que se
# escribe abajo apunta al bundle VENDORIZADO con path relativo al cwd del room — el mismo cwd
# desde el que corre este script. Si el archivo no esta y lo escribimos igual, el .mcp.json
# queda apuntando a la nada y la corrida termina en el "Setup base completado" de mas abajo:
# verde con el room sin MCP, que es exactamente el defecto que esta SPEC viene a cerrar. Se
# corta ANTES de escribir, con err — mismo patron que el corte por identidad del login.
MCP_BUNDLE="vendor/integra-hub-mcp.mjs"
[ -f "$MCP_BUNDLE" ] || err "Falta el MCP integra-hub: no esta el bundle '$MCP_BUNDLE' en esta carpeta.
  Sin ese archivo el room no puede levantar el MCP integra-hub, asi que corto en vez de escribir un .mcp.json que apunte a la nada.
  Hay DOS causas posibles y hay que descartar las dos:
    a) el starter de esta carpeta es anterior al release que vendoriza el MCP — actualizalo (git -C \"$SCRIPT_DIR\" pull --ff-only) y volvé a correr el MISMO comando;
    b) esta carpeta es un room recortado y '/vendor/' no quedo en SPECOE_ROOM_KEEP (la lista INCLUSIVA de specoe-add-room.sh): entonces el clon del room NO lo trae aunque el starter lo tenga.
  Para distinguirlas: git -C \"$SCRIPT_DIR\" sparse-checkout list   (si no devuelve nada, esta carpeta no es un room recortado y es (a); si devuelve la lista y '/vendor/' no figura, es (b))."

log "Generando/actualizando .mcp.json (specoe + integra-hub modo USER)..."

# TKT-0256: las dos lineas leian el MISMO archivo con criterios DISTINTOS — el sed de `role`
# strippeaba comilla simple + comentario inline, el de `api-url` solo comillas dobles. Como el
# template trae `api-url: 'https://...'` entre comillas SIMPLES, la URL viajaba con las comillas
# adentro hasta INTEGRA_HUB_API_URL del .mcp.json y hasta integraHub.baseUrl del settings del room.
# Ninguna de las dos se parchea suelta: las dos pasan por specoe_yaml_get, que ya resuelve comilla
# simple, comilla doble, valor pelado y comentario inline, y ademas scopea por seccion (asi una
# clave homonima de otro bloque no gana por estar antes en el archivo).
ROOM_ROLE="$(specoe_yaml_get project.config.yaml specoe.role)"
MCP_HUB_URL="${HUB_URL:-$(specoe_yaml_get project.config.yaml hub.api-url)}"
MCP_HUB_URL="${MCP_HUB_URL:-https://hub.integra.local/api/v1}"
ROOM_TENANT="$(specoe_yaml_get project.config.yaml specoe.tenant)"
# SPEC-0187 P7 — el tenant tampoco viaja al .mcp.json, por la misma razon que el rol (P2): es de
# la SESION. El launcher lo exporta como INTEGRA_SDD_TENANT desde esta clave, y el hook de
# licencia la lee del yaml cuando la carpeta se abre a mano.
if [ -n "$ROOM_TENANT" ]; then
  log "  specoe.tenant='$ROOM_TENANT' — identidad y licencia de esta carpeta se resuelven bajo ese tenant."
else
  log "  specoe.tenant vacío — la carpeta opera en modo single-tenant (claves sin dimension tenant). Declaralo con specoe-add-room.sh --tenant <slug> o corriendo ./setup.sh --login."
fi
[ -n "$ROOM_ROLE" ] || warn "  specoe.role está vacío en project.config.yaml — es la DECLARACIÓN del rol del room, la consumen los launchers/UI (nunca los hooks ni el .mcp.json: el rol efectivo lo declara cada SESIÓN exportando INTEGRA_SDD_ROLE, SPEC-0187 P2). Fijalo con specoe-add-room.sh <ROL>."

NODE_BIN="$(specoe_node_bin)"
MCP_CA="$(specoe_local_ca)"

"$NODE_BIN" - "$MCP_HUB_URL" "$MCP_CA" "$MCP_BUNDLE" <<'EOF'
const fs = require('fs');
const [hubUrl, caPath, bundle] = process.argv.slice(2);
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

// integra-hub: SIEMPRE al shape USER-mode (config derivada — sin secretos). El command sigue
// siendo `node` con path RELATIVO al cwd del room (modelo stdio sin cambios): lo que cambia es
// a QUE apunta — el bundle vendorizado que viene dentro de la carpeta (SPEC-0165 P4 / T4.1),
// no un node_modules/ que este instalador nunca instala. La existencia del archivo ya se
// verifico mas arriba con err.
// SPEC-0187 P2: INTEGRA_SDD_ROLE ya NO se escribe aca. El rol es de la SESION (lo exporta el
// launcher CLI o el plugin VSCode) y el subproceso MCP lo hereda del entorno del proceso que
// lo spawnea — hook, cliente MCP y header x-sdd-role leen EL MISMO valor por construccion
// (verificado en el Step 0 de la fase, AP9). Reescribir el entry completo es tambien la
// migracion: si un .mcp.json previo traia la clave, la regeneracion la elimina.
const hadRole = Boolean(
  doc.mcpServers['integra-hub'] &&
  doc.mcpServers['integra-hub'].env &&
  doc.mcpServers['integra-hub'].env.INTEGRA_SDD_ROLE
);
const env = {
  INTEGRA_HUB_API_URL: hubUrl,
  INTEGRA_SDD_IDENTITY_MODE: 'USER',
};
if (caPath) env.NODE_EXTRA_CA_CERTS = caPath;
// --use-system-ca: SEGUNDO camino al mismo CA, independiente del env (TKT-0261). El bundle
// vendorizado NO arma canal de CA propio: su unica via era NODE_EXTRA_CA_CERTS, o sea que la
// validacion TLS dependia de que el cliente propagara ese `env` al proceso hijo — y la sesion
// de la extension de VSCode no lo propaga, con lo que toda tool del MCP devolvia `fetch failed`
// mudo. El CA de Caddy ya esta en el trust del sistema (lo instala specoe-setup-host.sh en el
// paso del UAC) y este flag hace que Node lo lea de ahi. SPEC-0164 lo habia descartado para los
// hooks porque es flag de CLI e "inservible cuando el proceso lo spawnea otro"; aca el que
// spawnea es el que escribe los args, asi que si sirve. El env se CONSERVA a proposito: el
// objetivo son dos caminos independientes al mismo CA, no reemplazar uno por otro.
doc.mcpServers['integra-hub'] = {
  command: 'node',
  args: ['--use-system-ca', bundle],
  env,
};
if (hadRole) console.log('  [MIGRATE] mcpServers.integra-hub: INTEGRA_SDD_ROLE eliminada — el rol es de la sesion (SPEC-0187 P2)');
console.log('  [WRITE]   mcpServers.integra-hub (modo USER, sin rol: lo declara la sesion por entorno)');

fs.writeFileSync('.mcp.json', JSON.stringify(doc, null, 2) + '\n');
EOF

# ----- 5.6. (LIBRE) -----
# Acá vivía «Instalar el plugin VSCode Integra Hub». SPEC-0187 P9 / T9.1 lo MUDÓ al flujo de
# máquina (specoe-setup-host.sh, paso 6), porque su frecuencia real es por-máquina y no por-room:
# el .vsix se instala en el VSCode del usuario, no en esta carpeta. Estando acá, cada room nuevo
# repetía la instalación y —peor— el corte duro por falta del CLI `code` mataba la corrida de un
# room en máquinas donde el plugin YA estaba puesto, y en máquinas solo-CLI que no lo necesitan.
# El room-flow ya NO chequea el CLI `code` ni corta por él.
# El criterio anti-verde-falso de SPEC-0165 P5 NO se perdió en la mudanza: viaja con el paso como
# el caso (b) de la matriz del host-flow (VSCode presente sin el CLI → err duro, no warn).

# ----- 5.7. baseUrl del plugin en el settings de workspace del room -----
# Decision del Operador sobre Q1 (2026-07-27, "Usable solo baseUrl"): el instalador puebla
# integraHub.baseUrl —dato que ya resolvio arriba en MCP_HUB_URL— y NO toca integraHub.rooms,
# que sigue siendo config del usuario (ADR-006 de SPEC-0158 queda intacto).
# Va al settings de WORKSPACE de ESTA carpeta y no al global del usuario: el modelo del starter
# es N rooms por maquina y cada uno puede apuntar a un Hub distinto; el plugin resuelve con la
# precedencia estandar folder > workspace > user > default, asi que el nivel de workspace alcanza
# sin pisar nada del dev. Ademas .vscode/settings.json ya esta en el .gitignore del starter (:8),
# asi que la escritura no ensucia el git status del room ni viaja al espejo.

log "Configurando integraHub.baseUrl en .vscode/settings.json..."
mkdir -p .vscode

"$NODE_BIN" - "$MCP_HUB_URL" <<'EOF'
const fs = require('fs');
const [hubUrl] = process.argv.slice(2);
const FILE = '.vscode/settings.json';

// MERGE de claves, NO reescritura del archivo (risk_flag de P5): este archivo es del dev y una
// re-corrida no puede perderle la config. Si el archivo existe y NO parsea como JSON estricto
// —settings.json admite comentarios y VSCode los tolera— NO lo tocamos: preferimos dejar el
// baseUrl sin poblar y decirlo, antes que pisar configuracion ajena.
let doc = {};
let existing = null;
try {
  existing = fs.readFileSync(FILE, 'utf8');
} catch {
  /* no existe: se crea de cero */
}
if (existing !== null && existing.trim() !== '') {
  try {
    const parsed = JSON.parse(existing);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('el contenido no es un objeto JSON');
    doc = parsed;
  } catch (e) {
    console.error(`  [SKIP]    .vscode/settings.json existe y no pude leerlo como JSON (${e.message}).`);
    console.error(`            NO lo toco para no perderte configuracion. Agregale a mano esta clave: "integraHub.baseUrl": "${hubUrl}"`);
    process.exit(0);
  }
}

doc['integraHub.baseUrl'] = hubUrl;
fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');
console.log(`  [WRITE]   integraHub.baseUrl = ${hubUrl}`);
EOF

# ----- 5.8. Activar los hooks del Hub en el settings del room (TKT-0321) -----
#
# COPIAR NO ES ACTIVAR. El bloque de MAQUINA de mas arriba deja los cuatro hooks del Hub en
# ~/.claude/hooks/, pero un hook que no esta registrado en un settings.json no corre nunca. El
# `ls` los muestra instalados y el gate no existe: es el modo de falla con mas riesgo de pasar
# por bueno, y esta medido en la maquina del Staff, donde ack-task-enforcer.mjs esta en disco y
# NO figura en el settings.
#
# POR QUE EN EL SETTINGS DEL ROOM Y NO EN EL DEL HOST: el enforcer no mira el cwd — solo el
# tool_name y el session_id. Registrado a nivel maquina gatearia TODA sesion de Claude Code de
# esa computadora, incluidos los proyectos que no son de Integra, y es fail-CLOSED. El settings
# del room acota el gate a los rooms, que es exactamente su alcance.
#
# POR QUE ADEMAS DE VENIR EN EL ARCHIVO VERSIONADO: el .claude/settings.json del starter cubre
# los rooms NUEVOS. Este merge cubre los que YA existen — el dev re-corre specoe-add-room.sh (que
# hace el pull y llama a este mismo --room-only) y las entradas aparecen. Si el archivo divergio,
# el pull --ff-only corta y el archivo versionado no llegaria: el merge es lo que hace que la
# activacion no dependa de que el clon quede limpio.
#
# MERGE, NO REESCRITURA, y por identidad del ARCHIVO del hook: si ya hay una entrada que nombra
# al hook, no se toca (el dev puede haberle cambiado el timeout). Solo se agregan las que faltan.
log "Activando los hooks del Hub en .claude/settings.json..."
mkdir -p .claude

"$NODE_BIN" - <<'EOF'
const fs = require('fs');
const FILE = '.claude/settings.json';

// Las tres activaciones. `match` es la subcadena que identifica al hook dentro del `command`:
// alcanza el nombre del archivo y no hay dos hooks con el mismo.
const ENTRIES = [
  {
    event: 'SessionStart',
    matcher: null,
    match: 'ack-task-session-init.mjs',
    hook: { type: 'command', command: 'node $HOME/.claude/hooks/ack-task-session-init.mjs', timeout: 5, shell: 'bash' },
  },
  {
    event: 'PreToolUse',
    // IC-08: lista exacta, NO regex libre. El propio hook la re-chequea como cinturon.
    matcher: 'Edit|Write|Bash|NotebookEdit',
    match: 'ack-task-enforcer.mjs',
    hook: { type: 'command', command: 'node $HOME/.claude/hooks/ack-task-enforcer.mjs', timeout: 5, shell: 'bash' },
  },
  // TKT-0325 / TKT-0327 — los dos de disciplina de git, matcher Bash. Van en el settings del
  // ROOM por el mismo motivo que el enforcer: miran el comando, no el cwd. A nivel maquina
  // gatearian TODA sesion de Claude Code de esa computadora, incluidos proyectos que no son de
  // Integra — y las dos reglas que hacen cumplir son de los repos de Integra, no del universo.
  {
    event: 'PreToolUse',
    matcher: 'Bash',
    match: 'block-destructive-outside-worktree.mjs',
    hook: { type: 'command', command: 'node $HOME/.claude/hooks/block-destructive-outside-worktree.mjs', timeout: 5, shell: 'bash' },
  },
  {
    event: 'PreToolUse',
    matcher: 'Bash',
    match: 'block-no-verify.mjs',
    hook: { type: 'command', command: 'node $HOME/.claude/hooks/block-no-verify.mjs', timeout: 5, shell: 'bash' },
  },
  // TKT-0362 — el auditor de los tres de arriba. `SessionStart` y SIN matcher: ese evento no
  // acepta ninguno (verificado contra los settings vivos, el global y el de este starter), y
  // ponerle uno seria declarar un cableado que Claude Code no aplica.
  {
    event: 'SessionStart',
    matcher: null,
    match: 'hooks-audit.mjs',
    hook: { type: 'command', command: 'node $HOME/.claude/hooks/hooks-audit.mjs', timeout: 5, shell: 'bash' },
  },
];

// El verificador de claims va por tool del MCP: una entrada por mutacion del Hub que admite
// tokens de verificacion. Es la misma lista que corre hoy en las maquinas del equipo.
for (const tool of [
  'spec_comment',
  'spec_log_decision',
  'spec_log_bugfix',
  'spec_create',
  'spec_update_phase',
  'decision_create',
]) {
  ENTRIES.push({
    event: 'PreToolUse',
    matcher: `mcp__integra-hub__${tool}`,
    match: 'executable-verification-hub-mutation.mjs',
    hook: { type: 'command', command: 'node $HOME/.claude/hooks/executable-verification-hub-mutation.mjs', timeout: 15, shell: 'bash' },
  });
}

let doc = {};
let existing = null;
try {
  existing = fs.readFileSync(FILE, 'utf8');
} catch {
  /* no existe: se crea de cero */
}
if (existing !== null && existing.trim() !== '') {
  try {
    const parsed = JSON.parse(existing);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('el contenido no es un objeto JSON');
    doc = parsed;
  } catch (e) {
    // Mismo criterio que el settings de VSCode: antes que pisar configuracion ajena, no tocar y
    // decirlo. Pero aca lo que queda sin activar es un GATE, asi que el mensaje lo nombra.
    console.error(`  [SKIP]    .claude/settings.json existe y no pude leerlo como JSON (${e.message}).`);
    console.error('            NO lo toco para no perderte configuracion — pero OJO: sin las entradas de PreToolUse');
    console.error('            los hooks del Hub estan copiados y NO corren. Arreglale el JSON al archivo y volve a');
    console.error('            correr el mismo comando, o copiale las entradas del .claude/settings.json del starter.');
    process.exit(0);
  }
}

doc.hooks = doc.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks) ? doc.hooks : {};

let agregadas = 0;
for (const entry of ENTRIES) {
  const grupos = Array.isArray(doc.hooks[entry.event]) ? doc.hooks[entry.event] : [];
  doc.hooks[entry.event] = grupos;

  const yaEsta = grupos.some(
    (g) =>
      (g?.matcher ?? null) === entry.matcher &&
      Array.isArray(g?.hooks) &&
      g.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(entry.match)),
  );
  if (yaEsta) continue;

  // Se agrega un grupo propio en vez de meter el hook en uno existente: los grupos se
  // distinguen por `matcher`, y meter un hook con otro matcher adentro de un grupo ajeno le
  // cambiaria el disparo a los dos.
  const grupo = entry.matcher === null ? { hooks: [entry.hook] } : { matcher: entry.matcher, hooks: [entry.hook] };
  grupos.push(grupo);
  agregadas += 1;
}

if (agregadas === 0) {
  console.log('  [OK]      los hooks del Hub ya estaban activados');
} else {
  fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');
  console.log(`  [WRITE]   ${agregadas} entrada(s) de hook agregada(s) a .claude/settings.json`);
}
EOF

fi # cierra: if DO_ROOM (parte de carpeta — config + .mcp.json + settings de workspace)

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
  # El plugin ya no se instala acá (SPEC-0187 P9 / T9.1): nombrar quién lo hace evita que el dev
  # lo dé por instalado por haber corrido este script.
  log "  (el plugin VSCode Integra Hub lo instala el flujo de MÁQUINA —specoe-setup-host.sh, paso 6—, 1 vez por máquina y no por room)"
  log ""
  # TKT-0256: mismo criterio que la lectura del paso 5.5 — el resumen final mostraba la URL con
  # las comillas simples del template adentro, o sea distinta de la que decia haber configurado.
  HUB_SHOW="$(specoe_yaml_get project.config.yaml hub.api-url)"
  log "Hub: ${HUB_SHOW:-<no configurado>}"
  log "(default piloto interno: hub.integra.local. Suite on-premise: contactar a Integra Software)"
fi
