# One Dockerfile for the gateway and every Node MCP server.
#   docker build -f docker/node.Dockerfile --build-arg WORKSPACE=mcp-servers/kube-ops-mcp -t mcp-portal-kube-ops-mcp .
# WORKSPACE is the package to build and run; ENTRY is its compiled entry point (dist/index.js for servers, dist/main.js for the gateway).
ARG WORKSPACE=apps/gateway
ARG ENTRY=dist/index.js

FROM node:22-alpine AS build
ARG WORKSPACE

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
COPY apps/gateway apps/gateway
COPY apps/provisioner apps/provisioner
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY mcp-servers mcp-servers

# The gateway's tests and the dev stack import the servers, so they all build; only the requested workspace is run.
RUN pnpm --filter "./packages/mcp-kit" build \
    && pnpm --filter "./${WORKSPACE}" build

FROM node:22-alpine AS runtime
ARG WORKSPACE
ARG ENTRY

ENV NODE_ENV=production
WORKDIR /repo

RUN addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /repo /repo

# Shell-form CMD below reads these; the numeric USER lets the chart's runAsNonRoot check pass.
ENV WORKSPACE=${WORKSPACE}
ENV ENTRY=${ENTRY}

USER 10001

EXPOSE 8080

CMD ["sh", "-c", "exec node \"$WORKSPACE/$ENTRY\""]
