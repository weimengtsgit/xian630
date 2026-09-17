# 构建阶段：Node 环境 npm install + vite build（工厂不提供 package-lock.json，必须用 npm install）
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

# 运行阶段：nginx 托管静态产物并承担外部公开数据 API 的同源反向代理
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
