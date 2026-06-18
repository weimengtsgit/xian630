// Package skills discovers installed Claude Code skill names from the filesystem
// so the UserPromptSubmit heuristic can recognize slash-command skill
// invocations (e.g. "/tdd") and distinguish them from built-in slash commands.
package skills

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Scanner holds a refreshable set of known skill names.
type Scanner struct {
	mu    sync.RWMutex
	names map[string]struct{}
	roots []string
}

// New returns a Scanner rooted at the user's ~/.claude (skills + plugin skills).
// Project-level .claude/skills under extraRoots are also scanned.
func New(home string, extraRoots ...string) *Scanner {
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	roots := []string{
		filepath.Join(home, ".claude", "skills"),
		filepath.Join(home, ".claude", "plugins"),
	}
	roots = append(roots, extraRoots...)
	return &Scanner{names: map[string]struct{}{}, roots: roots}
}

// Roots returns the configured scan roots (for diagnostics).
func (s *Scanner) Roots() []string { return s.roots }

// Refresh rescans the filesystem and rebuilds the known-name set.
func (s *Scanner) Refresh() {
	next := map[string]struct{}{}
	for _, root := range s.roots {
		s.scanInto(root, next)
	}
	s.mu.Lock()
	s.names = next
	s.mu.Unlock()
}

// scanInto walks root looking for SKILL.md files and records the frontmatter
// name. Under a "skills" directory, each direct child dir is a skill; under
// "plugins", skill dirs may be nested deeper.
func (s *Scanner) scanInto(root string, out map[string]struct{}) {
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			// Skip noisy directories.
			name := d.Name()
			if name == "node_modules" || name == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Name() != "SKILL.md" {
			return nil
		}
		if name, ok := readSkillName(path); ok && name != "" {
			out[name] = struct{}{}
		}
		return nil
	})
}

// Known returns a copy of the known skill names.
func (s *Scanner) Known() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.names))
	for k := range s.names {
		out = append(out, k)
	}
	return out
}

// IsKnown reports whether name is a registered skill.
func (s *Scanner) IsKnown(name string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.names[name]
	return ok
}

// MatchSlash inspects a user prompt and, if its first token is a slash command
// referencing a known skill (e.g. "/tdd", "/plugin:tdd"), returns the skill
// name. The boolean is false for built-in/unknown slash commands or non-slash
// prompts.
func (s *Scanner) MatchSlash(prompt string) (string, bool) {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" || !strings.HasPrefix(prompt, "/") {
		return "", false
	}
	// First token after the slash.
	rest := strings.TrimLeft(prompt, "/")
	tok := rest
	for _, sep := range []string{" ", "\t", "\n", "\r"} {
		if i := strings.Index(tok, sep); i >= 0 {
			tok = tok[:i]
		}
	}
	if tok == "" {
		return "", false
	}
	// Allow "plugin:skill" form; match both qualified and bare name.
	if s.IsKnown(tok) {
		return tok, true
	}
	if i := strings.LastIndex(tok, ":"); i >= 0 {
		bare := tok[i+1:]
		if s.IsKnown(bare) {
			return bare, true
		}
	}
	return "", false
}

// readSkillName extracts the `name:` field from a SKILL.md YAML frontmatter
// block without a YAML dependency.
func readSkillName(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	text := string(data)
	if !strings.HasPrefix(text, "---") {
		return "", false
	}
	// Find the closing frontmatter fence.
	rest := text[3:]
	if strings.HasPrefix(rest, "\r\n") {
		rest = rest[2:]
	} else if strings.HasPrefix(rest, "\n") {
		rest = rest[1:]
	}
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return "", false
	}
	fm := rest[:end]
	for _, line := range strings.Split(fm, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "name:") {
			val := strings.TrimSpace(strings.TrimPrefix(line, "name:"))
			val = strings.Trim(val, "\"'")
			return val, val != ""
		}
	}
	return "", false
}
