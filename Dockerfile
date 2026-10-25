# syntax=docker/dockerfile:1
# Shared service build: docker build --build-arg PKG=worker .
FROM node:22-alpine AS build
RUN npm install -g pnpm@10.34.8 && npm cache clean --force
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --store-dir /pnpm/store
COPY . .
ARG PKG
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --store-dir /pnpm/store \
    && pnpm --filter "@ryze/${PKG}..." build \
    && pnpm --filter "@ryze/${PKG}" deploy --prod --legacy --store-dir /pnpm/store /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
CMD ["node", "dist/main.js"]
