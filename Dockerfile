FROM node:22-alpine AS web-build
WORKDIR /build
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci --ignore-scripts --no-audit --no-fund
COPY web ./web
RUN npm --prefix web run build

FROM node:22-alpine
WORKDIR /app
COPY package.json config.json proxy.mjs ./
COPY web/admin.mjs ./web/admin.mjs
COPY web/request-log.mjs ./web/request-log.mjs
COPY web/request-log-store.mjs ./web/request-log-store.mjs
COPY web/update-check.mjs ./web/update-check.mjs
COPY tools ./tools
COPY --from=web-build /build/web/dist ./web/dist
EXPOSE 3050
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --spider http://127.0.0.1:3050/health || exit 1
CMD ["node", "proxy.mjs"]
