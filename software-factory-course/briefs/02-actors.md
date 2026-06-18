# Module 2: 认识工厂角色

### Teaching Arc
- **Metaphor:** 剧组通告单。每个角色都有名字、职责和出场顺序。
- **Opening hook:** 中间任务区显示“需求分析、方案设计、代码生成”等状态，这些不是随便写的文案，而是注册表里的角色。
- **Key insight:** 软件系统通常靠明确职责降低混乱。
- **Why should I care?:** 和 AI 协作时，要能说“把这段逻辑放到 registry / executor / portal hook”，而不是笼统说“改一下后端”。

### Code Snippets
File: factory-server/internal/agents/registry.go (lines 13-25)
```
func DefaultRegistry() []model.Agent {
	return []model.Agent{
		{
			ID:              "agent_requirement_analyst",
			Key:             "requirement-analyst",
			Name:            "需求分析",
			Role:            "requirement_analysis",
			Description:     "把用户自然语言需求整理为生成应用的明确需求",
			ClaudeAgentName: "requirement-analyst",
			SkillsJSON:      "",
			Enabled:         true,
			SortOrder:       1,
		},
```

### Interactive Elements
- **Code translation:** First agent registry entry.
- **Quiz:** Pick the right owner for a new feature.
- **Group chat animation:** Portal, factory-server, cc-status, scene app, generated app.
- **Reference sections:** Code translations, quizzes, group chat, pattern cards, file tree.

### Connections
- **Previous module:** A Job exists.
- **Next module:** The Job enters the six-step conveyor.

