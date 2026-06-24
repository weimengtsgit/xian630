package deploy

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestDockerBuildImageCommand(t *testing.T) {
	fr := &fakeRunner{}
	d := NewDocker(fr)

	img, res, err := d.BuildImage(context.Background(), presetApp(), "preset")
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
	if c.name != "docker" {
		t.Errorf("name = %q, want docker", c.name)
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

func TestDockerRunContainerCommand(t *testing.T) {
	fr := &fakeRunner{}
	d := NewDocker(fr)

	img := ImageRef{FullName: "localhost/software-factory/east-sea-situation:preset"}
	cr, res, err := d.RunContainer(context.Background(), img, "east-sea-situation", 18000, 80)
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
	if c.name != "docker" {
		t.Errorf("name = %q, want docker", c.name)
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

func TestDockerRunContainerReturnsNameOnFailure(t *testing.T) {
	fr := &fakeRunner{results: []CommandResult{{ExitCode: 126, Stderr: "bind: address already in use"}}}
	d := NewDocker(fr)

	cr, _, err := d.RunContainer(context.Background(), ImageRef{FullName: "localhost/software-factory/demo:job"}, "demo", 18000, 80)
	if err == nil {
		t.Fatalf("err = nil, want docker run failure")
	}
	if cr.Name == "" {
		t.Fatalf("container name is empty; caller cannot clean up created container")
	}
	if !strings.HasPrefix(cr.Name, "sf-demo-") {
		t.Fatalf("container name = %q, want sf-demo-*", cr.Name)
	}
}

func TestDockerStopContainerCommand(t *testing.T) {
	fr := &fakeRunner{}
	d := NewDocker(fr)

	if _, err := d.StopContainer(context.Background(), "sf-east-sea-situation-deadbeef"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(fr.calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(fr.calls))
	}
	c := fr.calls[0]
	want := []string{"stop", "sf-east-sea-situation-deadbeef"}
	if c.name != "docker" || !equalStrings(c.args, want) {
		t.Errorf("got %q %v, want docker %v", c.name, c.args, want)
	}
}

func TestDockerRemoveContainerCommand(t *testing.T) {
	fr := &fakeRunner{}
	d := NewDocker(fr)

	if _, err := d.RemoveContainer(context.Background(), "sf-east-sea-situation-deadbeef"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(fr.calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(fr.calls))
	}
	c := fr.calls[0]
	want := []string{"rm", "sf-east-sea-situation-deadbeef"}
	if c.name != "docker" || !equalStrings(c.args, want) {
		t.Errorf("got %q %v, want docker %v", c.name, c.args, want)
	}
}

func TestDockerNonZeroExitReturnsError(t *testing.T) {
	fr := &fakeRunner{results: []CommandResult{{ExitCode: 1, Stderr: "boom"}}}
	d := NewDocker(fr)

	_, _, err := d.BuildImage(context.Background(), presetApp(), "preset")
	if err == nil {
		t.Fatal("want error on non-zero exit, got nil")
	}
	if !errors.Is(err, ErrRunnerFailed) {
		t.Errorf("err = %v, want wraps ErrRunnerFailed", err)
	}
}
