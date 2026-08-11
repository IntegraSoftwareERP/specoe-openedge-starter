---
description: Acknowledge the active Integra Hub work item (task or ticket) for this Claude Code session — registers a TaskAckSession row + activates ack-task gate.
argument-hint: <taskId|ticketId> [warning]
---

# /ack-task — Sprint B ack-task gate activation

You are the orchestrator. The user invoked `/ack-task` with arguments: **$ARGUMENTS**.

## Goal

Activate the ack-task gate for the current Claude Code session by registering a `TaskAckSession` row in Integra Hub backed by the SPEC-0080 S6 Sprint B foundations. Subsequent `PreToolUse` events for mutative tools (Edit / Write / Bash / NotebookEdit) will see this active session and ALLOW silently. Without `/ack-task`, the PreToolUse enforcer hook will deny mutations per the active per-tenant `Tenant.ackTaskMode` policy.

## Argument parsing

Expected forms:

- `/ack-task <taskId>` — register ack with default policy snapshot (`Tenant.ackTaskMode`).
- `/ack-task <ticketId>` — idem, cuando el work item es un **ticket standalone** (TKT-0233). Un ticket de deuda es unidad de trabajo por sí solo: no hay que inventarle una task para satisfacer el gate.
- `/ack-task <taskId|ticketId> warning` — explicit warning-mode opt-in (advisory only — NO admin override on Tenant policy; only narrows scope to the session).

If `$ARGUMENTS` is empty or the first token is not a plausible work-item identifier, STOP and ask the user for the ID. Do NOT guess.

A plausible identifier matches `TSK-` + digits (task), `TKT-` + digits (ticket), or a cuid-like string. Resolve the canonical number to a cuid with `mcp__integra-hub__task_resolve_by_number` / `mcp__integra-hub__ticket_resolve_by_number`. If unsure, list pending tasks first via `mcp__integra-hub__list_tasks` for the current tenant + cwd context, then ask the user to pick one.

## Execution steps

1. **Verify the work item exists**: para una task, `mcp__integra-hub__list_tasks` filtrado por id (o `task_resolve_by_number`); para un ticket, `mcp__integra-hub__ihub_get_ticket` (o `ticket_resolve_by_number`). If 404 / not found → STOP and tell the user the work item does not exist (do not register a ghost ack).

2. **Capture context**: extract `cwd` from the current shell and the session_id from your hook context (or from the most recent SessionStart record if known — otherwise emit a clear note that session_id is unknown and the ack will be best-effort).

3. **Registrar el ack con la tool MCP `mcp__integra-hub__task_ack`** — NO por Bash.

   Bajo `ackTaskMode = HARD_BLOCK` el enforcer bloquea Bash justamente hasta que haya un ack activo: hacer el POST por Bash es el catch-22 que la tool MCP existe para destrabar (Fix C-1, TSK-0243).

   ```
   mcp__integra-hub__task_ack({ taskId: "<cuid>",   sessionId: "<session_id>", cwd: "<cwd>" })   // task de fase
   mcp__integra-hub__task_ack({ ticketId: "<cuid>", sessionId: "<session_id>", cwd: "<cwd>" })   // ticket standalone (TKT-0233)
   ```

   `taskId` y `ticketId` son **excluyentes**: exactamente uno. El `ackMode` lo deriva el server del snapshot de `Tenant.ackTaskMode` — no hay override client-side (el sufijo `warning` solo acota el scope de la sesión, no cambia la policy del tenant).

4. **Interpret response**:

   - **HTTP 200/201**: Sprint C endpoint LIVE — TaskAckSession row INSERT confirmed. Tell the user the session is ack-active and the enforcer will allow subsequent mutations silently.
   - **HTTP 404**: Sprint C endpoint NOT YET DEPLOYED. Update only the local cache fallback at `~/.claude/ack-task-cache.json` (object shape: `{ policy: { ackTaskMode, validatedAt, expiresAt }, activeSession: { sessionId, taskId, ticketId, ackedAt, ackMode } }` — `taskId` y `ticketId` son excluyentes, el otro va `null`). Tell the user: "Sprint C backend endpoint not yet live — cached locally; the gate will track this session locally until Sprint C deploys."
   - **HTTP 4xx / 5xx**: Report the status code + body to the user. Do NOT auto-retry. The user decides whether to retry or escalate.
   - **Network / timeout error**: Same — report cleanly. Do NOT silently swallow.

5. **Confirm to user** with a one-line summary including:
   - Work item acknowledged (task o ticket, con su ID).
   - Policy snapshot (HARD_BLOCK / WARNING).
   - Backend persistence status (LIVE / local-cache fallback / failure).

## Behavior contracts (do not deviate)

- NEVER fabricate a successful ack if the Hub call fails AND no local fallback was written. The user must see ground truth.
- NEVER call Hub endpoints other than `/tasks/:id/ack` o `/tickets/:id/ack` (vía `task_ack`) from this command. Scope is narrow.
- NEVER inventarle una task a un ticket para satisfacer el gate: el ticket ES el work item (TKT-0233).
- NEVER mutate `Tenant.ackTaskMode` from this command — that is admin-only and lives elsewhere.
- If Sprint C endpoint is not LIVE and you wrote to the local cache, make that explicit in the user-facing summary.

## Cross-references

- Implementation contracts: SDD Design Addendum v1.X+1 FINAL `cmpmoctsd00c1t02hxc1bhwa6` (Hub).
- Schema canonical: Schema Contract S6 Sprint B v1.0 `cmpl9u03000axt02hzhshl8ue` + v1.1 F-T2 `cmpmnhtly00bnt02hccyw2zsg`.
- Hooks paired: `ack-task-session-init.mjs` (SessionStart) + `ack-task-enforcer.mjs` (PreToolUse).
- Ticket como work item de primera clase: TKT-0233 (`taskId` nullable + `ticketId` en `task_ack_session`, CHECK de exclusividad, ruta `POST /tickets/:id/ack`).
