# syntax=docker/dockerfile:1
# One image per package: docker build -f deploy/docker/Dockerfile --build-arg PKG=worker .
# The runtime stage holds the package's dist/ and its production dependencies only.

FROM node:22-alpine AS base
RUN npm install -g pnpm@10.34.8 && npm cache clean --force
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --store-dir /pnpm/store

FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --store-dir /pnpm/store && pnpm -r build

FROM build AS deploy
ARG PKG
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter "@ryze/${PKG}" deploy --prod --legacy --store-dir /pnpm/store /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deploy --chown=node:node /out ./
COPY --chown=node:node db ./db
USER node
CMD ["node", "dist/main.js"]
