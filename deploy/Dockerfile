FROM node:22.12-alpine AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.12-alpine AS runtime
ENV HOST=0.0.0.0 NODE_ENV=production PORT=4173
RUN addgroup -S synode && adduser -S -G synode synode
WORKDIR /app
COPY --from=build --chown=synode:synode /workspace/dist ./dist
COPY --from=build --chown=synode:synode /workspace/node_modules ./node_modules
COPY --from=build --chown=synode:synode /workspace/package.json ./package.json
COPY --chown=synode:synode docs ./docs
USER synode
EXPOSE 4173
CMD ["node", "dist/server.js"]
