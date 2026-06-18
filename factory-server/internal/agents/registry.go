// Package agents holds the fixed registry of factory agents: the five Claude
// Code subagents that make up the generate-test-deploy pipeline. The registry
// is upserted into the store on every server startup so its rows always reflect
// the current design even as their enabled flag is toggled at runtime.
package agents

import "github.com/weimengtsgit/xian630/factory-server/internal/model"

// DefaultRegistry returns the five fixed factory agents in pipeline order
// (sort_order ascending). The id / key / claude_agent_name / sort_order values
// are stable across releases; name/role/description are sourced from the
// design doc. Every agent ships enabled.
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
		{
			ID:              "agent_solution_designer",
			Key:             "solution-designer",
			Name:            "方案设计",
			Role:            "solution_design",
			Description:     "把需求变成可执行的前端项目设计和文件计划",
			ClaudeAgentName: "solution-designer",
			SkillsJSON:      "",
			Enabled:         true,
			SortOrder:       2,
		},
		{
			ID:              "agent_code_generator",
			Key:             "code-generator",
			Name:            "代码生成",
			Role:            "code_generation",
			Description:     "写入生成应用项目代码并生成 manifest",
			ClaudeAgentName: "code-generator",
			SkillsJSON:      "",
			Enabled:         true,
			SortOrder:       3,
		},
		{
			ID:              "agent_tester",
			Key:             "tester",
			Name:            "测试验证",
			Role:            "test_verification",
			Description:     "分析构建日志并生成诊断摘要",
			ClaudeAgentName: "tester",
			SkillsJSON:      "",
			Enabled:         true,
			SortOrder:       4,
		},
		{
			ID:              "agent_deployer",
			Key:             "deployer",
			Name:            "构建部署",
			Role:            "deployment",
			Description:     "执行镜像构建与容器部署",
			ClaudeAgentName: "deployer",
			SkillsJSON:      "",
			Enabled:         true,
			SortOrder:       5,
		},
	}
}
