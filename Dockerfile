FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY tools/emulators/package.json tools/emulators/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm build && pnpm --filter @paysplit/api deploy --prod --legacy /out

FROM node:24-slim
ENV NODE_ENV=production WEB_DIST=/app/web MIGRATIONS_DIR=/app/drizzle
WORKDIR /app
COPY --from=build /out/node_modules node_modules
COPY --from=build /repo/apps/api/package.json ./
COPY --from=build /repo/apps/api/dist dist
COPY --from=build /repo/apps/api/drizzle drizzle
COPY --from=build /repo/apps/web/dist web
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["sh", "-c", "node dist/migrate.js && exec node --enable-source-maps dist/server.js"]
