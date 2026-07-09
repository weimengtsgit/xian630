# syntax=docker/dockerfile:1
# agent-square: 智能体广场（React/Vite 前端 + nginx njs 提供 /api/apps 运行时接口）
#
# runtime 基镜像 localhost/nginx-njs:1.31 必须提供 ngx_http_js_module.so
# （源自工厂 nginx/1.31.2 镜像：本机标准 nginx:alpine 不带 njs，apk 也无法联网安装）。
# 部署脚本会先把工厂镜像 retag 成该基，详见 DEPLOYMENT.md。
FROM docker.m.daocloud.io/library/node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build

FROM localhost/nginx-njs:1.31
# 清掉基镜像自带前端与配置，覆盖为 agent-square 产物
RUN rm -rf /usr/share/nginx/html/* /etc/nginx/conf.d/default.conf /etc/nginx/ops-store-api.js
COPY --from=builder /app/dist/ /usr/share/nginx/html/
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY deploy/default.conf /etc/nginx/conf.d/default.conf
COPY deploy/ops-store-api.js /etc/nginx/ops-store-api.js
# 运行时应用数据目录（部署时由宿主机 bind-mount 持久化）
RUN mkdir -p /var/cache/nginx/appstore
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
