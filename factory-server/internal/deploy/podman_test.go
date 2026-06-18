package deploy

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// fakeRunner records every Run invocation and returns a configured result. It
// is the test double for OSRunner so podman.go can be unit-tested without a
// real container runtime on the host.
type fakeRunner struct {
	calls    []fakeCall
	results  []CommandResult // returned in order; index 0 first
	resultOf func(name string, args []string) CommandResult
	err      error // returned for every call when set
}

type fakeCall struct {
	dir  string
	name string
	args []string
}

func (f *fakeRunner) Run(_ context.Context, dir, name string, args ...string) (CommandResult, error) {
	f.calls = append(f.calls, fakeCall{dir: dir, name: name, args: append([]string(nil), args...)})
	if f.err != nil {
		return CommandResult{ExitCode: 1}, f.err
	}
	if f.resultOf != nil {
		return f.resultOf(name, args), nil
	}
	if len(f.results) > 0 {
		r := f.results[0]
		f.results = f.results[1:]
		return r, nil
	}
	return CommandResult{ExitCode: 0, Stdout: "ok"}, nil
}

func presetApp() model.Application {
	return model.Application{
		ID:     "app-east-sea-situation",
		Slug:   "east-sea-situation",
		Source: model.AppSourcePreset,
		Path:   "scene/east-sea-situation",
	}
}

func TestBuildImageCommand(t *testing.T) {
	fr := &fakeRunner{}
	p := NewPodman(fr)

	img, res, err := p.BuildImage(context.Background(), presetApp(), "preset")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0", res.ExitCode)
	}
	if len(fr.calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(fr.calls))
	}
	c := fr.calls[0]
	if c.name != "podman" {
		t.Errorf("name = %q, want podman", c.name)
	}
	wantArgs := []string{"build", "-t", "localhost/software-factory/east-sea-situation:preset", "."}
	if !equalStrings(c.args, wantArgs) {
		t.Errorf("args = %v, want %v", c.args, wantArgs)
	}
	if c.dir != "scene/east-sea-situation" {
		t.Errorf("dir = %q, want scene/east-sea-situation", c.dir)
	}
	if img.FullName != "localhost/software-factory/east-sea-situation:preset" {
		t.Errorf("image = %q", img.FullName)
	}
}

func TestRunContainerCommand(t *testing.T) {
	fr := &fakeRunner{}
	p := NewPodman(fr)

	// Force a deterministic suffix by intercepting the generated name from the
	// recorded argv. The suffix must be 8 hex chars per the spec.
	img := ImageRef{FullName: "localhost/software-factory/east-sea-situation:preset"}
	cr, res, err := p.RunContainer(context.Background(), img, "east-sea-situation", 18000, 80)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0", res.ExitCode)
	}
	if len(fr.calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(fr.calls))
	}
	c := fr.calls[0]
	if c.name != "podman" {
		t.Errorf("name = %q, want podman", c.name)
	}
	// argv shape: run -d --name sf-<slug>-<8hex> -p <host>:<container> <image>
	if len(c.args) != 7 {
		t.Fatalf("args len = %d (%v)", len(c.args), c.args)
	}
	if c.args[0] != "run" || c.args[1] != "-d" || c.args[2] != "--name" {
		t.Errorf("prefix args = %v", c.args[:3])
	}
	name := c.args[3]
	if !strings.HasPrefix(name, "sf-east-sea-situation-") {
		t.Errorf("container name = %q", name)
	}
	suffix := strings.TrimPrefix(name, "sf-east-sea-situation-")
	if len(suffix) != 8 {
		t.Errorf("suffix len = %d, want 8 (%q)", len(suffix), suffix)
	}
	for _, ch := range suffix {
		if !strings.ContainsRune("0123456789abcdef", ch) {
			t.Errorf("suffix %q has non-hex rune %q", suffix, ch)
		}
	}
	if c.args[4] != "-p" {
		t.Errorf("args[4] = %q, want -p", c.args[4])
	}
	if c.args[5] != "18000:80" {
		t.Errorf("port mapping = %q, want 18000:80", c.args[5])
	}
	if c.args[6] != img.FullName {
		t.Errorf("image arg = %q, want %q", c.args[6], img.FullName)
	}
	if c.dir != "" {
		t.Errorf("dir = %q, want empty", c.dir)
	}
	if cr.Name != name {
		t.Errorf("returned ref = %q, want %q", cr.Name, name)
	}
}

func TestRunContainerReturnsNameOnFailure(t *testing.T) {
	fr := &fakeRunner{results: []CommandResult{{ExitCode: 126, Stderr: "bind: address already in use"}}}
	p := NewPodman(fr)

	cr, _, err := p.RunContainer(context.Background(), ImageRef{FullName: "localhost/software-factory/demo:job"}, "demo", 18000, 80)
	if err == nil {
		t.Fatalf("err = nil, want podman run failure")
	}
	if cr.Name == "" {
		t.Fatalf("container name is empty; caller cannot clean up created container")
	}
	if !strings.HasPrefix(cr.Name, "sf-demo-") {
		t.Fatalf("container name = %q, want sf-demo-*", cr.Name)
	}
}

func TestStopContainerCommand(t *testing.T) {
	fr := &fakeRunner{}
	p := NewPodman(fr)

	if _, err := p.StopContainer(context.Background(), "sf-east-sea-situation-deadbeef"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(fr.calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(fr.calls))
	}
	c := fr.calls[0]
	want := []string{"stop", "sf-east-sea-situation-deadbeef"}
	if c.name != "podman" || !equalStrings(c.args, want) {
		t.Errorf("got %q %v, want podman %v", c.name, c.args, want)
	}
}

func TestRemoveContainerCommand(t *testing.T) {
	fr := &fakeRunner{}
	p := NewPodman(fr)

	if _, err := p.RemoveContainer(context.Background(), "sf-east-sea-situation-deadbeef"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(fr.calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(fr.calls))
	}
	c := fr.calls[0]
	want := []string{"rm", "sf-east-sea-situation-deadbeef"}
	if c.name != "podman" || !equalStrings(c.args, want) {
		t.Errorf("got %q %v, want podman %v", c.name, c.args, want)
	}
}

func TestNonZeroExitReturnsError(t *testing.T) {
	fr := &fakeRunner{results: []CommandResult{{ExitCode: 1, Stderr: "boom"}}}
	p := NewPodman(fr)

	_, _, err := p.BuildImage(context.Background(), presetApp(), "preset")
	if err == nil {
		t.Fatal("want error on non-zero exit, got nil")
	}
	if !errors.Is(err, ErrRunnerFailed) {
		t.Errorf("err = %v, want wraps ErrRunnerFailed", err)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
