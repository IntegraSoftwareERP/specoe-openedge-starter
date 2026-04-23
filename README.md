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
