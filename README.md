# specoe-openedge-starter

Starter template for Progress OpenEdge projects powered by **SpecOE** — AI-assisted Spec-Driven Development workflow for ABL/PASOE development.

## Status

🚧 **Placeholder**. This repo is the public mirror of the canonical starter that lives in the private `specoe-platform/packages/starter-template/` monorepo. Content is published here automatically on each release via a sync pipeline.

The first real release will populate:

- `setup.sh` / `setup.ps1` — cross-platform installer
- `project.config.yaml` — project template (schema validated)
- `.claude/` — Claude Code configuration with skills, commands, agents, standards
- `docker/` — PASOE CI/CD artifacts (client-side build, no Hub here)
- `docs/` — QUICKSTART, CONFIGURATION, TROUBLESHOOTING
- `examples/sample-entity/` — working example
- `scripts/` — release, changelog, smoke-test

## What is SpecOE

SpecOE is an AI Dev Accelerator for Progress/OpenEdge teams. It combines:

- **Claude Code** as the IDE layer
- **MCP Skill Server** that serves curated ABL patterns, templates, and workflow
- **Integra Hub** for project tracking (specs, phases, tickets, KB, CRM)
- **Spec-Driven Development (SDD)** as the methodology

Result: a dev writes a PDF spec → `/nueva-entidad` → generated `.cls` + `.i` + tests + business rules compliant.

## Deployment model

**SaaS (default)**: Hub and Skill Server are centrally hosted by Integra Software at `hub.integrasoftware.biz`. Clients only need:

- Node.js 20+
- Git
- Claude Code CLI
- SpecOE license (or trial)

No Docker, no Hub infra on the client side.

**Suite on-premise (premium)**: for customers requiring self-hosting. Separate deliverable, not in this repo. Contact: `soporte@integrasoftware.biz` with subject "Suite on-premise".

## Get started

(Populated on first release. Until then, see the upstream private repo or contact Integra Software for preview access.)

## Contributing — this repo does NOT accept external PRs

**Este repo es un mirror automático** del contenido que vive en el monorepo privado `specoe-platform/packages/starter-template/`. Cada release corre un pipeline de sync que **reemplaza el contenido del repo público** con el del upstream (preservando solo `.git/`).

**Consecuencia**: cualquier PR mergeado directamente acá **se pierde en el próximo sync**. Por eso no aceptamos PRs externos en este repo.

### ¿Querés contribuir?

- **Bug report o feature request** → abrí un issue en este repo. Lo trasladamos al upstream y se trackea bajo la SPEC correspondiente en Integra Hub.
- **Corrección de un typo / docs fix** → issue acá con la sugerencia. No te abocamos un PR directo porque se sobreescribe.
- **Cambios grandes o código** → contactá a `soporte@integrasoftware.biz`. Las contribuciones significativas requieren NDA por el modelo IP de SpecOE (ver license abajo).

### ¿Por qué este modelo?

- El canonical source es privado (`specoe-platform`). El starter público es solo la parte que se comparte libremente (MIT).
- Mantener la lógica del sync unidireccional simplifica el pipeline y evita divergencia entre público y upstream.
- Otras partes del producto (Skill Server, Hub, Agent Gateway) son proprietary y no viven acá.

## Contact

- Integra Software: `soporte@integrasoftware.biz`
- Trial requests: `soporte@integrasoftware.biz` with subject "SpecOE trial"
- Documentation (public): https://specoe.integrasoftware.biz (TBD)

## License

[MIT](./LICENSE) — see LICENSE file.

SpecOE the platform (Skill Server IP-protected content, Hub, Agent Gateway) is proprietary — this repo only contains the public starter template, licensed permissively to encourage adoption.

## Reference

- Origin: SPEC-0020 FASE 2 (Limpieza), specifically S08 / SPEC-0024 F1
- Upstream canonical source: `specoe-platform/packages/starter-template/` (private)
- Sync pipeline: triggered on each release tag of the upstream monorepo
