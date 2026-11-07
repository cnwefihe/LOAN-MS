# Loan Management System: production image. On one server, use docker-compose.yml (docs/DEPLOY_PROXMOX.md).
# Build:  docker build -t loan-management-system .
# Run:    docker run -p 3000:3000 --env-file prod.env loan-management-system
# Migrations run as a separate step:  docker run --rm --env-file prod.env loan-management-system node scripts/migrate.cjs

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build \
 && npx esbuild scripts/migrate.ts --bundle --platform=node --format=cjs --outfile=dist/migrate.cjs --external:pg-native --external:@electric-sql/pglite \
 && npx esbuild scripts/seed.ts --bundle --platform=node --format=cjs --outfile=dist/seed.cjs --external:pg-native --external:@electric-sql/pglite

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
# The migration and seed scripts carry their own libraries: the server bundle does not include them.
COPY --from=build /app/dist/migrate.cjs ./scripts/migrate.cjs
COPY --from=build /app/dist/seed.cjs ./scripts/seed.cjs
RUN mkdir -p /app/storage && chown -R app:app /app/storage
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=6s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
