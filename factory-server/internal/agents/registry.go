// Package agents holds the fixed registry of factory agents: the six software
// development agents that make up the generate-test-image-deploy pipeline. The
// registry is upserted into the store on every server startup so its rows
// always reflect the current design even as their enabled flag is toggled at
// runtime.
package agents

import "github.com/weimengtsgit/xian630/factory-server/internal/model"

const requirementAnalystPrompt = "你是软件工厂的需求分析智能体。负责冻结用户已确认需求，校验字段完整性、能力边界、generationProfile 与蓝本引用。不得生成代码，不得执行命令，不得输出隐藏推理链。"
const solutionDesignerPrompt = "你是软件工厂的方案设计智能体。负责把已确认需求转为可执行的前端应用方案、文件计划、交互结构和验收重点。不得执行命令，不得输出隐藏推理链。"
const codeGeneratorPrompt = "你是软件工厂的代码生成智能体。负责在 generated-apps/<slug>/ 下生成静态 Vite 应用、Factory manifest、Dockerfile 和必要源码。不得写入允许范围外路径。"
const testerPrompt = "你是软件工厂的测试验证智能体。负责分析测试与构建日志，生成公开诊断摘要；真实命令由 Factory 执行，你不得自由拼接命令。"
const imageBuilderPrompt = "你是软件工厂的镜像构建智能体。负责解释镜像构建阶段的产物、日志和失败原因；真实 podman build 命令由 Factory 固定执行。"
const deployerPrompt = "你是软件工厂的部署智能体。负责解释容器部署、健康检查和运行地址；真实 podman run/stop 命令由 Factory 固定执行。"

// DefaultRegistry returns the six fixed software development agents in pipeline
// order (sort_order ascending). The id / key / claude_agent_name / sort_order
// values are stable across releases; name/role/description/prompt are sourced
// from the design. Every software agent ships enabled and read-only.
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
			Category:        model.AgentCategorySoftware,
			Prompt:          requirementAnalystPrompt,
			Editable:        false,
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
			Category:        model.AgentCategorySoftware,
			Prompt:          solutionDesignerPrompt,
			Editable:        false,
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
			Category:        model.AgentCategorySoftware,
			Prompt:          codeGeneratorPrompt,
			Editable:        false,
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
			Category:        model.AgentCategorySoftware,
			Prompt:          testerPrompt,
			Editable:        false,
		},
		{
			ID:              "agent_image_builder",
			Key:             "image-builder",
			Name:            "镜像构建",
			Role:            "image_build",
			Description:     "解释镜像构建过程、产物和失败原因",
			ClaudeAgentName: "image-builder",
			SkillsJSON:      "",
			Enabled:         true,
			SortOrder:       5,
			Category:        model.AgentCategorySoftware,
			Prompt:          imageBuilderPrompt,
			Editable:        false,
		},
		{
			ID:              "agent_deployer",
			Key:             "deployer",
			Name:            "部署",
			Role:            "deployment",
			Description:     "解释并审计容器部署、健康检查和运行地址",
			ClaudeAgentName: "deployer",
			SkillsJSON:      "",
			Enabled:         true,
			SortOrder:       6,
			Category:        model.AgentCategorySoftware,
			Prompt:          deployerPrompt,
			Editable:        false,
		},
	}
}
