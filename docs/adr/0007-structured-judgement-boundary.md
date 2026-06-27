# Capture judgement boundaries in confirmed requirements

Customer-facing military and naval application generation will capture the 研判边界 as structured data in the 确认需求摘要 instead of relying only on clarification prompt guidance. This keeps clarification focused on the data-source boundaries, monitored scope, judgement rules, target outcomes, cadence, output views, and unavailable-data behavior that determine business meaning; otherwise the model tends to bury those decisions inside generic fields such as core scenario or acceptance focus, making high-impact gaps hard to detect, display, and enforce. The user-facing clarification asks for 数据来源边界 rather than a mock-vs-real data policy; internal compatibility fields such as `dataPolicy` may remain in the pipeline, but customer-facing military and naval judgement results are constrained to real selected data sources.

For the current implementation, 数据来源边界 clarification stays deliberately simple: it presents a multi-select choice between 本体数据源 and 网络公开搜索 and does not add source-specific follow-up gates for ontology entities, search connectors, keywords, or crawler scope. Additional source families and stricter execution-boundary checks will be introduced later through 数据接入能力包 skills rather than free-form source enumeration.

The first structured shape is deliberately light: `judgementBoundary.dataSources` plus a user-facing `judgementBoundary.summary`. Selecting 网络公开搜索 does not mean the generated application can call Claude Code search tools or direct-fetch Baidu pages at runtime; generation-time tools may help inspect requirements, while runtime data must come from endpoints or connectors the generated application can actually access.

The data-source family multi-select is the first high-impact clarification item for this implementation. It asks only for 本体数据源 and/or 网络公开搜索 and intentionally does not add follow-up gates for entities, connectors, keywords, or crawler scope in the same version.

Implementation will extend the existing Claude Code `requirement-clarification` skill and its JSON contract. It will not introduce a separate clarification subprocess or embed general-purpose brainstorming/grilling skills directly into the runtime user flow.

`judgementBoundary` is required only for military, naval, maritime judgement, OSINT, alerting, affiliation-inference, or situation-replay generation requests. Other generated application types may omit it so ordinary business-management clarification does not inherit unnecessary judgement language.

The confirmation summary displays judgement-boundary content as a concise user-facing summary plus readable data-source labels. It does not expose internal enum values such as `ontology` or `public_web_search`.
