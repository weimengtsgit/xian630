# syntax=docker/dockerfile:1
# agent-pipeline: 智能体流水线展示页面（React/Vite 前端 + Express 后端）
# Build context = agent-pipeline/
FROM docker.m.daocloud.io/library/node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM docker.m.daocloud.io/library/node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server/ ./server/
COPY src/ ./src/
COPY index.html vite.config.js ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server/index.js"]
