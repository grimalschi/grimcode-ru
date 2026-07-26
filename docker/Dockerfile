# syntax=docker/dockerfile:1

# One service-targeted Dockerfile for every Node service of the template.
#
# It is built once per service with `--build-arg SERVICE=<name>`, and each build produces its own
# production image containing only that service's dependency closure. Build stages and cache are
# shared, but the runtime image is not: a single common runtime image would copy the whole
# monorepo and every neighbouring build into every container, inflate the images and tie their
# updates together.

ARG NODE_IMAGE=node:22-alpine

# --- Dependencies -------------------------------------------------------------
# Only the manifests are copied first, so the install layer is reused whenever sources change.
FROM ${NODE_IMAGE} AS deps
ARG SERVICE
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json turbo.json ./
COPY contracts/package.json ./contracts/package.json
COPY shared/package.json ./shared/package.json
COPY services/${SERVICE}/package.json ./services/${SERVICE}/package.json

# The frozen lockfile is the repository's single lockfile; services never carry their own.
RUN pnpm install --frozen-lockfile --filter @template/${SERVICE}...

# --- Build --------------------------------------------------------------------
FROM deps AS build
ARG SERVICE

COPY contracts ./contracts
COPY shared ./shared
COPY services/${SERVICE} ./services/${SERVICE}

# Builds the service and only the workspace packages it actually depends on.
RUN pnpm --filter @template/${SERVICE}... build

# Produces a self-contained directory with production dependencies only.
RUN pnpm --filter @template/${SERVICE} deploy --prod /out/app

# --- Runtime ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG SERVICE
WORKDIR /app

ENV NODE_ENV=production
ENV TEMPLATE_SERVICE=${SERVICE}

COPY --from=build --chown=node:node /out/app ./

USER node

# Ports are fixed in the image; nothing outside Gateway is published anyway.
# Site is server-rendered and starts from its framework's own entry; every other service starts
# from its compiled dist/index.js.
CMD ["sh", "-c", "if [ -f server/index.mjs ]; then exec node server/index.mjs; else exec node dist/index.js; fi"]
