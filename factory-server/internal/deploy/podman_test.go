package deploy

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestHelperProcessRunStream(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	switch os.Getenv("GO_HELPER_STREAM_MODE") {
	case "success":
		os.Stdout.WriteString("out1\nout2\n")
		os.Stderr.WriteString("err1\nerr2\n")
		os.Exit(0)
	case "failure":
		os.Stderr.WriteString("failing\n")
		os.Exit(3)
	default:
		os.Exit(2)
	}
}

func runStreamHelperCommand(mode string) (string, []string) {
	return os.Args[0], []string{
		"-test.run=TestHelperProcessRunStream",
		"--",
	}
}

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

// TestRunStreamWithInputForwardsStdoutAndStderr verifies the streaming command
// runner invokes the stdout and stderr callbacks for each line and still
// returns the tail-capped full output. It uses a tiny shell script so it runs
// without a real podman.
func TestRunStreamWithInputForwardsStdoutAndStderr(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns a subprocess")
	}
	var stdoutLines, stderrLines []string
	var mu sync.Mutex
	os := OSRunner{}
	shell, shellArgs := testShell(`echo out1 && echo out2 && echo err1 1>&2 && echo err2 1>&2`)
	// A portable shell one-liner: print two stdout lines + two stderr lines.
	res, err := os.RunStreamWithInput(
		context.Background(), "", "",
		func(line string) {
			mu.Lock()
			defer mu.Unlock()
			stdoutLines = append(stdoutLines, line)
		},
		func(line string) {
			mu.Lock()
			defer mu.Unlock()
			stderrLines = append(stderrLines, line)
		},
		shell, shellArgs...,
	)
	if err != nil {
		t.Fatalf("RunStreamWithInput: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d, want 0", res.ExitCode)
	}
	mu.Lock()
	defer mu.Unlock()
	if !containsTrimmed(stdoutLines, "out1") || !containsTrimmed(stdoutLines, "out2") {
		t.Errorf("stdout callbacks = %v, want out1+out2", stdoutLines)
	}
	if !containsTrimmed(stderrLines, "err1") || !containsTrimmed(stderrLines, "err2") {
		t.Errorf("stderr callbacks = %v, want err1+err2", stderrLines)
	}
	if !strings.Contains(res.Stdout, "out1") {
		t.Errorf("res.Stdout = %q, missing out1", res.Stdout)
	}
	if !strings.Contains(res.Stderr, "err1") {
		t.Errorf("res.Stderr = %q, missing err1", res.Stderr)
	}
}

// TestRunStreamWithInputReturnsOutputOnNonZeroExit verifies the streaming runner
// still returns captured stdout/stderr and a non-zero exit code when the command
// fails — the factory steps rely on this to write the capped artifact even on a
// failed npm/podman run.
func TestRunStreamWithInputReturnsOutputOnNonZeroExit(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns a subprocess")
	}
	var stderrLines []string
	os := OSRunner{}
	shell, shellArgs := testShell("echo failing 1>&2 && exit 3")
	res, err := os.RunStreamWithInput(
		context.Background(), "", "",
		func(line string) {},
		func(line string) { stderrLines = append(stderrLines, line) },
		shell, shellArgs...,
	)
	if err != nil {
		t.Fatalf("RunStreamWithInput err = %v, want nil (non-zero exit reported via ExitCode)", err)
	}
	if res.ExitCode != 3 {
		t.Fatalf("exit = %d, want 3", res.ExitCode)
	}
	if !strings.Contains(res.Stderr, "failing") {
		t.Errorf("res.Stderr = %q, missing 'failing'", res.Stderr)
	}
	if !containsTrimmed(stderrLines, "failing") {
		t.Errorf("stderr callback = %v, want 'failing' forwarded", stderrLines)
	}
}

func contains(s []string, want string) bool {
	for _, v := range s {
		if v == want {
			return true
		}
	}
	return false
}

func containsTrimmed(s []string, want string) bool {
	for _, v := range s {
		if strings.TrimSpace(v) == want {
			return true
		}
	}
	return false
}

// TestStreamTailBufferTracksTruncation is the F7 unit test for the truncation
// flag: once the cap is exceeded the buffer latches truncated=true and keeps the
// newest maxStreamTailBytes; content under the cap reports truncated=false.
func TestStreamTailBufferTracksTruncation(t *testing.T) {
	t.Run("under cap not truncated", func(t *testing.T) {
		b := newStreamTailBuffer()
		_, _ = b.Write([]byte("small payload"))
		if b.Truncated() {
			t.Fatalf("Truncated=true for under-cap write")
		}
		if b.String() != "small payload" {
			t.Fatalf("String = %q, want verbatim", b.String())
		}
	})

	t.Run("over cap latches truncated and keeps tail", func(t *testing.T) {
		b := newStreamTailBuffer()
		// Write >cap in one go: head discarded, tail kept, truncated latched.
		big := make([]byte, maxStreamTailBytes+2048)
		for i := range big {
			big[i] = 'x'
		}
		// Stamp the very last bytes so we can confirm the tail is retained.
		copy(big[len(big)-len("TAIL"):], "TAIL")
		_, _ = b.Write(big)
		if !b.Truncated() {
			t.Fatalf("Truncated=false after over-cap write")
		}
		s := b.String()
		if len(s) != maxStreamTailBytes {
			t.Fatalf("retained len = %d, want %d", len(s), maxStreamTailBytes)
		}
		if !strings.HasSuffix(s, "TAIL") {
			t.Fatalf("retained tail missing newest bytes: ...%q", s[len(s)-8:])
		}
	})

	t.Run("truncation stays latched across further writes", func(t *testing.T) {
		b := newStreamTailBuffer()
		big := make([]byte, maxStreamTailBytes+1)
		_, _ = b.Write(big)
		if !b.Truncated() {
			t.Fatalf("expected truncated after first over-cap write")
		}
		_, _ = b.Write([]byte("more"))
		if !b.Truncated() {
			t.Fatalf("truncated flag de-latched after further write")
		}
	})
}

// TestHintIfMissingBinaryAugmentsNotFoundError: when the container engine
// binary is absent the raw exec error gives no clue that
// FACTORY_CONTAINER_RUNTIME switches backends. The hint must wrap the original
// error (so errors.Is(ErrRunnerFailed) holds) and mention both the env var and
// the missing binary. A nil error and an unrelated error pass through untouched.
func TestHintIfMissingBinaryAugmentsNotFoundError(t *testing.T) {
	// The exact error os/exec produces when a binary is missing.
	notFound := &exec.Error{Name: "podman", Err: exec.ErrNotFound}

	hinted := hintIfMissingBinary("podman", notFound)
	if !errors.Is(hinted, ErrRunnerFailed) {
		t.Fatalf("hinted err does not wrap ErrRunnerFailed: %v", hinted)
	}
	if !strings.Contains(hinted.Error(), "FACTORY_CONTAINER_RUNTIME") {
		t.Errorf("hint missing FACTORY_CONTAINER_RUNTIME: %v", hinted)
	}
	if !strings.Contains(hinted.Error(), "podman") {
		t.Errorf("hint missing binary name: %v", hinted)
	}

	if got := hintIfMissingBinary("podman", nil); got != nil {
		t.Errorf("nil err should pass through; got %v", got)
	}
	other := errors.New("some other failure")
	if got := hintIfMissingBinary("podman", other); got != other {
		t.Errorf("unrelated err should pass through unchanged; got %v", got)
	}
}

// TestHintIfMissingBinaryMatchesWrappedText: a wrapped error whose message
// carries the canonical "executable file not found" text still gets the hint,
// even when the *exec.Error type is obscured behind another wrapper.
func TestHintIfMissingBinaryMatchesWrappedText(t *testing.T) {
	wrapped := fmt.Errorf("build step: %w", errors.New(`exec: "podman": executable file not found in %PATH%`))
	hinted := hintIfMissingBinary("podman", wrapped)
	if !strings.Contains(hinted.Error(), "FACTORY_CONTAINER_RUNTIME") {
		t.Errorf("text-matched err should get the hint: %v", hinted)
	}
}

func testShell(script string) (string, []string) {
	if runtime.GOOS == "windows" {
		return "cmd", []string{"/C", script}
	}
	return "sh", []string{"-c", script}
}
