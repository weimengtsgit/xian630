package runlog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Logger struct {
	path       string
	maxBytes   int64
	maxBackups int
	mu         sync.Mutex
}

func New(path string, maxBytes int64, maxBackups int) *Logger {
	return &Logger{path: path, maxBytes: maxBytes, maxBackups: maxBackups}
}

func (l *Logger) Event(name string, fields map[string]any) {
	if l == nil || l.path == "" || name == "" {
		return
	}
	entry := map[string]any{
		"ts":    time.Now().Format(time.RFC3339Nano),
		"event": name,
	}
	for k, v := range fields {
		if k == "ts" || k == "event" {
			continue
		}
		entry[k] = v
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	line = append(line, '\n')

	l.mu.Lock()
	defer l.mu.Unlock()
	_ = os.MkdirAll(filepath.Dir(l.path), 0o755)
	_ = l.rotateIfNeeded(int64(len(line)))
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(line)
}

func (l *Logger) rotateIfNeeded(incoming int64) error {
	if l.maxBytes <= 0 {
		return nil
	}
	info, err := os.Stat(l.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if info.Size() == 0 || info.Size()+incoming <= l.maxBytes {
		return nil
	}
	if l.maxBackups <= 0 {
		return os.Remove(l.path)
	}
	for i := l.maxBackups - 1; i >= 1; i-- {
		src := fmt.Sprintf("%s.%d", l.path, i)
		dst := fmt.Sprintf("%s.%d", l.path, i+1)
		if _, err := os.Stat(src); err == nil {
			_ = os.Rename(src, dst)
		}
	}
	return os.Rename(l.path, l.path+".1")
}
