# Static-hosting image: dist/ was built on the host by test_verification.
# The container runtime cannot reach npm registries, so there is NO
# in-container node build — nginx serves the pre-built static assets.
FROM nginx:alpine
COPY dist/ /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
