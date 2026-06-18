# Module 5: 应用身份证与部署

### Teaching Arc
- **Metaphor:** 护照和登机牌。`.factory/app.json` 证明应用是谁，构建命令和 Docker 信息告诉系统怎么让它上机。
- **Opening hook:** `scene/` 下的预置应用能自动出现在门户，是因为 scanner 扫描 manifest。
- **Key insight:** Factory 不猜应用结构，它读取 manifest，然后执行固定的 npm、Podman、健康检查流程。
- **Why should I care?:** 让 AI 生成新应用时，manifest 不完整会导致后续工位全部卡住。

### Code Snippets
File: factory-server/internal/executor/factory_steps.go (lines 141-163)
```
	// 1. Dependency install: npm ci when a lockfile is present, else npm install.
	if _, err := os.Stat(filepath.Join(projectDir, "package-lock.json")); err == nil {
		if _, ok := f.runCmd(ctx, job, step, projectDir, "npm", "ci"); !ok {
			return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorDependencyInstallFailed, ErrorMessage: "npm ci failed"}, nil
		}
	} else {
		if _, ok := f.runCmd(ctx, job, step, projectDir, "npm", "install"); !ok {
			return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorDependencyInstallFailed, ErrorMessage: "npm install failed"}, nil
		}
	}
```

### Interactive Elements
- **Code translation:** npm install decision.
- **Quiz:** Diagnose missing generated app card.
- **Architecture diagram:** manifest → scanner → store → build → Podman.
- **Reference sections:** Code translations, quizzes, architecture diagram, pattern cards.

### Connections
- **Previous module:** Portal sees application changes.
- **Next module:** What happens when a stage fails.

