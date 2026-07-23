#!/usr/bin/env bash
# specoe-gate-messages.sh — mapeo código del gate SDD → instrucción accionable.
#
# SPEC-0157 P6 (TSK-0838). El gate compuesto del Hub (SddIdentityGuard, ADR-006)
# responde 403 con un body JSON { "code": "<CODIGO>", "message": ... }. Este
# archivo traduce cada código a QUÉ hacer y QUIÉN lo hace, en castellano.
#
# Uso (sourced por specoe-add-room.sh / specoe-launch-thinclient.sh / setup.sh):
#   source specoe-gate-messages.sh
#   specoe_gate_message MACHINE_PENDING_APPROVAL [ROL]
#
# También sirve suelto para diagnosticar un 403 a mano:
#   bash specoe-gate-messages.sh SDD_ROLE_NOT_GRANTED CC_DEV

# specoe_gate_message <CODE> [ROL] — imprime la instrucción accionable del código.
specoe_gate_message() {
  local code="${1:-}"
  local role="${2:-el rol de esta carpeta}"
  case "$code" in
    MACHINE_PENDING_APPROVAL)
      echo "Este equipo está PENDIENTE de aprobación en el Hub. Lo resuelve un ADMIN del tenant: aprobarlo en el Hub (Administración → SDD → Equipos autorizados). Cuando lo apruebe, reintentá — no hace falta reinstalar ni volver a loguearte."
      ;;
    MACHINE_NOT_AUTHORIZED)
      echo "El Hub no reconoce este equipo (no está enrolado, es de otro tenant, o el fingerprint no coincide). Lo resolvés VOS: corré el login de nuevo (./setup.sh --login) para (re)enrolar el equipo, y después un ADMIN del tenant lo aprueba en el Hub (Administración → SDD → Equipos autorizados)."
      ;;
    MACHINE_REVOKED)
      echo "Este equipo fue REVOCADO. Solo un ADMIN del tenant puede re-autorizarlo en el Hub (Administración → SDD → Equipos autorizados). Hasta entonces ninguna sesión SDD desde esta máquina va a operar."
      ;;
    SDD_ROLE_NOT_GRANTED)
      echo "Tu usuario no tiene concedido ${role} en el Hub. Lo resuelve un ADMIN del tenant: concederte el rol (Administración → SDD → Roles por usuario). La concesión es efectiva al próximo request — no hace falta reinstalar."
      ;;
    SEAT_INVALID)
      echo "Tu usuario no tiene un seat activo de la licencia SDD. Lo resuelve un ADMIN del tenant: asignarte un seat (Administración → SDD → Seats). Si el pool está agotado, el admin tiene que liberar un seat o ampliar la licencia con Integra."
      ;;
    SDD_SESSION_ROLE_CLAIM_MISSING)
      echo "La sesión SDD llegó al Hub sin rol declarado (falta el header x-sdd-role). Lo resolvés VOS: el .mcp.json de esta carpeta no tiene INTEGRA_SDD_ROLE — regenerá la config del room (./specoe-add-room.sh <ROL> ... o ./setup.sh --room-only) y reabrí la sesión."
      ;;
    *)
      echo "Código '${code:-<vacío>}' no mapeado. Revisá el campo 'message' del error del Hub; si es un 403 del gate SDD, contactá al admin del tenant con el código exacto."
      return 1
      ;;
  esac
}

# Invocado directo (no sourced) → modo CLI de diagnóstico.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  specoe_gate_message "${1:-}" "${2:-}"
fi
