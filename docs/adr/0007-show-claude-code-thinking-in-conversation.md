# Show Claude Code thinking in the conversation workbench

The conversation workbench will stream and retain Claude Code CLI `thinking` / `thinking_delta` as a first-class user-visible 思考过程, separate from 分析过程 and work-trace audit logs. This deliberately relaxes the previous "never expose hidden reasoning" boundary for the local conversation surface because the product goal is to reproduce the Claude Code CLI interaction model end to end; the remaining boundary is separation and attribution, not suppression.
