# The store provisioner: a small Node service that runs `helm` against charts/mcp-store, which is baked into the image.
#   docker build -f docker/provisioner.Dockerfile -t mcp-portal-provisioner:dev .
# Upgrading the per-store chart therefore means building a new image, so a store's chart version is always the one reviewed with it.
ARG HELM_VERSION=3.17.3

FROM alpine/helm:${HELM_VERSION} AS helm

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/mcp-kit/package.json packages/mcp-kit/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/provisioner/package.json apps/provisioner/package.json
COPY mcp-servers/woo-mcp/package.json mcp-servers/woo-mcp/package.json
COPY mcp-servers/kube-ops-mcp/package.json mcp-servers/kube-ops-mcp/package.json
COPY mcp-servers/currency-mcp/package.json mcp-servers/currency-mcp/package.json
COPY mcp-servers/evil-mcp/package.json mcp-servers/evil-mcp/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY packages packages
COPY apps/provisioner apps/provisioner
RUN pnpm --filter "./packages/mcp-kit" build && pnpm --filter "./apps/provisioner" build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=helm /usr/bin/helm /usr/local/bin/helm
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages/mcp-kit /repo/packages/mcp-kit
COPY --from=build /repo/apps/provisioner /repo/apps/provisioner
# The per-store chart. Read-only for the service (it writes only to /tmp).
COPY charts/mcp-store /charts/mcp-store

USER 10001
EXPOSE 8080
CMD ["node", "apps/provisioner/dist/index.js"]
