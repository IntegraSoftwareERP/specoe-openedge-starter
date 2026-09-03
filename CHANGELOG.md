# Changelog

All notable changes to this project. Automatic — regenerado por `./scripts/changelog.sh`.

## 0.2.28 - 2026-09-03 (TKT-0367 ronda 2 - salen `docker compose *` y `git diff *`)

La ronda 1 acoto `Bash(npx *)` y dejo escrito el criterio en `.claude/PERMISSIONS.md`. Esa misma
revision nombro **otras dos entradas que cumplian la misma vara y no se habian tocado**, a la
espera de que el Operador decidiera. Decidio: salen las dos.

- **`Bash(docker compose *)`** - `docker compose run -v /:/host <img> sh -c '...'` monta el
  filesystem del host completo y corre con los privilegios del daemon: tan amplio como `npx`, o
  mas. El relevamiento ademas mostro que **ningun flujo del room la usa**: las apariciones de
  `docker compose` en el starter son documentacion de deploy on-premise del tier Suite, que corre
  el DevOps del cliente en su infra. El `docker/` del starter son artefactos de build de PASOE, y
  el README dice explicito que **no** incluye el `docker-compose.yml` del Hub. Sale sin costo.
- **`Bash(git diff *)`** - `git diff --output=<archivo>` **escribe**: crea o pisa un archivo
  arbitrario desde una entrada que se lee como de lectura. Ningun script ni hook del starter
  invoca `git diff` (cero apariciones); lo usa el agente a mano.

**Costo asumido a sabiendas:** `git diff` es lectura casi siempre y ahora pide confirmacion cada
vez. La friccion es real y se acepto igual - una entrada que escribe archivos no puede estar
auto-aprobada por la comodidad del caso feliz.

Quedan **nueve** entradas. Y `scripts/test-permissions-allowlist.sh` suma un cuarto bloque: la
lista de entradas **retiradas a proposito**, con el motivo de cada una. Hacia falta un diente
propio - medido en vivo, reponer `docker compose *` pasaba los tres bloques anteriores en
silencio: el primero no la caza (no es interprete ni lanzador de paquetes) y el tercero tampoco,
porque PERMISSIONS.md la nombra en su seccion "Retiradas".

Precision sobre el `node -e` que la ronda 1 nombro: el problema no es `node -e` en general - un
`-e` de UNA linea imprime bien, y varios scripts de `scripts/` lo usan asi sin problema. Lo que
termina con exit 0 y sin ninguna salida es pasarle un script MULTILINEA. Corregido el comentario
del guard, que lo decia de mas.

## 0.2.27 - 2026-09-02 (TKT-0367 - el allowlist se clasifica por lo que habilita)

`Bash(npx *)` estaba en una lista que se lee entera como minimo privilegio: `git status`, `git log`,
`git diff`, `git show`, `npm test`, `docker compose`. Se leyo como "correr una herramienta de npm",
vecino inocente de `npm test`. **Lo que habilita es descargar y ejecutar cualquier paquete del
registry** - ejecucion de codigo arbitraria, y auto-aprobada, en la maquina de todo room instanciado
desde el template. ADVERSARIAL incluido, que por su funcion deberia tener los permisos mas chicos.

En su lugar quedan las dos invocaciones concretas que el starter efectivamente instruye:
`npx specoe-validate *` (la forma de `docs/CONFIGURATION.md` y de la cabecera de
`project.config.yaml`) y `npx --no-install specoe-validate *` (la de `scripts/smoke-test.sh`). Son
dos y no una porque el prefijo se matchea textual y los flags van antes del nombre del paquete.

**Relevamiento previo, que es lo que el ticket pedia hacer antes de tocar nada:** ninguno de los
rooms instanciados accesibles hereda la entrada - los seis de `IntegraSuiteAI` no declaran bloque
`permissions`. El unico portador era el template. Y el unico `npx` que el starter instruye es
`specoe-validate`; los `npx prisma` de `docs/TROUBLESHOOTING.md` son del repo de producto, no del
room.

**El criterio queda escrito al lado del archivo**, en `.claude/PERMISSIONS.md`: una entrada se
clasifica por lo que habilita, nunca por lo que aparenta. Con la revision de las diez entradas
vigentes, incluidas las dos que cumplen el mismo criterio y NO se tocaron en este ticket
(`docker compose *`, y el `--output` de `git diff *`, que escribe archivos desde una entrada que se
lee como de lectura). Acotarlas exige su propio relevamiento; sacarlas a ciegas rompe rooms en uso.

## 0.2.26 — 2026-09-02 (TKT-0362 — el auditor de hooks fantasma también viaja)

**Un hook puede no correr por tres motivos distintos, y los tres se ven exactamente igual desde
adentro de una sesión: no pasa nada.** Está versionado y nunca se instaló; está instalado pero
quedó viejo; está instalado y al día pero no lo cablea ningún `settings.json`. En los tres casos
figura en un PR, se lo cita como si fuera un freno, y no frena nada.

`hooks-audit.mjs` los distingue al arrancar. Existía desde TKT-0325 pero vivía en el repo de rooms
—el único lugar sin CI, sin vendorizado y sin llegada a ninguna máquina que no fuera la del
Operador—, así que en la práctica nunca corrió.

**Lo que lo hace útil de este lado son los dos manifiestos.** Los hooks llegan a una máquina por dos
canales que no se cruzan: el `install.mjs` de integra-hub (que escribe
`~/.claude/hooks/integra-hooks-manifest.json`) y el `setup.sh` de este starter (cuya procedencia
vive en `vendor/MANIFEST.json`). **El dev de un tenant no clona integra-hub**, así que nunca tiene
el primero. Un auditor que leyera sólo aquél le diría _"no hay manifiesto"_ en cada arranque, para
siempre — un falso positivo permanente sobre una máquina con los hooks perfectamente instalados.
Ahora lee los dos.

Va en `SessionStart` y **sin matcher**: ese evento no acepta ninguno, y ponerle uno sería declarar
un cableado que Claude Code no aplica.

No bloquea nunca — sale 0 aunque algo reviente. Un auditor que impide arrancar la sesión por un
problema de instalación es peor que el problema que reporta.

## 0.2.23 — 2026-08-12 (TKT-0325 / TKT-0327 — los dos hooks de disciplina de git también viajan)

**Las dos reglas que gobiernan cómo se toca un repo estaban escritas y sin diente en la máquina de
cualquiera que no fuera el Operador.** TKT-0321 cerró ese agujero para los tres hooks del gate de
ack-task y el verificador de claims; quedaban afuera los dos que gatean el `git` de todos los días,
por el mismo motivo: viven en `integra-hub/hooks/`, los instala el `install.mjs` de ese repo, y el
dev de un tenant no lo clona.

- **`block-destructive-outside-worktree.mjs`** — aborta los destructivos (`rm -r`, `git clean`)
  cuyo **path resuelto** cae fuera del worktree, y el `git stash` mutador desde un worktree linked.
  Existía desde TKT-0120 y corría **únicamente en la máquina del Operador**: ningún dev de un
  tenant lo tuvo nunca, con el `.git` común compartido entre worktrees y el junction de
  `node_modules` como trampa.
- **`block-no-verify.mjs`** — aborta `--no-verify`, el `-n` de `git commit` y la manipulación de
  `core.hooksPath`. Ojo con lo que hace y lo que **no**: `integra-hub` no tiene ningún hook de git,
  así que saltearlos no saltea ninguna verificación. Lo que evita es el **trail falso** — que
  alguien declare después que _"lo rehice dejando correr los hooks"_, indistinguible de la verdad
  porque git calla en los dos casos.

**El de destructivos se vendoriza recién ahora, y no antes, a propósito.** Al traerlo al repo
(TKT-0325) y escribirle su primera suite aparecieron dos defectos suyos, uno **fail-OPEN**: un path
nativo de Windows entrecomillado no se bloqueaba, porque su tokenizer trataba el backslash como
escape dentro de comillas dobles y bash no. **TKT-0327 lo cerró.** Repartirlo antes habría
distribuido el hueco junto con el freno.

Los dos entran con entrada en `vendor/MANIFEST.json` —`sourceRepo`, `sourcePath`, `sourceSha`,
`packageSha256`—, con lo cual `check-vendor-drift.sh` y el chequeo de deriva del arranque los
cubren desde el día uno. `setup.sh` los copia con `install_force` y escribe sus entradas
`PreToolUse`/`Bash` en el `.claude/settings.json` del **room**, no en el de la máquina: los dos
miran el comando y no el cwd, así que registrados a nivel global gatearían toda sesión de Claude
Code de esa computadora, incluidos proyectos que no son de Integra.

## 0.2.22 — 2026-08-11 (TKT-0321 — los hooks del Hub llegan por el canal del starter)

**Los tres hooks que gatean las escrituras al Hub no llegaban a la máquina de un dev de un
tenant.** Se instalaban a mano, copiándolos del repo `integra-hub`, y ese repo el dev de un tenant
no lo clona: consume el Hub por el MCP vendorizado con el starter. Medido el 2026-08-11 en la
máquina de un dev del piloto: ninguno de los tres presente y cero entradas en su `settings.json`.
O sea que el gate de ack-task y el verificador de claims, para él, **no existían** — el backend
guardaba la política del tenant y registraba el ack, pero quien bloquea es el hook local.

Y transportarlos tal cual no alcanzaba: los cuatro artefactos son hijos del modelo de identidad de
SPEC-0005 (email/password) y esa máquina corre el de SPEC-0157 (login SDD). Con el hook instalado y
sin credenciales, el enforcer salía **exit 2 bloqueando todo `Edit`/`Write`/`Bash`** con el mensaje
`Hub unreachable / timeout` — mandando a revisar la red cuando lo que faltaba era la identidad.

- **Los cuatro artefactos viajan vendorizados** en `.claude-bundle/` (`hub-channel.mjs`,
  `ack-task-session-init.mjs`, `ack-task-enforcer.mjs`, `executable-verification-hub-mutation.mjs`
  y el comando `commands/ack-task.md`), con entrada en `vendor/MANIFEST.json`: `sourceRepo`,
  `sourcePath`, `sourceSha` y `packageSha256`. `check-vendor-drift.sh` los cubre desde el día uno,
  así que su deriva contra el repo de origen la detecta un verificador y no una auditoría a mano.
- **`setup.sh` los instala con `install_force`** — el allowlist es por archivo y una omisión ahí es
  un fallo mudo y permanente (TKT-0232) — y puebla `~/.claude/commands/`, que hasta ahora no
  poblaba nadie.
- **Copiar no es activar**: `setup.sh --room-only` escribe las entradas de `SessionStart` y
  `PreToolUse` en el `.claude/settings.json` del room, con merge idempotente que preserva lo que el
  dev tenga. Va al settings del **room** y no al de la máquina porque el enforcer no mira el cwd:
  registrado global gatearía toda sesión de Claude Code de esa computadora, incluidos proyectos que
  no son de Integra, y es fail-CLOSED.
- **`fastest-levenshtein` entra al vendor de los hooks.** La importa el verificador de claims y sin
  ella su import falla en la RESOLUCIÓN, o sea antes de cualquier catch y sin mensaje.
- **El arranque bloquea si los hooks de la máquina quedaron atrás de la carpeta.**
  `specoe-license-check.mjs` compara lo instalado contra el `packageSha256` del MANIFEST del room y
  corta nombrando `./specoe-setup-host.sh`. Respeta la misma vía de escape que el bloqueo por
  licencia (`SPECOE_ALLOW_DEGRADED_START`) y sólo mira en carpetas que son un room. **Alcance
  honesto**: no llega a las máquinas con un bundle anterior a este release — ahí corre el
  `license-check` viejo, que no tiene el chequeo. Protege de la deriva de acá en adelante.
- El `.gitattributes` cubre `commands/**` con `eol=lf` y el `.prettierignore` excluye los cuatro
  artefactos: sin eso, el checkout en Windows o un `prettier --write` les cambian los bytes y el
  `packageSha256` deja de coincidir **en el clon del cliente**, donde ninguna verificación de
  contenido puede cazarlo.

## 0.2.21 — 2026-08-11 (TKT-0320 — el hook de arranque deja de exigir act-as en modo USER)

**Toda sesión de room del thin-client arrancaba con una alarma falsa.** `specoe-role-check.mjs`
validaba siempre el contrato act-as de SPEC-0148 (`INTEGRA_SDD_ROLE` + `INTEGRA_ACT_AS_TENANT` + el
secreto del rol en el canal) y no contemplaba el modo USER, que es el que usa el thin-client desde
SPEC-0157 y el que SPEC-0187 P1 inyecta en cada solapa de room. Ahí la identidad viaja por el JWT de
sesión SDD derivado del canal y act-as no participa: la variable que el hook exigía no existe en ese
modo. El aviso no era cosmético — viaja por `hookSpecificOutput.additionalContext`, o sea que Claude
Code se lo inyecta al agente como contexto de la sesión: el agente concluía que no podía operar
contra el Hub y **se plantaba antes de hacer nada**, pidiendo un prerequisito inexistente. Y la
remediación era imposible de seguir: mandaba a correr `specoe-launch-thinclient.sh <ROL> <TENANT_ID>`
cuando ese launcher no exporta esa variable por diseño — exporta `INTEGRA_SDD_TENANT`, que es el
`tenantSlug` y no el `Tenant.id` de act-as.

- **El hook ramifica por `INTEGRA_SDD_IDENTITY_MODE`,** con el mismo criterio que el MCP
  (`startup.ts`, `requiredEnvFor`): en modo **USER** lo obligatorio es `INTEGRA_SDD_ROLE` más el
  material de identidad del canal; `INTEGRA_ACT_AS_TENANT` y el secreto act-as **no se chequean y su
  ausencia no se reporta**. En modo **MACHINE** (o sin declarar) se conserva el chequeo vigente tal
  cual, con su mensaje palabra por palabra.
- **La remediación de cada rama nombra la variable que el launcher de ESE modo exporta.** La del
  modo USER apunta a `specoe-launch-thinclient.sh <ROL>` y a `specoe.tenant` del
  `project.config.yaml` (que el launcher exporta como `INTEGRA_SDD_TENANT`); `<TENANT_ID>` ya no
  aparece ahí.
- **El modo USER sigue avisando de lo suyo**: sin rol, sin material de identidad en el canal, o con
  identidad de varios tenants y ninguno declarado — este último reusa el aviso de SPEC-0187 P7, que
  ya nombra el tenant y las dos vías (`login` / `migrate`). Lo que no puede resolver —el canal que no
  carga— se calla en vez de inventar una causa: el borde real sigue siendo el 401/403 del Hub.
- **Suite nueva** (`test/role-check-modo-usuario.test.mjs`, 12 casos) con el control negativo
  explícito: en modo scoped sin `INTEGRA_ACT_AS_TENANT` el aviso vigente se conserva.

## 0.2.20 — 2026-08-11 (TKT-0317 — el room declara cuál es su repo de trabajo)

**El room sabía su rol y su tenant, pero no dónde vive el código.** La carpeta del room ES un repo
git —un clon shallow del starter con `sparse-checkout`— y no es el repo del cliente. Las herramientas
de aislamiento del agente operan sobre el repo de la carpeta abierta, así que apuntaban a ese clon:
pedir un worktree para aislar el trabajo de una fase fallaba (`git resolves its working tree to … a
core.worktree redirect`) y, sin el corte, habría ensuciado el clon del starter. El equipo interno no
lo veía porque abre el repo de trabajo directamente y usa el room como accesorio; el dev que sigue el
QUICKSTART al pie se lo choca la primera vez que toca código.

- **`specoe.work-repo` en el `project.config.yaml`** — la declaración, en la misma superficie donde
  ya viven `specoe.role` y `specoe.tenant`. Ruta absoluta al checkout local, no una URL. La escribe
  `./specoe-add-room.sh <ROL> --work-repo <ruta>` (con `specoe_yaml_set`, así que también entra en un
  room ya instalado, cuyo yaml es anterior a la clave) y el template la trae documentada para
  agregarla a mano. **No es `--repo`**, que sigue siendo la URL del starter que se clona.
- **Cada sesión del room lo dice al arrancar.** `specoe-room-bootstrap.mjs` inyecta la declaración
  por el mismo canal que el contrato del room, por los cuatro caminos de salida (también cuando
  arranca `ungoverned`: un room sin contrato igual va a querer aislar trabajo). Discrimina tres
  estados y ninguno se calla: declarado y con repo ahí → nombra la ruta y cómo usarla
  (`git -C <ruta> worktree add …`); declarado y sin repo ahí → lo dice en vez de dejar que se use una
  ruta falsa; sin declarar → lo declara y explica dónde ponerlo. La lectura del yaml va **anclada a
  la sección** (`paths.repos` existe en el mismo archivo; un lector global lo agarraría — TKT-0256).
- **El launcher lo exporta como `INTEGRA_SDD_WORK_REPO`** y esa env le gana al yaml, que es el único
  canal que tiene una sesión abierta desde el launcher cuando el yaml quedó viejo.
- **Fuera de alcance, declarado**: cómo el harness de Claude Code resuelve worktrees. No es
  superficie propia; con la declaración el agente sabe contra qué repo apuntar git explícitamente.

## 0.2.19 — 2026-08-11 (TKT-0314 — la instalación deja de depender de un `npm install` en la máquina del cliente)

**Cierra un CRITICAL de QA sobre máquina limpia.** `setup.sh --host-only` instalaba el bundle y
después corría `npm install` en `~/.claude/hooks` para bajar sus dependencias. En una VM Windows del
piloto ese npm aborta con `Assertion failed: new_time >= loop->time, file src\win\core.c, line 327`
—una assertion del event loop de libuv, no un fallo de red— y el instalador imprimía un **warn** y
seguía de largo hasta el banner `Host listo`. Sin dependencias no carga el binding nativo de
`@napi-rs/keyring`: el alta de room no persiste la license key, el hook de licencia no valida y el
MCP responde **401**, diez minutos y varios pasos después de la causa. Desde la máquina del dev no
había salida: reintentar, `npm ci`, borrar `node_modules`, resincronizar el reloj y reiniciar fallan
igual; lo único que funcionó fue copiar `node_modules` desde otra máquina.

- **Las dependencias viajan vendorizadas en el bundle.** Es el mismo criterio que ya se le aplicó al
  MCP (`vendor/integra-hub-mcp.mjs`) y al plugin (`.vsix`): lo pesado se construye en el repo, viaja
  con hashes y no se reconstruye en el cliente. `.claude-bundle/hooks/vendor/` trae el cliente MCP y
  `node-machine-id` como bundles de esbuild, y el loader de `@napi-rs/keyring` con su binding
  **nativo** por plataforma — windows x64/arm64, macOS arm64/x64 y linux x64 gnu. Las genera
  `scripts/build-hooks-vendor.mjs` (interno) desde las versiones del `package-lock.json` del bundle.
- **Los hooks resuelven por `vendor-deps.mjs`**: vendor primero, `node_modules` sólo como fallback
  para plataformas que el vendorizado no cubre.
- **Si las dependencias no quedan resueltas, la corrida CORTA.** Ya no es un warn: el instalador
  nombra qué faltó, nombra la consecuencia (sin keyring no hay license key y el MCP da 401) y da el
  camino de recuperación. `specoe-setup-host.sh` corre con `set -e`, así que **no** llega al banner
  de «Host listo» — el mismo verde-falso que SPEC-0165 P5 cerró para el `.vsix`.
- **`undici` y `eventsource` salieron de `package.json`**: ningún hook los importaba. `undici` quedó
  de cuando el canal TLS se armaba con un dispatcher global (se sacó al medir que el `fetch` de Node
  26 lo ignora) y `eventsource` entra igual como dependencia del SDK del MCP.
- **Con tests que lo gatean en CI**: `scripts/test-host-deps-gate.sh` corre `setup.sh --host-only` de
  verdad contra un HOME temporal y verifica que **no** quede `node_modules` (o sea que npm no corrió)
  y que, sin vendor y con un npm que falla, la corrida corte sin anunciar éxito;
  `.claude-bundle/hooks/test/vendor-deps.test.mjs` suma el roundtrip real contra el keyring del SO,
  un control negativo del chequeo y la correspondencia manifiesto ↔ archivos ↔ `package-lock.json`.

## 0.2.18 — 2026-08-10 (TKT-0307 — la segunda pasada del alta deja de pedir la licencia que la primera guardó)

**Arregla el reintento del alta de room, que era un fallo.** La instanciación es de DOS PASADAS a
propósito: la primera clona, fija el rol, **guarda la licencia en el keyring** y corta hasta que el
dev edite el `project.config.yaml`; la segunda completa la config. Pero la segunda volvía a **exigir
la license key** y sin ella cortaba con exit 1 — o sea que el paso normal del flujo obligaba a tener
la key a mano dos veces. Detectado en QA sobre VM limpia (2026-08-10, starter `0.2.16`).

- **La key se lee del keyring cuando no viene por argv.** `specoe-add-room.sh <ROL>` sin key busca la
  del account correspondiente (`<ROL>`, o `<tenantSlug>:<ROL>` con `--tenant`) y sigue con esa; sólo
  la pide cuando el keyring tampoco la tiene. Si la key vino del keyring **no se reescribe**: el log
  ya no dice «guardando» una key que el dev no pasó. Los wrappers `specoe-room-<rol>.sh` heredan el
  comportamiento — `./specoe-room-ccdev.sh` sin argumentos alcanza para la segunda pasada.
- **El corte del check de config deja `.specoe-config-pending`** en la carpeta del room, con un campo
  pendiente por línea, y el paso que pasa lo borra. Es el único canal que sobrevive al terminal:
  cuando el alta la dispara el plugin de VSCode, esa salida se va con el proceso y el dev ve sólo
  `exit code: 1`. La lista la escribe el mismo paso que decide el corte — no hay un segundo criterio
  del lado del plugin. El archivo está en el `.gitignore` del starter y nombrado en la divergencia
  acotada de `add-room`, así que no frena la segunda pasada.
- **Los cinco campos que el gate exige valen `CAMBIAR-ME` en el template.** Cierra la salvedad que
  TKT-0309 dejó anotada: `pasoe.instance-name` valía `oepas1`, que también es una instancia real
  plausible, así que «lo dejé porque me sirve» y «no lo edité» eran indistinguibles. El valor de
  ejemplo quedó en el comentario inline de cada campo.
- **Con tests que lo gatean en CI**: `scripts/test-add-room-license.sh` extrae del `add-room` real la
  resolución de la key y la persistencia, y las ejerce con el keyring stubbeado (incluido el caso
  multi-tenant en las dos direcciones y un control negativo con la validación vieja);
  `scripts/test-config-gate-fields.sh` suma el ciclo de vida de `.specoe-config-pending` y la
  comparación de las sentinelas del fallback contra el template real.

## 0.2.17 — 2026-08-10 (TKT-0309 — el alta de un room deja de pedir datos del ERP que el room no usa)

**Arregla un gate que exigía lo que el sistema no consume.** `setup.sh` tenía UNA lista de campos
obligatorios —`SPECOE_CONFIG_FIELDS`, cinco campos— y adentro estaban `database.logical-name` y
`pasoe.instance-name`. Hasta que los cinco se editaran, la instanciación de **cualquier** room
cortaba con exit 1: un dev que sólo va a operar un Discovery tenía que declarar una base Progress y
una instancia PASOE que pueden no existir todavía en el cliente, o no conocerse al momento del alta.

- **El universo del check lo decide ahora la carpeta.** `specoe.role` declarado (lo fija
  `specoe-add-room.sh` antes de correr el check) = room SDD: se exigen `project.name`,
  `project.vendor` y `paths.workspace-root`. Sin rol = proyecto ERP del cliente: se exigen además los
  dos del backend OpenEdge, igual que antes. El gate no se desactiva, se acota — y falla hacia el
  universo completo si el yaml no se puede leer.
- **Por qué esos dos y no otros**: medido sobre el starter, el único consumidor de
  `pasoe.instance-name` es `docker/gradle/build.gradle` (el build del webapp PASOE) y
  `database.logical-name` no tiene ninguno — las skills del backend lo renderizan server-side desde
  el yaml del tenant, que es otro archivo. Y `docker/` ni llega al clon de un room: `add-room` lo
  recorta.
- **Con test que lo gatea en CI**: `scripts/test-config-gate-fields.sh` extrae del `setup.sh` real el
  universo de campos y la sección entera que corta, y los ejerce sobre rooms sintéticos — room SDD
  pasa, room SDD con un campo BASE sin editar corta, proyecto ERP sigue exigiendo DB y PASOE, y un
  control negativo con la lista única vuelve a cortar para probar que el banco discrimina.

**Anotado y no resuelto** (salvedad explícita del Arquitecto): el valor de template de
`pasoe.instance-name` es `oepas1`, que también es un valor real plausible, así que un dev del
proyecto ERP que lo deja porque le sirve sigue contando como «sin editar». Deja de importar para
rooms SDD; sigue vivo para proyectos ERP.

## 0.2.16 — 2026-08-10 (TKT-0306 — el plugin y el MCP vendorizados vuelven a ser los de sus repos)

**Arregla un starter que instalaba software viejo sin decirlo.** `vendor/` traía el `.vsix` del
plugin construido el 2026-07-31 desde `7c58a55`, o sea anterior a TODO SPEC-0187: en la VM de QA el
comando «Integra Hub: Agregar room...» no aparecía en la paleta —es de P8— y «Abrir room» reventaba
con `Cannot read properties of undefined (reading 'nombre')`, porque el `integraHub.roomsRoot` que
el instalador configura también es de P8 y el plugin instalado sólo entendía el roster manual
`integraHub.rooms`. Plugin viejo con configuración nueva. P1, P6 y P8 estaban COMPLETED y su valor
no llegaba a nadie.

- **El `.vsix` se reconstruyó desde `dcb3790`** (HEAD de `integra-hub-vscode`, con los PRs #12/#13/#14
  adentro): trae la contención de rooms de P8, el login unificado por terminal de P6 y el canje del
  material del keyring de P1.
- **El bundle del MCP se reconstruyó desde `974c8b9`**, 16 commits de `mcp-server` por delante del
  `a4812cac` que estaba vendorizado — entre ellos TKT-0274 (transporte por referencia), TKT-0261
  (canal de CA propio), TKT-0271/0272 y TKT-0300. El manifiesto lo declaraba como colateral a
  verificar y lo estaba: los rooms del starter corrían un MCP sin esas tools.
- **El MANIFEST vuelve a describir lo que hay**, con los dos hashes recalculados y la
  reproducibilidad re-medida sobre los commits nuevos: el bundle de esbuild dio dos corridas
  idénticas byte a byte, y `vsce` volvió a dar dos `packageSha256` distintos con un solo
  `contentSha256` — que es exactamente por qué el manifiesto declara los dos.

**Y para que no vuelva a pasar por olvido**: el re-vendorizado no era tarea de nadie. Ninguna de las
nueve fases de SPEC-0187 se hacía cargo, y no hay pipeline que lo reconstruya. Ahora
`verify-vendor-drift` compara a diario el `sourceSha` de cada componente contra el repo de origen y
avisa cuando quedaron commits que tocan lo que se empaqueta. No reconstruye —eso sigue siendo
humano—, pero acordarse deja de serlo.

## 0.2.15 — 2026-08-08 (SPEC-0187 P2/P4/P5/P7/P9 + TKT-0299/0303 — destrabe del starter público)

El starter público estaba 27 commits atrás y se publicó para destrabarlo: rol por env de la sesión
(P2), diagnóstico de arranque por causa (P4), CLI `specoe-identity` (P5), `specoe.tenant` y
alternancia (P7), host-flow del `.vsix` e idempotencia del hosts (P9), más TKT-0299 y TKT-0303.

**El tag salió sin bumpear `VERSION`**, que quedó en `0.2.14`: por eso no hay entrada propia acá y
por eso `verify-public-mirror` quedó en rojo — el espejo publica lo que dice el archivo, no lo que
dice el tag. Se cierra con este `0.2.16`. Registrado en TKT-0306.

## 0.2.14 — 2026-08-01 (TKT-0256 — la URL del Hub sale del yaml sin las comillas del template)

**Arregla un room que queda apuntando a una URL inválida sin decirlo.** `setup.sh` leía
`hub.api-url` del `project.config.yaml` con un `sed` que sacaba comillas **dobles**, y el template
trae el valor entre comillas **simples**. Resultado: la URL viajaba con las comillas adentro hasta
`INTEGRA_HUB_API_URL` del `.mcp.json` y hasta `integraHub.baseUrl` del `.vscode/settings.json`, y
el síntoma aparecía lejos de la causa — como un fallo de conexión del MCP o del plugin.

- **Las lecturas del yaml pasan todas por `specoe_yaml_get`.** El helper ya existía en el propio
  `setup.sh` y resuelve comilla simple, comilla doble, valor pelado y comentario inline, además de
  acotar la búsqueda a la sección correcta. No se parcheó la comilla suelta: la causa era que dos
  líneas contiguas leían el mismo archivo con criterios distintos — la de `specoe.role` manejaba la
  comilla simple y el comentario, la de `hub.api-url` no.
- **Alcanza también al resumen final del instalador**, que mostraba la URL con las comillas adentro
  — o sea, distinta de la que decía haber configurado.
- **El camino normal de instalación no estaba afectado**: `specoe-add-room.sh` invoca siempre
  `setup.sh --room-only --hub <url>`, y con `--hub` el valor no pasaba por ese `sed`. El defecto se
  alcanzaba corriendo `./setup.sh --room-only` a mano, que es un camino que el propio
  `QUICKSTART-VSCODE.md` documenta como válido.

Cubierto por `scripts/test-yaml-scalar-read.sh`, que ejerce las líneas de resolución y los bloques
de escritura extraídos del `setup.sh` real y afirma sobre los dos entregables — el `.mcp.json` y el
settings—, no sobre el comando. Corre en CI.

## 0.2.13 — 2026-08-01 (TKT-0261 — el MCP resuelve el CA por el trust del sistema, no sólo por variable de entorno)

**Arregla un room que arranca "Connected" y no puede hablar con el Hub.** En una VM limpia, toda
tool del MCP `integra-hub` invocada desde la sesión de Claude Code de la extensión de VSCode
devolvía `fetch failed`, con stderr vacío. El server levantaba y hablaba con el cliente; lo que no
funcionaba era su llamada saliente.

- **El entry `integra-hub` del `.mcp.json` pasa a escribirse con `--use-system-ca` como primer
  argumento de Node, delante del bundle.** El bundle vendorizado no arma canal de CA propio: su
  única vía al CA del piloto era `NODE_EXTRA_CA_CERTS`, o sea que la validación TLS dependía de
  que el cliente propagara ese `env` al proceso hijo — y la sesión de la extensión de VSCode no lo
  propaga. El CA de Caddy ya está en el trust de Windows (lo instala `specoe-setup-host.sh` en el
  paso del UAC) y el flag hace que Node lo lea de ahí.
- **`NODE_EXTRA_CA_CERTS` se conserva.** El objetivo son **dos caminos independientes al mismo
  CA**, no reemplazar uno frágil por otro: si el cliente sí propaga el `env`, ese camino sigue
  vivo; si no lo propaga, el del trust del sistema alcanza solo. Verificado midiendo el camino del
  sistema **con la variable borrada del entorno**: el MCP responde payload donde antes daba
  `fetch failed`.
- **El flag está medido en el piso del rango certificado.** SPEC-0164 lo había descartado para los
  hooks —"flag de CLI, inservible cuando el proceso lo spawnea otro"—; acá el que spawnea es el
  que escribe los `args`, así que sí sirve. Se verificó que Node **22.19.0** (el `SPECOE_NODE_MIN`
  del instalador) lo acepta y lo aplica: con el flag, `fetch` contra el Hub devuelve HTTP 401 —
  respuesta, o sea transporte sano; sin el flag y sin la variable, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.

Queda abierto el fix de fondo —que el bundle del MCP lea el CA del archivo por su cuenta, como ya
hacen los hooks— y que el `fetch failed` deje de ser mudo. Los dos son código de
`integra-hub/mcp-server`, fuera de este paquete.

## 0.2.11 — 2026-07-31 (SPEC-0165 P3 — el MCP y el plugin viajan DENTRO del starter)

**Esta versión no cambia ningún comportamiento del instalador: agrega carga.** El clon del starter
pasa a traer dos artefactos bajo `vendor/`, y todavía **no los usa nadie** — el cableado del MCP
(`setup.sh` → `.mcp.json`) y la instalación del plugin llegan en las fases siguientes de la SPEC.
Instalar esta versión no instala el MCP ni la extensión; deja los dos archivos en el room.

- **`vendor/integra-hub-mcp.mjs`** — el MCP `integra-hub` como UN archivo autocontenido, con sus
  tres dependencias de runtime inlineadas. **La instalación en la VM es cero**: el archivo ya está
  en el room porque el room es un clon del starter. No hay `npm install`, no hay descarga, no hay
  registry — que es el punto: la conectividad de la VM del cliente era una asunción, y ahora no
  hace falta para tener el MCP en disco. Imprime su versión sin levantar el server ni tocar el
  keyring: `node vendor/integra-hub-mcp.mjs --version`.
- **`vendor/integra-hub-vscode.vsix`** — el paquete de la extensión de VSCode, disponible fuera de
  la máquina donde se construye y identificable por versión.
- **`vendor/MANIFEST.json`** — por cada componente: versión, repo y SHA de origen, y **`sha256` del
  artefacto**. El `sha256` no es decorativo: es lo único que permite verificar, desde la VM, que el
  archivo que está en el disco es el que el manifiesto declara. Comparar la versión leída contra la
  del manifiesto puede ser comparar el manifiesto consigo mismo, y ese camino no detecta el caso
  que importa — **artefacto viejo con manifiesto nuevo**.
- **`.gitattributes` marca `*.vsix -text`.** El `.vsix` es un ZIP; sin la regla queda a merced de la
  normalización de fin de línea del checkout y llega corrupto, con el fallo apareciendo recién en
  `code --install-extension`, lejos de la causa. Se verifica comparando el `sha256` del `.vsix`
  clonado contra el del artefacto de origen, no mirando que el archivo esté.

**Peso**: los dos artefactos suman ~1,5 MB. Cada room es un clon completo del starter, así que ese
costo se paga una vez por room y es la contrapartida deliberada de no depender de la red.

## 0.2.10 — 2026-07-30 (SPEC-0176 P2 — el room declara su rol al validar, y un rol negado deja de ser silencio)

**REQUIERE EL HUB CON SPEC-0176 P1 DESPLEGADO. El orden no es negociable: primero el Hub, después
esta versión.** Contra un Hub sin P1, el `declaredRole` que este bundle manda no se descarta —
rebota **400** (`ValidationPipe` con `forbidNonWhitelisted`), el hook clasifica ese 400 como
licencia rechazada y, sin caché de grace fresco, **corta el arranque con exit 2**. O sea: instalar
esto antes de tiempo convierte un room sin rol en un room BLOQUEADO, que es exactamente el síntoma
más caro que esta SPEC vino a eliminar. Si ya está instalado y el Hub todavía no, la salida de
emergencia de ADR-002 sigue valiendo (`SPECOE_ALLOW_DEGRADED_START=1` o el archivo
`.claude/specoe-allow-degraded-start`).

**Hasta esta versión, un rol NEGADO y una carpeta legítimamente sin rol se veían igual.** El rol de
un room no viajaba en el `/license/validate`: el Hub lo resolvía por **unicidad** —un usuario con
dos roles activos no desempataba y se quedaba sin claim— y un rol que el usuario NO tenía concedido
terminaba en el mismo lugar que no haber pedido ninguno. Los dos casos emitían el mismo JWT sin
claim `sddRole`, los tools MCP servían el bundle **producto** en los dos, y la sesión arrancaba en
silencio. El dev veía «no tengo skills» sin forma de saber si nunca declaró un rol o si se lo
negaron.

- **`.claude-bundle/hooks/specoe-license-check.mjs` manda `declaredRole` en el MISMO validate.** Lo
  lee de **`INTEGRA_SDD_ROLE`** —la misma env que ya consumen `specoe-role-check.mjs` y el cliente
  MCP para el header `x-sdd-role`— normalizado trim+upper. **Cero requests nuevos y cero lecturas de
  disco**: es una lectura de memoria, así que el presupuesto del hook (`HOOK_BUDGET_MS = 4500`, que
  ya comparten el activate, el validate y la derivación del `userContext`) no se toca. **Sin la env
  el body queda byte-a-byte como antes**: una instalación que no la setea no se rompe, y el Hub la
  registra como `NOT_DECLARED` — que es como se cuenta cuántas máquinas siguen atrasadas sin ir
  máquina por máquina.
- **El rol es INPUT, no un claim firmado.** El Hub lo **autoriza** contra los roles concedidos al
  usuario del seat; nunca lo acepta porque sí. Editar el launcher a mano para declarar un rol ajeno
  no sirve de nada salvo para quedar registrado como rechazo.
- **La fuente del rol es UNA.** `project.config.yaml` y `.mcp.json` siguen **inertes** como fuente
  de rol (ADR-001): una segunda fuente reabre el defecto que esta SPEC cierra —dos lugares que
  pueden discrepar y nadie sabe cuál gana—. La suite lo fija **midiendo el comportamiento** (yaml
  con `role: DISCOVERY` y sin la env ⇒ el rol no viaja), no leyendo el código: un grep no distingue
  «no lo lee» de «lo lee y lo descarta».
- **Mensaje de sesión ante rol rechazado, con prefijo estable `SPECOE-ROL-RECHAZADO`.** Nombra el
  rol declarado, dice que lo que falló es la **AUTORIZACIÓN y no la licencia**, avisa que los tools
  MCP van a servir el bundle producto, y da la acción concreta (pedir el rol a un ADMIN del tenant,
  o corregir `INTEGRA_SDD_ROLE`). El prefijo NO contiene `SPECOE-DIAG` como subcadena, así que un
  probe puede afirmar este aviso y el diagnóstico de licencia de forma independiente sobre el mismo
  texto.
- **Sólo el rechazo habla.** Los otros cuatro veredictos —rol concedido, usuario sin ningún rol
  (producto legítimo), y los dos del camino legacy— **conservan el mensaje vigente**. Inventarles un
  aviso convertiría el caso normal en ruido y el aviso del rechazo dejaría de leerse. La
  discriminación de los cuatro vive en el log, no en la pantalla.
- **Línea de log estructurada con `outcome` + `declaredRole` + `servedRole`,** en
  `~/.claude/logs/specoe-license-<fecha>.log`. Va **siempre**, también cuando el Hub no emite
  veredicto (tenant en MACHINE-mode): ahí no hay autorización que registrar, pero lo que el room
  declaró sigue siendo el dato útil.
- **No bloquea el arranque.** Hereda el contrato de salida de ADR-002 (SPEC-0164 P2): la licencia es
  válida, y cortar la sesión por la autorización del rol sería cambiar un room sin rol por un room
  sin sesión. El único corte sigue siendo el de siempre — sin licencia validada y sin caché de grace.
- **Suite nueva `rol-declarado-license-validate` (7 casos, con dos controles negativos).** Cubre las
  dos ramas del body (con la env y sin ella), la normalización, la inercia del yaml, los tres
  mensajes verificados **distintos entre sí** con exit 0 en los tres, los cinco veredictos posibles y
  el log en todos los caminos. Los controles positivos están corridos: sacar el campo del body pone
  en rojo tres casos, y anular el aviso pone en rojo otros dos — un verde que no puede dar rojo no
  es un gate.

Este cambio llega a una máquina por **instalación del bundle** (`setup.sh --host-only`), no por
actualizar el Hub. Un room con el hook anterior no declara rol y sigue funcionando por el camino
legacy.

**También entró en esta versión, sin relación con lo de arriba:**

- **`docs/TROUBLESHOOTING.md` — re-alineación de la tabla del mapa de FAILs (TKT-0221).** Las dos
  filas que sumó 0.2.9 eran más anchas que el resto y la tabla quedó sin re-alinear. **Sólo
  whitespace: 19 líneas, cero cambios de contenido** — ningún mensaje ni ninguna sección cambia de
  texto. Se nombra acá porque un diff de 0.2.9 a 0.2.10 muestra 38 líneas tocadas en ese archivo y
  conviene saber de antemano que no hay nada que leer ahí.

## 0.2.9 — 2026-07-30 (TKT-0221 — el verificador dejaba pasar la versión de Node que la SPEC vino a prohibir)

**`scripts/smoke-test.sh` daba PASS en Node 20.** SPEC-0164 P3 subió el piso a 22.19.0 —porque
abajo de esa versión `tls.setDefaultCACertificates` no existe y el canal TLS del bundle no puede
armarse— pero la declaración vieja `>= 20 sin techo` sobrevivió en el **verificador de la
instalación**. O sea: el instalador abortaba correctamente y el smoke-test, corriendo después,
declaraba verde sobre una instalación donde el canal no podía funcionar. **Es el verde-falso que
la SPEC existe para matar, un escalón al costado**, y ya viajó al espejo público en `starter-v0.2.3`.

- **`scripts/smoke-test.sh` — el único de los tres sitios con lógica de gate activa.** Pasa a usar
  el mismo criterio que el preflight del instalador: rango numérico `22.19.0` a `26.x` con **Node 23
  excluido explícitamente**, más la segunda capa que comprueba en runtime que
  `tls.setDefaultCACertificates`/`getCACertificates` existan de verdad en esa versión. Estar dentro
  del rango no prueba que la API esté: son dos chequeos, no uno.
- **`.claude-bundle/hooks/package.json` — `engines.node` declarativo, y viaja al cliente.** Mientras
  decía `>=20`, `npm` no rechazaba la instalación de los hooks en una versión donde no pueden
  funcionar. Ahora declara `>=22.19.0 <23.0.0 || >=24.0.0 <27.0.0`, que expresa la exclusión de
  Node 23 en la propia sintaxis de rangos (un `>=22.19.0 <27` no la expresaría).
- **Documentación alineada** — `docs/RUNBOOK-ONBOARDING-CLIENTE-EXTERNO.md` (las **tres**
  menciones: prerrequisitos, troubleshooting y checklist de cierre), `README.md` y
  `docs/TROUBLESHOOTING.md`. Este último citaba los mensajes literales del smoke-test y traía una
  nota que decía «el smoke-test todavía declara el viejo `>= 20`»: con el gate arreglado esa nota
  pasaba a ser falsa, así que se corrigió junto con los mensajes.
- **`scripts/test-node-range-gate.sh` (nuevo, interno).** Ejerce el gate contra versiones
  sintéticas —20.20.2, 22.18.0, 22.19.0, 23.0.0, 23.11.1, 26.5.0, 27.0.0— leyendo las constantes
  **del propio `smoke-test.sh`**, no re-declarándolas. Un rango sin un test que lo ejerza vuelve a
  aflojarse solo; ahora aflojarlo tiene que ser deliberado.

Rango canónico, medido y no elegido (SPEC-0164 P3 / ADR-004, medición 2026-07-28): **22.19.0 a
26.x, Node 23 afuera, probado hasta 26.5.0**.

## 0.2.8 — 2026-07-29 (SPEC-0167 P4 — el quickstart en línea con lo que el instalador exige hoy)

- `docs/QUICKSTART-VSCODE.md` actualizado para que refleje el flujo real del instalador: el onboarding de dos pasadas (host + room) y los pasos que el setup exige hoy. Corrige el texto que había quedado desalineado con el comportamiento actual del instalador.

## 0.2.7 — 2026-07-29 (TKT-0234 — el verificador ya no se cuelga: el deadline pasa a ser un corte)

**`./specoe-verify-room.sh` se colgaba en el chequeo 4/5 cuando el room estaba BIEN servido.**
No se perdía el serving —el room funcionaba—, pero el verificador no podía emitir su veredicto
sobre una instalación sana y había que matarlo a mano.

- **TKT-0234 — los deadlines que el verificador anunciaba no existían.** Cada corrida abría con
  «deadlines: 8000 ms por chequeo, 40000 ms total» y no cumplía ninguno de los dos: los números
  solo viajaban como argumento a `withTimeout`, que corre contra las esperas del stream SSE. Los
  `fetch` —el GET que abre el SSE y los POST de cada mensaje JSON-RPC— **no tenían corte de
  ninguna clase**. Un server que acepta la conexión y nunca manda cabeceras de respuesta (típico:
  upstream caído detrás del proxy) dejaba ese `await` pendiente para siempre. Reproducido con un
  server de agujero negro: el chequeo 4 pasó los 40 s del total y hubo que matar el proceso.
- **El fix es estructural, no un timeout puntual.** (1) Cada `fetch` corre bajo un deadline que
  al vencer **aborta** la sesión en vuelo; (2) **cada chequeo** corre bajo su propio deadline como
  carrera, así que cualquier cuelgue —de red o no, previsto o no— sale **ROJO nombrando el corte**
  en vez de colgar; (3) el deadline TOTAL se respeta como reloj: un chequeo que arranca sin
  presupuesto no corre y lo dice. Un chequeo cortado **nunca** sale verde: cortarse es no haber
  podido observar el efecto.
- **`CHECK_DEADLINE_MS` ahora acota el chequeo entero,** no cada `await` por separado. El chequeo 4
  encadena tres esperas de red (abrir el SSE, `initialize`, `tools/call`) y antes podía tardar el
  triple de lo que el encabezado declaraba. `SPECOE_VERIFY_CHECK_TIMEOUT_MS` y
  `SPECOE_VERIFY_TOTAL_TIMEOUT_MS` siguen ajustando los dos para instalaciones lentas.
- **El cuerpo de las respuestas POST se descarta explícitamente.** Nadie lo consumía y undici no
  devuelve el socket al pool mientras una respuesta siga sin leer.
- **Suite nueva `verificador-deadline-efectivo` (6 casos, con control positivo).** Cubre el server
  que acepta y se calla en el GET y en el POST, el aislamiento entre los chequeos 4 y 5, y la
  reproducibilidad de O5. El control positivo (server sano → 4 y 5 en OK) está para que un
  verificador que corte SIEMPRE no pase: «todo rojo» no es un gate. Contra el verificador anterior
  al fix, 4 de los 6 casos dan rojo — medido, no supuesto.
- **Nota sobre la suite de TKT-0225.** Su escenario A **sí** ejercitaba el camino feliz del chequeo
  4 y seguía en verde: el agujero no estaba ahí. Lo que ningún test cubría era el server que acepta
  y no contesta — contra un server que siempre responde, este bug es invisible.

## 0.2.6 — 2026-07-29 (TKT-0232 — el arranque declara el usuario del seat: en USER-mode el room ya baja el bundle de su rol)

**EN USER-MODE, TODO ROOM RECIÉN INSTALADO CORRÍA COMO PRODUCTO. Se repara solo al actualizar
—sin re-login— pero hay que instalar el bundle nuevo (`setup.sh --host-only`).**

- **TKT-0232 — `specoe-license-check.mjs` manda `userContext` al `/license/validate`.**
  El hook validaba la licencia con `licenseKey` + `fingerprint` y nada más. En USER-mode
  (`Tenant.sddIdentityMode='USER'`) el Hub **no** lee `License.sddRole`: deriva el claim
  `sddRole` de los `UserSddRole` activos del usuario que el caller declara en `userContext`, y
  la derivación es **fail-closed** — sin ese campo emite el JWT **sin el claim**. El
  skill-server resuelve `role = payload.sddRole ?? null`, así que el room entero corría con el
  **bundle producto**: `room_contract_get` sin contrato y solo las skills libres. No fallaba
  nada de forma visible, por eso sobrevivió a dos tickets. Ahora el hook lee el userId del seat
  del canal de secretos y lo manda; en MACHINE-mode el Hub lo ignora, así que el hook no tiene
  que averiguar el modo del tenant. Sin material en el canal el body queda **idéntico** al de
  antes del fix.
- **El userId del seat viaja por el canal de secretos (`integra-sdd-identity`, `user-id`).**
  No se puede sacar del material que ya había: el `UserSddToken` es **opaco** (`isdd_` + 32
  bytes random) y `/auth/sdd/login` no devuelve el userId. La única fuente es el `sub` del JWT
  que emite `/auth/sdd/session`. `sdd-login.mjs` lo deriva **una vez** al hacer el login y lo
  deja guardado (`userIdStored` en su salida, `userId` en `status`), y el hook de arranque lo
  lee de ahí — un request por instalación, no uno por sesión.
- **La instalación anterior al fix se repara sola.** Si el canal tiene token + machineId pero no
  el userId, el hook lo deriva en el primer arranque y lo persiste: **no hace falta re-login**.
  Solo se intenta cuando queda presupuesto de hook suficiente, para no cambiar un room sin rol
  por un room sin licencia.
- **El fingerprint SDD pasa a `hooks/sdd-identity.mjs`,** compartido por el login y el hook. Es
  distinto del fingerprint de licencia y una segunda copia que se separara haría que el Hub
  rechace la derivación con `MACHINE_FINGERPRINT_MISMATCH`.
- **`verify-room-serving.mjs` — el chequeo 4 ya no atribuye el claim ausente solo a la
  licencia.** Decía «es una licencia de producto → instalá con `specoe-add-room.sh <ROL>
<LICENSE_KEY>`», que es el razonamiento de MACHINE-mode: en USER-mode mandaba a cambiar la
  licencia cuando lo que faltaba era el login SDD. Ahora nombra las causas de los dos modos con
  la acción de cada uno.
- **Corrección de trail (subsume TKT-0227).** El QUICKSTART y el CHANGELOG de 0.2.5 decían que
  «en USER-mode el rol lo resuelve el server y el claim puede faltar sin que nada esté roto».
  **Es falso**: el skill-server no consulta `UserSddRole` en ningún momento y el claim **debe**
  estar en los dos modos. Lo que TKT-0227 planteó como hipótesis era este bug, no una decisión
  de diseño. Corregido en `docs/QUICKSTART-VSCODE.md` y en la cabecera del verificador.
- Suite nueva `usercontext-license-validate` (7 casos, incluido el control negativo de que sin
  material el campo no viaja) y `setup.sh` instala el módulo nuevo — el allowlist del bundle es
  por archivo y un módulo que falte ahí rompe el import antes de que corra el hook.

## 0.2.5 — 2026-07-28 (TKT-0222 + SPEC-0167 P2 + TKT-0225 — hosts sin EOL, corte del check de config y verde falso del verificador)

**EL INSTALADOR AHORA CORTA CON EL `project.config.yaml` DEL TEMPLATE (SPEC-0167 P2, ADR-003) — leer antes de actualizar.**
El check de config de `setup.sh` pasa de advertir a **abortar** cuando encuentra campos sin
editar, y el flujo de `specoe-add-room.sh` queda declarado **de dos pasadas**: la primera
instala máquina + keyring + identidad y corta pidiendo el yaml completo; la segunda instala el
room. Antes el check solo miraba campos vacíos, el template pasaba y la instalación fallaba
varios pasos después, lejos de la causa.

- **TKT-0222 — `specoe-setup-host.sh` normaliza el `hosts` antes de agregar las entradas.**
  El bloque elevado hacía `Add-Content` sin garantizar que el archivo terminara en salto de
  línea. Con un `hosts` cuya última línea no tiene EOL y termina en comentario (caso real:
  `# gen digital helper server` de Gen Digital — Norton / Avast / AVG), la primera entrada se
  concatenaba detrás del `#`: **`hub.integra.local` quedaba comentado e inerte** y solo
  `mcp.integra.local` funcionaba. Ahora se agrega el salto antes del append. Re-correr el
  install sobre una máquina ya rota **la repara** (agrega la entrada sana; la pegada queda
  inerte).

- **SPEC-0167 P2 — el check de config corta con valores de template y el corte no se lleva la
  provisión del room.**
  La lectura del campo queda **anclada a su sección** (`specoe_yaml_get`): antes se buscaba por
  el último segmento del nombre sobre el archivo entero y ganaba la primera coincidencia, así
  que una clave homónima ubicada antes del campo objetivo hacía que el check evaluara un campo
  distinto del que declaraba evaluar. La detección de valores de template compara contra el
  yaml **versionado del propio clone** (`git show HEAD:project.config.yaml`) sobre cinco campos
  — `project.name`, `project.vendor`, `paths.workspace-root`, `database.logical-name` y
  `pasoe.instance-name`; `specoe.role` y `hub.api-url` quedan afuera porque los reescribe el
  instalador. Si `git show` no resuelve hay fallback a sentinelas literales, **declarado en
  pantalla como modo degradado**. En `specoe-add-room.sh` los bloques de keyring e identidad SDD
  se mueven **antes** del `setup.sh --room-only`: el corte abortaba el subshell antes de
  persistir la licencia y la primera corrida de cualquier rol terminaba con la carpeta clonada,
  el rol fijado y **sin licencia en el keyring** (ADR-005).

- **TKT-0225 — el verificador discrimina el rol servido y el room declara la divergencia de
  tokens.**
  El room usa **dos JWT**: el del cache por-carpeta, con el que `specoe-room-bootstrap.mjs` baja
  el contrato, y el del `.mcp.json`, con el que corren los tools MCP de la sesión.
  `specoe-license-check.mjs` los escribe juntos, pero una edición a mano del `.mcp.json` los
  separa y nadie comparaba sus claims: el chequeo 5 de `verify-room-serving.mjs` daba verde con
  solo abrir la sesión — y un JWT de producto la abre igual. Los cinco chequeos podían dictaminar
  SERVIDO con la sesión corriendo como producto: **el verde falso dentro de la herramienta que
  existe para detectarlo**. Ahora el chequeo 5 pide `room_contract_get` con el token del
  `.mcp.json` y exige el **mismo contrato** que bajó el chequeo 4 con el del cache — se
  discrimina por el contrato servido y no por el claim `sddRole`, que en USER-mode lo resuelve
  el server y puede faltar sin que nada esté roto (TKT-0227). `specoe-room-bootstrap.mjs`
  compara su token contra el efectivo del `.mcp.json` y adjunta `SPECOE-ROOM-TOKEN-DIVERGENTE`
  al `additionalContext` (el sentinel `SPECOE-ROOM-CONTRACT` no se toca: la advertencia se
  concatena). Suites nuevas: `token-divergente` (6 casos) y `verificador-discrimina-rol` (3,
  contra un skill-server SSE falso que sirve por token).

## 0.2.4 — 2026-07-28 (SPEC-0167 P1 — preflight de ExecutionPolicy en el setup del host)

- El preflight de `specoe-setup-host.sh` ahora observa la ExecutionPolicy efectiva de PowerShell antes de declarar el host sano, la remedia en scope CurrentUser cuando bloquea la ejecución de scripts, y verifica el resultado ejecutando el shim real en vez de confiar en el exit code de `Set-ExecutionPolicy`.

## 0.2.3 — 2026-07-28 (SPEC-0164 — conectividad thin-client → Hub desde VSCode)

**CAMBIO DE CONTRATO DEL HOOK DE LICENCIA (ADR-002) — leer antes de actualizar.**
`specoe-license-check.mjs` ya no sale 0 siempre: **a partir de esta versión el arranque del
room puede bloquearse**. Bloquea únicamente cuando intentó validar y **no hay cache de grace**
(`continue: false` + exit 2). Con cache de menos de 24 h arranca igual y lo dice en pantalla;
una carpeta sin licencia sigue arrancando (no es un room roto, es una sesión sin SpecOE).
El bloqueo lleva siempre los cuatro datos del diagnóstico (errno real, URL del Hub resuelta con
su fuente, fuente de CA que ganó, acción concreta) y la vía de escape ejecutable: la variable
`SPECOE_ALLOW_DEGRADED_START` o el archivo `.claude/specoe-allow-degraded-start` en el room.
Si el diagnóstico sale incompleto **no bloquea** — un bloqueo mudo deja al dev sin sesión y sin
dato, que es peor que no bloquear.

**CAMBIO DE MECANISMO DEL CA (ADR-001) — una máquina ya instalada NO se actualiza sola.**
No hay migración: hay que **reinstalar el bundle** (`./setup.sh` o `specoe-setup-host.sh`), que
es lo que copia los hooks nuevos a `~/.claude/hooks/`. Hasta hacerlo, la máquina sigue con el
mecanismo viejo.

- Canal TLS único en `.claude-bundle/hooks/ca-channel.mjs`, importado por el hook de licencia,
  el bootstrap del room y `sdd-login.mjs`. Reemplaza al dispatcher global de undici, que medido
  en Node v26.5.0 **el `fetch` global no honra**: la función era un no-op que además logueaba
  éxito. Ahora se muta el default CA store del proceso, armado desde `system` + `bundled` + el
  CA de Caddy — `default` deja el trust de Windows afuera y rompe toda máquina con SSL scanning
  del antivirus.
- Se elimina `env.NODE_EXTRA_CA_CERTS` de `.claude/settings.json`, y `setup.sh` deja de
  inyectarla en la línea de comando del login: era el segundo mecanismo de CA del starter.
  Encima llevaba `${env:USERPROFILE}` adentro —interpolación de VSCode que Node descarta con un
  warning— y bajo la extensión de VSCode esa variable **no le llega al hook**. El CA queda
  definido en un solo lugar y se lee del archivo.
- El hook de licencia deja de mentir sobre por qué falla: distingue el corte de red pasajero de
  la instalación que nunca funcionó, y el bootstrap del room declara cuando arranca **sin
  contrato de gobierno** en vez de seguir en silencio.

**Verificador nuevo `specoe-verify-room.sh`** (raíz del starter) + `.claude-bundle/scripts/verify-room-serving.mjs`.
Cinco chequeos por efecto sobre un room ya instalado — canal TLS contra el Hub, JWT del cache
con `exp` vigente, `.mcp.json` con el JWT real, contrato del room bajado, y `specoe` conectable
por SSE con la URL y el header literales del `.mcp.json`. Sale 0 solo con los cinco en verde.

**Rango de Node certificado: 22.19.0 a 26.x, Node 23 afuera** (ADR-004). Medido, no elegido:
`tls.setDefaultCACertificates` —sobre la que se apoya el canal— no existe en 20.x, ni en 22.x
previo a 22.19.0, ni en 23.x. El preflight de `setup.sh` y `specoe-setup-host.sh` **aborta**
fuera del rango y comprueba además que la API exista en esa versión; antes pedía "20+ sin
techo", y la VM del incidente corría 26.5.0 dentro de lo declarado con el canal inexistente.

- `setup.sh` copia el CA local del starter de forma **incondicional**: antes solo lo instalaba
  si el destino no existía, así que un `.crt` viejo o de otro emisor sobrevivía invisible.
- `setup.sh` instala `ca-channel.mjs` en el bundle (allowlist de `install_force`) — sin eso los
  hooks importan un módulo que el instalador no copia.
- Guías: `QUICKSTART-VSCODE.md` y `TROUBLESHOOTING.md` dejan de recomendar el fix por variable
  de entorno que la medición invalidó.

## 0.2.2 — 2026-07-23 (TKT-0217 — instalación en máquina limpia sin pasos manuales)

- `.gitattributes` (raíz del starter, se sincroniza a la raíz del repo público): `*.sh eol=lf`.
  En Windows con `core.autocrlf=true` el checkout dejaba los `.sh` en CRLF y el shebang
  quedaba `#!/usr/bin/env bash\r` → `/usr/bin/env: 'bash\r': No such file or directory`.
  Había que pasarles `sed -i 's/\r$//'` a mano antes de poder correr nada.
- Selección del binario de Node consciente de WSL (`setup.sh`, `specoe-add-room.sh`,
  `specoe-launch-thinclient.sh`). `node.exe` se sigue prefiriendo en Git Bash (bypassa
  winpty, TKT-0200) pero en WSL entra por el interop y lee las rutas Unix como Windows
  → `Cannot find module 'C:\home\...'` en `sdd-login.mjs`. En WSL va el `node` de la distro,
  y el chequeo de prerrequisitos lo dice explícito si no está instalado.
- `setup.sh` instala el CA local desde el `certs/` del propio starter cuando falta
  `~/.claude/caddy-local-root.crt`; antes el login moría con
  `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` sin decir de dónde sacarlo. Si el TLS falla igual,
  el error nombra el comando exacto para instalarlo.
- `setup.sh --login` ya no exige haber corrido `--host-only` antes: si falta el bundle,
  corre la parte de máquina y sigue al login.

## 0.2.1 — 2026-07-23 (SPEC-0157 P6 — fix sync del bundle al espejo)

- `.syncignore`: ancla `scripts/` a la raíz (`/scripts/`). El patrón sin anclar excluía
  también `.claude-bundle/scripts/` del espejo público: el bundle llegaba sin
  `provision-secrets.mjs` ni `sdd-login.mjs` y el login SDD del starter público
  no podía instalarse (verde-falso detectado por la verificación del espejo de T6.3).

## 0.2.0 — 2026-07-23 (SPEC-0157 P6 — identidad por usuario)

- Login SDD por usuario: `setup.sh --login` / `specoe-setup-host.sh` piden Hub URL + email + clave,
  llaman `POST /auth/sdd/login`, enrolan el equipo y guardan UserSddToken + machineId
  (y token robot si vino) en el keyring del SO — cero secretos en archivos.
- `.mcp.json` del room en modo USER: `INTEGRA_SDD_IDENTITY_MODE=USER` + `INTEGRA_SDD_ROLE`
  (rol como config de la carpeta, claim sin firma autorizado server-side). Se eliminan
  credenciales robot y cuid de tenant de todos los artefactos generados.
- `specoe-launch-thinclient.sh` sin `<TENANT_ID>` ni credenciales: solo el rol.
- `specoe-gate-messages.sh`: mapeo de cada código 403 del gate SDD (ADR-006) a instrucción
  accionable en castellano (+ test `scripts/test-gate-messages.sh`).

## 0.1.0 — 2026-04-18 (initial scaffold)

- Structure del starter con .claude/ + docker/ + docs/ + scripts/ + examples/
- Template `project.config.yaml` con todos los campos obligatorios
- Installer bash + PowerShell con validacion basica
- Stubs de skills/commands/agents/standards apuntando a MCP Skill Server
- docker-compose.yml con Hub local (placeholder hasta images publicas)
- Docs QUICKSTART, CONFIGURATION, TROUBLESHOOTING
- Scripts release, changelog, test-starter
