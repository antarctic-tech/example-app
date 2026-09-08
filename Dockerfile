# Один контейнер: статика мини-апки + ваш бэкенд на одном origin.
# /api/* и фронт с одного хоста — так проще в iframe кошелька.
#
# Сборка (из корня репозитория):
#   docker build --build-arg FRAMEWORK=vue     -t mini-app .
#   docker build --build-arg FRAMEWORK=react   -t mini-app .
#   docker build --build-arg FRAMEWORK=angular -t mini-app .
#
# Запуск (секреты только в env, не в образ; .env в образ не копируется):
#   docker run --rm -p 8080:8080 \
#     -e AW_API_BASE=https://… \
#     -e AW_APP_ID=ваш-app-id \
#     -e AW_API_SECRET=… \
#     mini-app
# App URL в AW: http://127.0.0.1:8080 (не localhost). HTTPS-кошелёк → TLS спереди.
#
# FRAMEWORK: vue | react | angular  (по умолчанию vue)

ARG FRAMEWORK=vue

FROM node:20-bookworm-slim AS frontend
ARG FRAMEWORK
WORKDIR /src

RUN case "$FRAMEWORK" in \
  vue|react|angular) ;; \
  *) echo "FRAMEWORK must be vue, react or angular (got: $FRAMEWORK)" >&2; exit 1 ;; \
  esac

COPY examples/${FRAMEWORK}/package.json examples/${FRAMEWORK}/package-lock.json ./
RUN npm ci --include=dev
COPY examples/${FRAMEWORK}/ ./
RUN npm run build \
  && mkdir -p /out \
  && if [ -f dist/browser/index.html ]; then cp -R dist/browser/. /out/; \
  elif [ -f dist/index.html ]; then cp -R dist/. /out/; \
  else echo "Build output not found (expected dist/index.html or dist/browser/index.html)" >&2; ls -la dist || true; exit 1; \
  fi

FROM node:20-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY examples/backend-node/package.json examples/backend-node/package-lock.json ./
RUN npm ci --omit=dev
COPY examples/backend-node/ ./
COPY --from=frontend /out ./public

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=6 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

CMD ["node", "server.mjs"]
