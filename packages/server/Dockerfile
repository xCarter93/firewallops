# Source: docs.colyseus.io/deployment (Node 22 base, EXPOSE 2567) + pnpm monorepo conventions.
# This Dockerfile FILE lives under packages/server/, but its build CONTEXT is the REPO ROOT
# (Railway's Root Directory stays unset; railway.json `dockerfilePath` points here with repo-root
# context). Therefore every COPY path below is relative to the repo root — do NOT rewrite them
# relative to packages/server/. The repo-root install is what lets the workspace:* deps
# (@shared/sim, @firewallops/convex) resolve (Pitfall 2). The boot fix is host-agnostic.
FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app

# --- deps layer: copy manifests first for layer caching; install from REPO ROOT ---
# `.pnpmfile.cjs` (Plan 05) MUST be copied alongside the lockfile: pnpm records a
# `pnpmfileChecksum` in pnpm-lock.yaml, and `--frozen-lockfile` recomputes it from the
# pnpmfile present in the build context. Omit the file and pnpm sees a different (no-pnpmfile)
# config → ERR_PNPM_LOCKFILE_CONFIG_MISMATCH. (Same class as the tsconfig.base.json COPY below.)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
COPY harness/package.json harness/
# Convex is its own workspace package (Plan 01); its manifest is needed so --frozen-lockfile
# can resolve the @firewallops/convex workspace dep the server declares.
COPY packages/convex/package.json packages/convex/
# --frozen-lockfile fails fast if the lockfile is stale after Plan 01/03 added deps.
# MUST run from /app (repo root) so workspace:* deps resolve (Pitfall 2).
RUN pnpm install --frozen-lockfile

# --- source layer ---
# Pitfall 1 (part 2): packages/server/tsconfig.json `extends ../../tsconfig.base.json`.
# Without the base file in the image the extends chain breaks, tsx silently loses
# experimentalDecorators, and @colyseus/schema @type() compiles as modern TC39
# decorators (`__decorateElement`) → boot crash at MatchState import. Copy it to /app
# so /app/packages/server/tsconfig.json resolves its extends (covers every package).
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
# Pitfall 7: the committed packages/convex/convex/_generated/ must ship in the image so the
# server's import of @firewallops/convex/api resolves at runtime (the in-image pnpm install
# symlinks the package; this COPY provides the real source + codegen).
COPY packages/convex packages/convex
# (packages/client is intentionally NOT copied — not needed in the server image.)

EXPOSE 2567
ENV PORT=2567

# CRITICAL (Pitfall 1 — the keystone boot-crash guard): WORKDIR = packages/server so that the
# CMD's `tsx` discovers packages/server/tsconfig.json (experimentalDecorators +
# useDefineForClassFields:false). Run tsx from the repo root instead and it finds the root
# tsconfig, the @colyseus/schema @type() encoder mis-compiles, and the server crashes at the
# first full-state send — a runtime fault that `tsc --noEmit` never catches.
WORKDIR /app/packages/server
CMD ["pnpm", "start"]
