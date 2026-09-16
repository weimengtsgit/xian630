# mmfix-proxy: Anthropic /v1/messages 请求修正代理（见 main.go 注释）。
# 构建上下文 = deploy/mmfix-proxy/
FROM docker.m.daocloud.io/library/golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/mmfix-proxy .

FROM docker.m.daocloud.io/library/alpine:3.22
COPY --from=build /out/mmfix-proxy /usr/local/bin/mmfix-proxy
ENV LISTEN=:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/mmfix-proxy"]
