package skills

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadSkillName(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "SKILL.md")
	if err := os.WriteFile(p, []byte("---\nname: tdd\ndescription: x\n---\nbody"), 0o644); err != nil {
		t.Fatal(err)
	}
	name, ok := readSkillName(p)
	if !ok || name != "tdd" {
		t.Fatalf("got %q ok=%v", name, ok)
	}
}

func TestReadSkillNameNoFrontmatter(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "SKILL.md")
	os.WriteFile(p, []byte("just a body"), 0o644)
	if _, ok := readSkillName(p); ok {
		t.Fatal("expected no name without frontmatter")
	}
}

func TestScannerMatchSlash(t *testing.T) {
	dir := t.TempDir()
	skill := filepath.Join(dir, "tdd", "SKILL.md")
	os.MkdirAll(filepath.Dir(skill), 0o755)
	os.WriteFile(skill, []byte("---\nname: tdd\n---\n"), 0o644)

	sc := New("", dir)
	sc.Refresh()

	if !sc.IsKnown("tdd") {
		t.Fatalf("known skills: %v", sc.Known())
	}
	if name, ok := sc.MatchSlash("/tdd do something"); !ok || name != "tdd" {
		t.Fatalf("MatchSlash(/tdd ...) = %q ok=%v", name, ok)
	}
	if _, ok := sc.MatchSlash("hello world"); ok {
		t.Fatal("non-slash prompt matched")
	}
	if _, ok := sc.MatchSlash("/clear"); ok {
		t.Fatal("unknown slash matched as skill")
	}
	// plugin-qualified form
	if name, ok := sc.MatchSlash("/myplugin:tdd"); !ok || name != "tdd" {
		t.Fatalf("MatchSlash(/myplugin:tdd) = %q ok=%v", name, ok)
	}
}
