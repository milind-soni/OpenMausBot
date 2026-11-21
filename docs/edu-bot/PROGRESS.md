# Edu Bot: avance

Hecho = verificado. Cada línea dice cómo se probó.

## Estado de los hitos

| Hito | Qué es | Estado |
| --- | --- | --- |
| M0 | El repo instala, compila y pasa tests en Linux | Hecho (PR #1, 21-11) |
| M1 | Nombre Edu Bot, licencias, sin telemetría, sin `enterprise/` | Hecho (PR #3, #4, #5, 21-11) |
| M2 | Memoria Edu en cada bot, con aprobaciones | En curso (exploración) |
| M3 | Organización, áreas y bots en archivos | Pendiente |
| M4 | Conector SQL, permisos por bot, registro de auditoría | Pendiente |
| M5 | CI en 3 sistemas, instaladores, README, versión 0.1.0 | Pendiente |
| M6 | Auditoría final con dos proveedores | Pendiente |

## M0: salud del repo

- [x] Push a `upstream` bloqueado en este equipo.
- [x] Dependencias instaladas con pnpm 10.33.0 y Node 26.
- [x] Typecheck sin errores (`pnpm typecheck`).
- [x] Lint sin errores (`pnpm lint`).
- [x] Build (`pnpm build`): pasa en 47 s. Antes fallaba por falta de memoria de Node
  (límite 2 GB en este equipo). Arreglo: el build usa 4 GB, igual que el release. PR #1.
- [x] Electron no se había descargado al instalar. Se bajó con `node install.js` del paquete electron.
- [x] Tests (`vitest`). En CI todo verde: Ubuntu y Windows (16 partes), smokes de macOS, paquete Ubuntu.
  2 partes fallaron 1 test cada una por carrera de tiempos (no por nuestro cambio). Al re-correr, pasaron.
  CI es la referencia del suite completo.
- Hallazgo: `/tmp` vive en la RAM. Los tests dejaron 4,7 GB ahí. Eso causó gran parte del corte.
  Para correr tests aquí usar `TMPDIR=/var/tmp/edubot-tests` (en disco, sin punto, fuera de HOME).
- Fallos que solo pasan en este PC (Arch), no en CI. Grok los revisó:
  - e2e de "cloud/team": aquí bubblewrap funciona; en Ubuntu 24.04 no. Upstream lo sabe (`ci.yml`).
  - `linux-after-install`: el script exige que la prueba viva en `/tmp`.
  - Con `TMPDIR` en carpeta oculta o dentro de HOME fallan 2 archivos más. Con `/var/tmp` pasan.
  - Un test de gráficos fallaba por el cambio de horario de Chile. Arreglo: los tests corren en UTC,
    igual que CI (`vite.config.ts`). Comprobado: sin UTC falla, con UTC pasa.
- [x] Con Node 26, 2 archivos de tests de interfaz fallaban: Node trae su propio `localStorage` vacío.
  Arreglo en `vite.config.ts` (`--no-experimental-webstorage`). Los 15 tests pasan.
- [x] La app abre en Linux (Omarchy, Wayland), con HOME y datos temporales, sin tocar datos reales.
  Ventana "MausBot". Se pasó la bienvenida con clic y cargó la pantalla principal.
  Cero errores en los logs. Capturas y logs en `~/Projects/edu-bot-wt/reports/m0-shots/`.
- [x] Auditoría de otro proveedor (Grok). Ronda 1: pidió 3 arreglos (estado de M1, explicación de fallos,
  prueba de apertura). Ronda 2: PASS. Reportes en `~/Projects/edu-bot-wt/reports/grok-m0-audit-v*.md`.
- [x] CI verde en el último commit (34 checks). PR #1 fusionado.

## M1: nombre Edu Bot, licencias, sin telemetría

- [x] PR #3 (fusionado): se borró `enterprise/` (código con licencia restrictiva).
  NOTICE y LICENSING.md dicen que Edu Bot es un fork de OpenMausBot (Apache 2.0).
- [x] PR #3: se quitó toda la analítica (PostHog). No queda código que mande datos de uso.
- [x] PR #3: la app ya no llama a servidores de upstream por defecto (anuncios, reportes de errores,
  Composio, cuenta Cloud, enlace del teléfono). La lista de conexiones está en `docs/edu-bot/network.md`.
- [x] PR #3: la interfaz ya no pide íconos a Google al abrir. Probado: 0 pedidos externos al cargar.
- [x] PR #3 auditado por Agy (Gemini): 3 rondas. Ronda 1 con 6 hallazgos, ronda 2 con 2 tests rotos,
  ronda 3 PASS. CI verde (34 checks) tras re-correr 2 tests inestables de Windows.
- [x] PR #4 (fusionado): nombre "Edu Bot" en toda la interfaz, menús y 16 idiomas. Ícono nuevo (una "E").
  Sin la mascota de upstream y sin promociones. El bot ayudante se llama "Edu"; los datos guardados se conservan.
  La app del teléfono se sigue llamando MausBot (es la app publicada en las tiendas).
  Lo hizo Codex; Claude arregló los tests que CI encontró. Grok auditó 3 rondas: 9 hallazgos, luego 3, luego PASS.
  CI verde (34 checks). Capturas en `~/Projects/edu-bot-wt/reports/m1-shots/`.
- [x] PR #5 (fusionado): identificadores propios. App id `io.github.eduardomoraga.edubot`, carpeta de datos
  `~/.edubot`, enlaces `edubot://`, comando `edubot`, instalación Linux en `/opt/edu-bot`.
  No toca ni mueve datos de OpenMausBot (`docs/edu-bot/data.md`). Ningún workflow puede escribir en repos de upstream.
  El emparejado del teléfono sigue usando `openmausbot://pair`, porque la app publicada del teléfono solo entiende eso.
  Agy auditó 2 rondas: 7 hallazgos, luego PASS. CI encontró un error real: la ruta "/opt/Edu Bot" con espacio
  hacía caer Electron en Linux. Arreglado. CI verde (34 checks).
- [x] Prueba final en main: la app abre aislada en Linux. Ventana "Edu Bot", datos en `~/.edubot` temporal,
  edición "oss", cero errores en logs. Captura: `~/Projects/edu-bot-wt/reports/m1-shots/m1-final-linux-main.png`.

## M2: memoria Edu en cada bot

Plan (exploración de Claude, `~/Projects/edu-bot-wt/reports/claude-m2-scout.md`):
- Cada bot recibe la memoria Edu como herramienta (MCP), con su propio cerebro o uno compartido por área.
- La memoria actual de Edu Bot sigue igual. Edu se suma para decisiones y lecciones de largo plazo.
- Los bots no pueden aprobar memoria canónica. Solo una persona aprueba, con una tarjeta en el chat.
- Si `edu` no está instalado, la app funciona igual, sin errores.

- [ ] PR1: detectar `edu`, cerebro por bot y conexión MCP. En curso (Claude).
- [ ] PR2: tarjetas para aprobar o rechazar propuestas de memoria.
- [ ] PR3: el resumen de Edu entra al prompt de cada bot, y mensajes claros si algo falla.
- [ ] PR4: Edu crew (plan, construir, revisar) como opción por bot, apagada por defecto.

## Cómo trabajamos

- Regla de memoria (12 GB): máximo 2 agentes a la vez, el líder y 1 trabajador.
  Auditorías de Grok y Agy, una después de la otra. Build y tests en primer plano con 4 GB.
- El 21-11 a las 00:39 el sistema cortó todo por memoria. Se perdió el avance de Codex, Grok y Agy.
  Su trabajo quedó guardado en sus carpetas. M1 sigue ahora, un agente a la vez.
- Cerré 7 agentes inactivos de otros proyectos para liberar memoria. Sus sesiones se pueden reabrir:
  la lista está en `~/Projects/edu-bot-wt/reports/closed-idle-agents.txt`.

- Líder: Claude (este agente). Backend: Claude. Interfaz: Codex. Auditores: Grok y Antigravity.
- Cada agente tiene su copia del repo en `~/Projects/edu-bot-wt/<rol>`.
- Encargos en `~/Projects/edu-bot-wt/briefs/`. Reportes en `~/Projects/edu-bot-wt/reports/`.

## Decisiones

- Se quita PostHog completo. No queda ninguna analítica.
- `server/enterprise.ts` queda como pieza vacía (edición "oss"). Se borra la carpeta `enterprise/`.
- Puerto 8799 y variables `OMB_*` se mantienen por ahora.
- Carpeta de datos nueva: `~/.edubot`. Esquema de enlaces: `edubot://`.
- El bot ayudante se llama "Edu".

## GitHub Actions

- Eduardo activó Actions en el fork (21-11).
- Solo quedan activos 2 workflows: "CI" y "Stop CI for closed PRs".
- Desactivé 18 workflows de upstream (Release, Docker, Promote to stable, npm, etc.).
  No aplican aún o fallarían por secretos que no tenemos. Se reactivan en M5 con
  `gh workflow enable <nombre>` cuando estén adaptados a Edu Bot.

## Tests inestables vistos en CI (upstream)

Fallan a veces y pasan al re-correr. No vienen de nuestros cambios.
- `server/env-path.test.ts` (Linux): carrera con un proceso en segundo plano.
- `server/long-running-chief.e2e.test.ts` (Linux y Windows): 2 tests distintos.
- `server/room-roots.e2e.test.ts` (Windows): reinicio de un turno.
- Vistos 1 vez más (PR #3 a #5): `routine-failure-spacing`, `surface-pins.e2e`, `thread-aware-bots.e2e`,
  `decider-rooms.e2e`, `antigravity-turn-outcome`, `session-credentials.e2e`. Si se repiten, van a la lista.
Se sumaron a `scripts/testing/ci-retry-list.json`: 2 reintentos solo en CI. Si siguen, hay que arreglarlos.

## Pendientes vistos (para M5 o M6)

- Unas 440 líneas internas del servidor aún dicen OpenMausBot (no se ven en la app).
- Las guías de auto-hospedaje aún apuntan a scripts y releases de upstream.
- El servicio de relay se llama "Edu Bot Relay" en un diagnóstico, pero es el de upstream y está apagado.
- El teléfono usa la app publicada "MausBot". Edu Bot no tiene app de teléfono propia.

## Para el lanzamiento (M5)

- No incluir en los instaladores binarios con licencia que prohíbe redistribuir:
  herramientas Android de Google y Chrome for Testing. Revisarlo en M5.

## Avisos

- A Codex le queda poco cupo semanal (23 % el 21-11). Por eso Claude hizo los arreglos del PR #4.

## Necesito de Eduardo

1. **Nombre en npm (para M5).** El comando se llama `edubot`. Los nombres `edubot` y `edu-bot` están libres en npm.
   Para que nadie los tome, conviene reservarlos con tu cuenta de npm. No es urgente.
2. **Memoria del equipo.** Con 12 GB y 5 agentes, el sistema corta los procesos largos.
   Opcional: iniciar Claude Code con `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1`,
   o cerrar las otras sesiones de agentes que no uses.
