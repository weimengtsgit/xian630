package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/server"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg := config.Resolve(nil)

	st, err := store.Open(cfg.DBPath)
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()

	sc := scanner.Scanner{Root: cfg.WorkspaceRoot}
	if err := server.New(cfg, st, sc).Start(ctx); err != nil {
		log.Fatal(err)
	}
}
