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

# `specoe_yaml_set <archivo> <seccion>.<clave> <valor>` — escribe el escalar DENTRO de su
# seccion, entre comillas simples, preservando indentacion y comentario inline.
#
# INSERTA LA CLAVE SI NO ESTA. Es el caso de todo room ya instalado: su project.config.yaml es
# anterior a la clave `specoe.tenant` y un sed de reemplazo no tendria sobre que actuar — el
# instalador terminaria en verde con el tenant sin declarar, que es el estado que hace caer la
# sesion al fallback legacy sin que nadie lo note. Si la seccion tampoco esta, se agrega al
# final del archivo.
specoe_yaml_set() {
  local file="$1" section="${2%%.*}" key="${2#*.}" value="$3" tmp
  [ -f "$file" ] || return 1
  tmp="$file.specoe-yaml.tmp"
  awk -v sec="$section" -v key="$key" -v val="$value" -v q="'" '
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
