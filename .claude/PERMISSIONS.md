# Permisos del room — criterio del allowlist

**TKT-0367.** Este archivo vive al lado de `settings.json` a propósito: el criterio con el que se
evalúa una entrada del allowlist tiene que estar donde se edita la lista, no en un ticket que nadie
va a releer cuando agregue la próxima.

## El criterio

> Una entrada del allowlist se clasifica por **lo que habilita**, nunca por **lo que aparenta**.

`permissions.allow` no restringe: **auto-aprueba**. Lo que no está en la lista igual se puede
correr — pide confirmación. Entonces la pregunta al agregar una entrada no es "¿el room necesita
esto?", es: **"¿qué es lo máximo que alguien puede hacer con esta entrada, sin que nadie se
entere?"**

El caso que originó el criterio: `Bash(npx *)` estaba en una lista que se lee entera como mínimo
privilegio — `git status`, `git log`, `git diff`, `git show`, `npm test`, `docker compose`. Se leyó
como "correr una herramienta de npm", vecino inocente de `npm test`. Lo que habilita es descargar y
ejecutar **cualquier** paquete del registry: ejecución de código arbitraria, silenciosa, en la
máquina del room. El allowlist aparentaba ser mucho más estrecho de lo que era.

El corolario, del Operador (2026-09-02): **apuntar un intérprete a un script no lo acota.**
`Bash(node ~/.claude/scripts/x.mjs *)` sigue siendo darle `node`. Y si un room necesita **leer**, la
respuesta no es darle con qué **ejecutar**: es que el Hub le deje el archivo (TKT-0368).

## Las entradas vigentes

Aplicado el criterio a la lista completa. La columna que decide es la tercera.

| Entrada                                    | Qué aparenta                  | Qué habilita realmente                                                                                                                                                                |
| ------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Read(**)`                                 | leer el repo                  | leer **cualquier** archivo de la máquina — claves privadas, `.env`, credenciales. Es la capacidad central del rol; el `**` no está acotado al repo.                                   |
| `Grep(**)` / `Glob(**)`                    | buscar en el repo             | barrido de toda la máquina, mismo alcance que `Read(**)`.                                                                                                                             |
| `Bash(git status)`                         | estado del repo               | exactamente eso. Sin comodín: la única entrada realmente cerrada de la lista.                                                                                                         |
| `Bash(git log *)`                          | leer la historia              | lectura. `git log` no escribe archivos ni ejecuta nada por sí solo.                                                                                                                   |
| `Bash(git show *)`                         | leer objetos                  | lectura. No tiene `--output`.                                                                                                                                                         |
| `Bash(npm test *)`                         | correr los tests              | ejecuta el script `test` del `package.json` **del repo revisado** — código arbitrario controlado por ese repo, no por nosotros. Es el propósito de la entrada, pero conviene saberlo. |
| `Bash(npx specoe-validate *)`              | validar `project.config.yaml` | ejecuta **ese** paquete (lo baja del registry si no está). Acotado a un binario nombrado.                                                                                             |
| `Bash(npx --no-install specoe-validate *)` | ídem, sin red                 | ídem pero sin descargar: sólo corre el binario si ya está instalado. Es la forma que usa `scripts/smoke-test.sh`.                                                                     |

## Retiradas — no reponer sin leer esto

Tres entradas salieron aplicando el criterio de arriba. Están acá y no borradas del todo porque el
motivo es lo que evita que vuelvan.

| Entrada retirada         | Por qué salió                                                                                                                                                                                                                                                                                                                                                                            | Reemplazo                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Bash(npx *)`            | Descarga y ejecuta **cualquier** paquete del registry. Ejecución de código arbitraria, auto-aprobada.                                                                                                                                                                                                                                                                                    | Las dos formas de `npx specoe-validate` que están en la tabla de arriba.             |
| `Bash(docker compose *)` | `docker compose run -v /:/host <img> sh -c '...'` monta el **filesystem del host completo** y corre con los privilegios del daemon. Tan amplio como `npx`, o más. Además el room no tiene un `docker-compose.yml` que levantar: el `docker/` del starter son artefactos de build de PASOE, y el `docker-compose.yml` del Hub es del tier Suite, para la infra del cliente — no del room. | Ninguno. Si algún día un room necesita levantar un stack, va la invocación concreta. |
| `Bash(git diff *)`       | **Escribe**: `git diff --output=<archivo>` crea o pisa un archivo arbitrario. Es un primitivo de escritura dentro de una entrada que se lee como de lectura.                                                                                                                                                                                                                             | Ninguno. `git diff` sigue disponible — pide confirmación, que es el freno buscado.   |

Costo asumido a sabiendas: **`git diff` es lectura casi siempre**, y ahora pide confirmación cada
vez. La fricción es real y se aceptó igual — una entrada que escribe archivos no puede estar
auto-aprobada por la comodidad del caso feliz. Si esa fricción resulta insostenible en la práctica,
lo que corresponde no es reponer `Bash(git diff *)`: es que Claude Code permita excluir un flag, o
acotar la entrada a las formas concretas que el room usa.

## Límite de lo que esta lista puede prometer

El matcheo de `Bash(...)` es **textual sobre el prefijo del comando**. Acota; no es un sandbox. Una
entrada angosta reduce mucho la superficie y hace que lo demás pida confirmación —que es el freno
real—, pero no convierte al room en un entorno aislado. Si lo que hace falta es una garantía y no
una contención, la respuesta no es una entrada más en esta lista.

## Antes de agregar una entrada

1. Escribir qué es **lo máximo** que habilita, no para qué se la quiere.
2. Si eso incluye "ejecutar código que no controlamos" o "escribir en cualquier ruta", acotarla a la
   invocación concreta — o dejar que pida confirmación.
3. Si la invocación concreta no se puede nombrar, la entrada no está lista.
4. Agregarla acá, en la tabla, con las tres columnas completas.

`scripts/test-permissions-allowlist.sh` verifica en CI que ninguna entrada auto-apruebe un ejecutor
comodín y que **todas** las entradas vigentes estén nombradas acá. Agregar una sin documentarla pone
rojo.
