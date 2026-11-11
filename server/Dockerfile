# ---------- 第一阶段：编译 ----------
FROM node:24-bookworm-slim AS build
WORKDIR /app

# 先只复制依赖清单，这样代码改动时不用重新安装依赖
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build            # TypeScript 编译到 dist/
RUN npm prune --omit=dev     # 去掉开发依赖

# ---------- 第二阶段：运行 ----------
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# package.json 里的 "type": "module" 决定了 dist 下的 .js 按 ESM 加载，运行时必须带上
COPY package.json ./

# 不用 root 运行
USER node

EXPOSE 8080 8081
# 默认启动 API + 信令；中继在 compose 里覆盖为 node dist/main-relay.js，迁移覆盖为 node dist/migrate.js
CMD ["node", "dist/main-signal.js"]
