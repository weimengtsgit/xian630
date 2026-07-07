package runner

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// AuditDockerfile rejects a generated Dockerfile whose COPY reads a
// package-lock.json the factory never generates. The factory runs
// `npm install` inside the image (which creates the lockfile there), so a COPY
// source like `package-lock.json` or `package-lock.json*` matches nothing in
// the build context and fails BuildKit's COPY step.
//
// Catching this at code_generation (via finishCodeGeneration) keeps the
// failure inside the bounded-repair budget — product_acceptance would find the
// same bug but, running after code_review, often has no budget left to repair.
//
// Returns nil when the project has no Dockerfile (manifest validation owns that
// separately) and for stage-to-stage copies (--from=...), which do not read the
// build context.
func AuditDockerfile(projectDir string) error {
	path := filepath.Join(projectDir, "Dockerfile")
	f, err := os.Open(path)
	if err != nil {
		return nil // missing/unreadable Dockerfile is not this audit's concern
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	// A Dockerfile line is long-capped in practice by Docker (no unbounded
	// lines); the default 64K scanner buffer is ample.
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		trimmed := strings.TrimSpace(scanner.Text())
		upper := strings.ToUpper(trimmed)
		if upper != "COPY" && !strings.HasPrefix(upper, "COPY ") && !strings.HasPrefix(upper, "COPY\t") {
			continue
		}
		fields := strings.Fields(trimmed)
		if len(fields) < 2 {
			continue
		}
		// A stage-to-stage COPY (--from=...) does not read the build context,
		// so a package-lock.json there is not the host-context bug.
		stageCopy := false
		for _, tok := range fields[1:] {
			if strings.HasPrefix(tok, "--from=") {
				stageCopy = true
				break
			}
		}
		if stageCopy {
			continue
		}
		for _, tok := range fields[1:] {
			if strings.HasPrefix(tok, "--") { // flags like --chown, --chmod
				continue
			}
			base := filepath.Base(tok)
			if base == "package-lock.json" || strings.HasPrefix(base, "package-lock.json") {
				return fmt.Errorf("Dockerfile line %d: COPY references %q, but the factory never generates package-lock.json in the build context — RUN npm install creates it inside the image; use `COPY package.json ./`: %w", lineNo, tok, ErrSchemaValidationFailed)
			}
		}
	}
	return nil
}
