# PageAtlas capture server for hosting, such as Render. Serves the web app and runs captures in Chromium.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PAGEATLAS_HOSTED=1 \
    PAGEATLAS_CHROMIUM_SANDBOX=0
WORKDIR /app
COPY package.json package-lock.json ./
# Install the Chromium build that matches playwright-core, with its system libraries.
RUN npm ci --omit=dev \
 && npx playwright-core install --with-deps chromium \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
USER node
EXPOSE 10000
CMD ["node", "server/index.ts"]
