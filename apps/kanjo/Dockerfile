# ── Etapa 1: compilar ──────────────────────────────
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── Etapa 2: imagen final ──────────────────────────
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["npm", "start"]