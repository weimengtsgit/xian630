# Module 3: 六阶段流水线

### Teaching Arc
- **Metaphor:** 传送带上的六个工位。每个工位只做一件事，然后把工件交给下一站。
- **Opening hook:** 用户看到一个进度条，但后端看到的是固定 StepDefinition 列表。
- **Key insight:** Job 和 Step 的状态机让复杂生成流程可追踪、可重试。
- **Why should I care?:** AI 如果把测试、构建、部署混在代码生成里，要能指出这破坏了边界。

### Code Snippets
File: factory-server/internal/executor/steps.go (lines 30-39)
```
func FixedSteps() []StepDefinition {
	return []StepDefinition{
		{Kind: model.StepRequirementAnalysis, Seq: 1, AgentKey: "requirement-analyst", Mode: ModeClaude},
		{Kind: model.StepSolutionDesign, Seq: 2, AgentKey: "solution-designer", Mode: ModeClaude},
		{Kind: model.StepCodeGeneration, Seq: 3, AgentKey: "code-generator", Mode: ModeClaude},
		{Kind: model.StepTestVerification, Seq: 4, AgentKey: "tester", Mode: ModeFactoryWithOptionalClaudeAnalysis},
		{Kind: model.StepImageBuild, Seq: 5, AgentKey: "deployer", Mode: ModeFactory},
		{Kind: model.StepDeployment, Seq: 6, AgentKey: "deployer", Mode: ModeFactory},
	}
}
```

### Interactive Elements
- **Code translation:** FixedSteps.
- **Quiz:** Decide where a new validation step belongs.
- **Data flow animation:** Queue → Executor → Runner → Store → next Step.
- **Reference sections:** Code translations, quizzes, data flow, numbered steps.

### Connections
- **Previous module:** Actors.
- **Next module:** How UI learns the Step changed.

