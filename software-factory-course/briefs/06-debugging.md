# Module 6: 出错时看哪里

### Teaching Arc
- **Metaphor:** 飞机黑匣子。出错时不要猜，读结构化错误、attempt artifact 和状态。
- **Opening hook:** “任务失败”不是一个模糊状态，代码会把失败归入明确 error_code。
- **Key insight:** 契约校验和错误码把 AI 输出从自然语言变成可调试系统。
- **Why should I care?:** 当 AI 卡在 bug 循环时，先要求它报告 Step、attempt、error_code、artifact 路径。

### Code Snippets
File: factory-server/internal/runner/contracts.go (lines 48-63)
```
func readAndDecode(path string, target any) error {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("%s: %w", path, ErrOutputMissing)
		}
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	dec := json.NewDecoder(f)
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		return fmt.Errorf("%s: %w", path, ErrOutputInvalidJSON)
	}
	return nil
}
```

### Interactive Elements
- **Code translation:** strict output decoder.
- **Quiz:** Pick first debugging move for three failures.
- **Pattern cards:** output_missing, output_invalid_json, build_failed, health_check_failed, port_unavailable.
- **Reference sections:** Code translations, quizzes, pattern cards, callouts.

### Connections
- **Previous module:** Build and deployment.
- **Next module:** End of course.
