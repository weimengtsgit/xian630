# syntax=docker/dockerfile:1
# interface-agent: Node.js + Express 原型生成服务
# Build context = interface-agent/
FROM docker.m.daocloud.io/library/node:20-alpine

# better-sqlite3 ships a native addon; on Alpine it must be compiled against
# musl at install time. These build deps are needed only for `npm ci`.
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY public/ ./public/
COPY skills/ ./skills/

# 持久化 SQLite：界面稿版本数据落在此卷，替换容器不丢库。
# 运行时挂载：-v /var/lib/interface-agent:/var/lib/interface-agent
ENV PORT=3000 HOST=0.0.0.0 \
    INTERFACE_AGENT_DB_PATH=/var/lib/interface-agent/interface-agent.db
VOLUME ["/var/lib/interface-agent"]

EXPOSE 3000

CMD ["node", "src/server.js"]
