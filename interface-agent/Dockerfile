# syntax=docker/dockerfile:1
# interface-agent: Node.js + Express 原型生成服务
# Build context = interface-agent/
FROM docker.m.daocloud.io/library/node:20-alpine

# better-sqlite3 ships a native addon; on Alpine it must be compiled against
# musl at install time. These build deps are needed only for `npm ci`.
# 先把 apk 源换成国内镜像（清华 tuna），避免国内构建访问 Alpine 官方源超时。
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apk/repositories \
    && apk add --no-cache python3 make g++

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
