# Prebuilt-dist image: dist/ is built on the dev host (avoids in-container npm
# under the prod host's broken proxy). Build context = this scene dir.
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist/ /usr/share/nginx/html/
EXPOSE 80
