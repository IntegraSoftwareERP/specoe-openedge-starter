#!/usr/bin/env bash
# specoe-yaml.sh — lectura y escritura de escalares del project.config.yaml, ancladas a su
# seccion. Se SOURCEA (no se ejecuta): define `specoe_yaml_get` y `specoe_yaml_set`.
#
# POR QUE ES UN ARCHIVO APARTE (SPEC-0187 P7)
#
# `specoe_yaml_get` nacio adentro de setup.sh (SPEC-0167 P2, T2.1). Desde esta fase lo necesita
# tambien specoe-launch-thinclient.sh —para exportar el tenant del room— y specoe-add-room.sh
# —para fijarlo—. Una segunda copia del parser es exactamente el defecto que el helper vino a
# cerrar: dos lecturas del MISMO archivo con criterios distintos (TKT-0256). Vive una sola vez
# y lo sourcean los tres.
#
# La lectura esta ANCLADA a la seccion: el validador viejo hacia
# `grep -E "^\s*<clave>:" | head -1` sobre el archivo entero, asi que una clave homonima
# ubicada antes ganaba y el chequeo evaluaba un campo distinto del que declaraba evaluar.
# Andaba por el orden de las claves del template, no por construccion.

# `specoe_yaml_get <archivo> <seccion>.<clave>` — valor de la clave DENTRO de su seccion.
# Devuelve vacio si la seccion o la clave no estan. Quita comillas y comentario inline.
#
# SPEC-0208 P5 — sobre una clave escrita como LISTA en flow (`clave: ['a', 'b']`) devuelve el
# texto entre corchetes tal cual, porque el valor no empieza con comilla. Eso es a proposito:
# quien necesite la lista ya parseada usa `specoe_yaml_get_list`, y los demas callers (todos
# escalares) no cambian de comportamiento.
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

# `_specoe_yaml_write <archivo> <seccion>.<clave> <valor> <comilla>` — nucleo de la escritura.
# `<comilla>` es la comilla con la que se envuelve el valor: `'` para un escalar, vacia para
# escribir el valor CRUDO (lo que necesita una lista en flow, que ya trae sus propias comillas
# adentro de los corchetes). Separado de `specoe_yaml_set` en SPEC-0208 P5; el comportamiento
# del escalar es identico al de antes.
#
# INSERTA LA CLAVE SI NO ESTA. Es el caso de todo room ya instalado: su project.config.yaml es
# anterior a la clave `specoe.tenant` y un sed de reemplazo no tendria sobre que actuar — el
# instalador terminaria en verde con el tenant sin declarar, que es el estado que hace caer la
# sesion al fallback legacy sin que nadie lo note. Si la seccion tampoco esta, se agrega al
# final del archivo.
_specoe_yaml_write() {
  local file="$1" section="${2%%.*}" key="${2#*.}" value="$3" quote="$4" tmp
  [ -f "$file" ] || return 1
  tmp="$file.specoe-yaml.tmp"
  awk -v sec="$section" -v key="$key" -v val="$value" -v q="$quote" '
    function emitir(indent) {
      printf "%s%s: %s%s%s%s\n", indent, key, q, val, q, comentario
    }
    # Linea top-level: abre un bloque y cierra el anterior. Si el bloque que se cierra era el
    # de la seccion y la clave no aparecio, se inserta ANTES de seguir.
    /^[^[:space:]]/ {
      if (inblock && !hecho) { emitir("  "); hecho = 1 }
      inblock = (index($0, sec ":") == 1)
      if (inblock) visto = 1
      print
      next
    }
    inblock && !hecho && $0 ~ "^[[:space:]]+" key ":" {
      indent = $0; sub(/[^ \t].*$/, "", indent)
      comentario = ""
      if (match($0, /#.*$/)) comentario = " " substr($0, RSTART, RLENGTH)
      emitir(indent)
      hecho = 1
      next
    }
    { print }
    END {
      if (!hecho) {
        comentario = ""
        if (!visto) print sec ":"
        emitir("  ")
      }
    }
  ' "$file" > "$tmp" && mv "$tmp" "$file"
}

# `specoe_yaml_set <archivo> <seccion>.<clave> <valor>` — escribe el escalar DENTRO de su
# seccion, entre comillas simples, preservando indentacion y comentario inline.
specoe_yaml_set() {
  _specoe_yaml_write "$1" "$2" "$3" "'"
}

# ---------------------------------------------------------------------------
# SPEC-0208 P5 — la clave que admite N valores
# ---------------------------------------------------------------------------
#
# `specoe.work-repo` paso de una ruta a varias. La compatibilidad va por FORMA DEL VALOR bajo la
# MISMA clave (ADR-009), no por una clave nueva en paralelo: toda carpeta de room ya instalada
# tiene el escalar escrito, vive en la maquina de un dev y ningun script de este repo la alcanza.
#
# La lista se escribe en FLOW —`clave: ['a', 'b']`, una sola linea— y no en bloque. Los tres
# lectores/escritores de este yaml (este archivo, el lector del hook de arranque y el del plugin)
# estan anclados a la LINEA de la clave; una forma multilinea obligaria a reescribir los tres y
# romperia la garantia de `_specoe_yaml_write` de reemplazar en vez de duplicar.

# Separador con el que el launcher exporta N rutas en INTEGRA_SDD_WORK_REPO. Es `|` porque es uno
# de los caracteres que Windows PROHIBE en un nombre de archivo (junto a \ / : * ? " < >), asi que
# no puede aparecer dentro de una ruta declarada; `;` y `,` si son legales en Windows y partirian
# una ruta al medio. El mismo valor esta declarado en specoe-room-bootstrap.mjs
# (WORK_REPO_SEPARATOR): los dos lados tienen que usar el MISMO.
SPECOE_WORK_REPO_SEP='|'

# Emite el valor sin espacios de borde, y nada si queda vacio. `return 0` explicito: los callers
# corren con `set -e` y un `[ -n ... ] && printf` vacio devolveria 1.
_specoe_emit_trimmed() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  [ -n "$v" ] && printf '%s\n' "$v"
  return 0
}

# `specoe_yaml_get_list <archivo> <seccion>.<clave>` — UNA ruta por linea, acepte la clave la
# forma escalar o la de lista. Ausente o vacia => no imprime nada (cero lineas).
#
# El parseo respeta comillas: una ruta entre comillas simples o dobles puede contener comas. Una
# ruta SIN comillas con una coma adentro se parte al medio — limite conocido y aceptado: el
# instalador siempre escribe cada ruta entre comillas simples.
specoe_yaml_get_list() {
  local raw rest item char quote
  raw="$(specoe_yaml_get "$1" "$2")"
  [ -n "$raw" ] || return 0
  case "$raw" in
    "["*) ;;
    *) _specoe_emit_trimmed "$raw"; return 0 ;;
  esac
  rest="${raw#\[}"
  rest="${rest%\]}"
  item=""
  quote=""
  while [ -n "$rest" ]; do
    char="${rest:0:1}"
    rest="${rest:1}"
    if [ -n "$quote" ]; then
      if [ "$char" = "$quote" ]; then quote=""; else item="$item$char"; fi
      continue
    fi
    case "$char" in
      "'"|'"') quote="$char" ;;
      ',') _specoe_emit_trimmed "$item"; item="" ;;
      *) item="$item$char" ;;
    esac
  done
  _specoe_emit_trimmed "$item"
}

# `specoe_yaml_set_list <archivo> <seccion>.<clave> <ruta>...` — escribe N valores bajo la clave.
#
# Con UNA sola ruta escribe el ESCALAR de siempre, no una lista de un elemento. Es una decision,
# no una casualidad, y la suite la fija: el caso de un solo repo es el 99% de los rooms, y asi su
# yaml queda byte a byte igual al que ya tenian — nada que revisar en un diff, y sigue siendo
# legible por un bundle viejo que todavia no entienda listas. Con dos o mas escribe el flow.
specoe_yaml_set_list() {
  local file="$1" keypath="$2"
  shift 2
  if [ "$#" -eq 0 ]; then
    specoe_yaml_set "$file" "$keypath" ""
    return
  fi
  if [ "$#" -eq 1 ]; then
    specoe_yaml_set "$file" "$keypath" "$1"
    return
  fi
  local joined="" p
  for p in "$@"; do
    [ -z "$joined" ] || joined="$joined, "
    joined="$joined'$p'"
  done
  _specoe_yaml_write "$file" "$keypath" "[$joined]" ""
}
