BINARY   := cc-status
PKG      := github.com/weimengtsgit/xian630/cc-status
BIN_DIR  := bin
VERSION  := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS  := -X main.version=$(VERSION)

GOFLAGS  := -trimpath

.PHONY: all build run serve test vet tidy fmt clean install-local

all: build

## build: compile the binary into ./bin/$(BINARY)
build:
	@mkdir -p $(BIN_DIR)
	go build $(GOFLAGS) -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(BINARY) ./cmd/$(BINARY)

## run: build then run the server (foreground)
run: build
	./$(BIN_DIR)/$(BINARY) serve

## serve: run server via go run (no build step)
serve:
	go run ./cmd/$(BINARY) serve

## test: run unit tests for our packages only (skip siblings)
test:
	go test ./cmd/... ./internal/...

## vet: go vet our packages
vet:
	go vet ./cmd/... ./internal/...

## fmt: format
fmt:
	gofmt -s -w cmd internal

## tidy: go mod tidy
tidy:
	go mod tidy

## clean: remove build artifacts
clean:
	rm -rf $(BIN_DIR) $(DIST_DIR)

## install-local: build then install to GOBIN
install-local: build
	@cp $(BIN_DIR)/$(BINARY) "$$(go env GOPATH)/bin/$(BINARY)" 2>/dev/null || \
	 cp $(BIN_DIR)/$(BINARY) "$$(go env GOROOT)/bin/$(BINARY)"
