FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/mcp-kit/package.json packages/mcp-kit/
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/provisioner/package.json apps/provisioner/
COPY mcp-servers/woo-mcp/package.json mcp-servers/woo-mcp/
COPY mcp-servers/kube-ops-mcp/package.json mcp-servers/kube-ops-mcp/
COPY mcp-servers/currency-mcp/package.json mcp-servers/currency-mcp/
COPY mcp-servers/evil-mcp/package.json mcp-servers/evil-mcp/
RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts
COPY apps/dashboard apps/dashboard
RUN pnpm --filter @mcp-portal/dashboard build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
