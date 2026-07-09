# syntax=docker/dockerfile:1
# interface-agent: Node.js + Express 原型生成服务
# Build context = interface-agent/
FROM docker.m.daocloud.io/library/node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY public/ ./public/
COPY skills/ ./skills/

ENV PORT=3000 HOST=0.0.0.0
EXPOSE 3000

CMD ["node", "src/server.js"]
