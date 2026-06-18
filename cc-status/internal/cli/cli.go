// Package cli implements the cc-status subcommands: serve, hook, install,
// uninstall, version.
package cli

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/weimengtsgit/xian630/cc-status/internal/config"
	"github.com/weimengtsgit/xian630/cc-status/internal/hook"
	"github.com/weimengtsgit/xian630/cc-status/internal/ingest"
	"github.com/weimengtsgit/xian630/cc-status/internal/install"
	"github.com/weimengtsgit/xian630/cc-status/internal/server"
	"github.com/weimengtsgit/xian630/cc-status/internal/skills"
	"github.com/weimengtsgit/xian630/cc-status/internal/store"
)

// buildVersion is set by Run from main's version string.
var buildVersion = "dev"

// Run dispatches a subcommand. It returns the process exit code.
func Run(args []string, version string) int {
	buildVersion = version
	if len(args) == 0 {
		usage()
		return 0
	}
	switch args[0] {
	case "serve":
		return runServe(args[1:])
	case "hook":
		return runHook(args[1:])
	case "install":
		return runInstall(args[1:])
	case "uninstall":
		return runUninstall(args[1:])
	case "version", "-v", "--version":
		fmt.Println(buildVersion)
		return 0
	case "help", "-h", "--help":
		usage()
		return 0
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", args[0])
		usage()
		return 2
	}
}

func usage() {
	fmt.Print(`cc-status — query Claude Code's running agents, subagents and skills

Usage:
  cc-status serve [--addr HOST:PORT] [--db PATH]
  cc-status hook                       (reads a hook payload from stdin)
  cc-status install [--project] [--no-daemon]
  cc-status uninstall [--project]
  cc-status version

serve     Run the HTTP API + SSE server (foreground).
hook      Parse one Claude Code hook payload from stdin and forward it to the
          server. Registered as the settings.json hook command.
install   Inject observational hooks into ~/.claude/settings.json (user scope,
          or --project for .claude/settings.json) and start a keep-alive daemon.
uninstall Reverse both.
`)
}

func runServe(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", "", "listen address (default 127.0.0.1:8765, env CC_STATUS_ADDR)")
	db := fs.String("db", "", "SQLite database path (env CC_STATUS_DBPATH)")
	fs.Parse(args)

	cfg := config.Load()
	if *addr != "" {
		cfg.Addr = *addr
	}
	if *db != "" {
		cfg.DBPath = *db
	}

	st, err := store.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.Close()

	sc := skills.New("")
	ig := &ingest.Ingest{Store: st, Skills: sc}
	srv := server.New(cfg, st, ig, sc)
	srv.Version = buildVersion

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := srv.Start(ctx); err != nil {
		log.Fatalf("server: %v", err)
	}
	return 0
}

func runHook(_ []string) int {
	// Observational contract: always exit 0, never write stdout.
	e, err := hook.Parse(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cc-status hook: parse: %v\n", err)
		return 0
	}
	cfg := config.Load()
	_ = hook.Report(cfg.ServerURL(), cfg.IngestPath, e)
	return 0
}

func runInstall(args []string) int {
	fs := flag.NewFlagSet("install", flag.ExitOnError)
	project := fs.Bool("project", false, "install into project .claude/settings.json")
	noDaemon := fs.Bool("no-daemon", false, "skip the keep-alive daemon")
	fs.Parse(args)

	binaryPath, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "resolve binary: %v\n", err)
		return 1
	}
	if resolved, err := filepath.EvalSymlinks(binaryPath); err == nil {
		binaryPath = resolved
	}

	path, _ := install.SettingsPath(*project)
	settings, err := install.LoadSettings(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load settings: %v\n", err)
		return 1
	}
	if install.InstallHooks(settings, binaryPath) {
		if err := install.SaveSettings(path, settings); err != nil {
			fmt.Fprintf(os.Stderr, "save settings: %v\n", err)
			return 1
		}
		fmt.Printf("hooks written to %s\n", path)
	} else {
		fmt.Printf("hooks already present in %s\n", path)
	}

	if !*noDaemon {
		if err := install.InstallDaemon(binaryPath); err != nil {
			fmt.Fprintf(os.Stderr, "warning: daemon install failed: %v\n", err)
		} else {
			_, lab := install.DaemonPaths()
			fmt.Printf("daemon started (%s)\n", lab)
		}
	}
	fmt.Println("\nRestart any open Claude Code sessions for the hooks to take effect.")
	return 0
}

func runUninstall(args []string) int {
	fs := flag.NewFlagSet("uninstall", flag.ExitOnError)
	project := fs.Bool("project", false, "uninstall from project .claude/settings.json")
	fs.Parse(args)

	binaryPath, _ := os.Executable()
	if resolved, err := filepath.EvalSymlinks(binaryPath); err == nil {
		binaryPath = resolved
	}

	if err := install.UninstallDaemon(); err != nil {
		fmt.Fprintf(os.Stderr, "warning: daemon uninstall: %v\n", err)
	} else {
		fmt.Println("daemon removed")
	}

	path, _ := install.SettingsPath(*project)
	settings, err := install.LoadSettings(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load settings: %v\n", err)
		return 1
	}
	if install.UninstallHooks(settings, binaryPath) {
		if err := install.SaveSettings(path, settings); err != nil {
			fmt.Fprintf(os.Stderr, "save settings: %v\n", err)
			return 1
		}
		fmt.Printf("hooks removed from %s\n", path)
	} else {
		fmt.Printf("no cc-status hooks found in %s\n", path)
	}
	return 0
}
