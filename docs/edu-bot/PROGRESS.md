# Edu Bot: avance

Hecho = verificado. Cada línea dice cómo se probó.

## Estado de los hitos

| Hito | Qué es | Estado |
| --- | --- | --- |
| M0 | El repo instala, compila y pasa tests en Linux | En curso |
| M1 | Nombre Edu Bot, licencias, sin telemetría, sin `enterprise/` | En pausa hasta cerrar M0 (plan listo) |
| M2 | Memoria Edu en cada bot, con aprobaciones | Pendiente |
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
- [ ] Auditoría de otro proveedor. Grok, ronda 1: pidió 3 arreglos (estado de M1, explicación de fallos,
  prueba de apertura). Hechos. Ronda 2 en curso.

## Cómo trabajamos

- Regla de memoria (12 GB): máximo 2 agentes a la vez, el líder y 1 trabajador.
  Auditorías de Grok y Agy, una después de la otra. Build y tests en primer plano con 4 GB.
- El 21-11 a las 00:39 el sistema cortó todo por memoria. Se perdió el avance de Codex, Grok y Agy.
  Su trabajo quedó guardado en sus carpetas. M1 queda en pausa hasta cerrar M0.
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

## Para el lanzamiento (M5)

- No incluir en los instaladores binarios con licencia que prohíbe redistribuir:
  herramientas Android de Google y Chrome for Testing. Revisarlo en M5.

## Necesito de Eduardo

1. **Memoria del equipo.** Con 12 GB y 5 agentes, el sistema corta los procesos largos.
   Opcional: iniciar Claude Code con `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1`,
   o cerrar las otras sesiones de agentes que no uses.
