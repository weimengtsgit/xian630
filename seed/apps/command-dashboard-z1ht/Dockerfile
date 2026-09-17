# 构建阶段：Node 构建 Vite 静态产物
FROM node:20-alpine AS build
WORKDIR /app

# 工厂不随包提供 package-lock.json，必须用 npm install（禁止 npm ci）
COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

# 运行阶段：nginx 托管静态产物并承担同源反向代理
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
