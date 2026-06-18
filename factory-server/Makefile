BINARY := factory-server
PKG    := github.com/weimengtsgit/xian630/factory-server

.PHONY: test vet build fmt

test:
	go test ./...

vet:
	go vet ./...

build:
	go build -o bin/$(BINARY) ./cmd/factory-server

fmt:
	gofmt -w cmd internal
