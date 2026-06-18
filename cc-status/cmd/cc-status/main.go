// Command cc-status provides an HTTP API to query the status and details of
// Claude Code's running agents, subagents and skills.
//
// It observes Claude Code via hooks (see `cc-status install`) and exposes the
// collected state as REST resources plus a live Server-Sent Events stream.
package main

import (
	"os"

	"github.com/weimengtsgit/xian630/cc-status/internal/cli"
)

// version is overridable at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	os.Exit(cli.Run(os.Args[1:], version))
}
