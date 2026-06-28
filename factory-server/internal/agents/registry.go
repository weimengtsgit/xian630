// Package agents holds the fixed registry of factory agents: the six Claude
// Code subagents that make up the generate-test-deploy pipeline. The registry
// is upserted into the store on every server startup so its rows always reflect
// the current design even as their enabled flag is toggled at runtime.
package agents

import "github.com/weimengtsgit/xian630/factory-server/internal/model"

// DefaultRegistry returns the six fixed factory agents in pipeline order
// (sort_order ascending). The id / key / claude_agent_name / sort_order values
// are stable across releases; name/role/description are sourced from the
// design doc. Every agent ships enabled and belongs to the
// software_development category.
//
// The historical combined build-deploy agent (Key "deployer", Role
// "deployment") is split into two: image-builder (image_build) and deployer
// (deployment). Historical job_steps rows that recorded agent_key="deployer"
// for an image_build step still resolve via GetAgent("deployer") (now
// role=deployment), so legacy replay is unaffected.
func DefaultRegistry() []model.Agent {
	sd := model.AgentCategorySoftwareDevelopment
	return []model.Agent{
		{
			ID:              "agent_requirement_analyst",
			Key:             "requirement-analyst",
			Name:            "需求分析",
			Role:            "requirement_analysis",
			Description:     "把用户自然语言需求整理为生成应用的明确需求",
			ClaudeAgentName: "requirement-analyst",
			SkillsJSON:      "",
			Category:        sd,
			Prompt:          "",
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
			Category:        sd,
			Prompt:          "",
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
			Category:        sd,
			Prompt:          "",
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
			Category:        sd,
			Prompt:          "",
			Enabled:         true,
			SortOrder:       4,
		},
		{
			ID:              "agent_image_builder",
			Key:             "image-builder",
			Name:            "镜像构建",
			Role:            "image_build",
			Description:     "构建应用容器镜像",
			ClaudeAgentName: "image-builder",
			SkillsJSON:      "",
			Category:        sd,
			Prompt:          "",
			Enabled:         true,
			SortOrder:       5,
		},
		{
			ID:              "agent_deployer",
			Key:             "deployer",
			Name:            "部署",
			Role:            "deployment",
			Description:     "容器部署与运行时管理",
			ClaudeAgentName: "deployer",
			SkillsJSON:      "",
			Category:        sd,
			Prompt:          "",
			Enabled:         true,
			SortOrder:       6,
		},
	}
}
