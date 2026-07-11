export function loadConfig(env = process.env) {
  return {
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT || 3000),
    publicBaseUrl: env.PUBLIC_BASE_URL || '',
    deepseekApiKey: env.DEEPSEEK_API_KEY || env.ANTHROPIC_AUTH_TOKEN || '',
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    deepseekModel: env.DEEPSEEK_MODEL || env.ANTHROPIC_MODEL || 'deepseek-chat',
    rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS || 60000),
    rateLimitMax: Number(env.RATE_LIMIT_MAX || 20),
    bladeOsBaseUrl: (env.BLADE_OS_BASE_URL || '').replace(/\/$/, ''),
    bladeOsPat: env.BLADE_OS_PAT || '',
    bladeOsTimeoutMs: Number(env.BLADE_OS_TIMEOUT_MS || 30000),
    pendingInputPath: env.PENDING_INPUT_PATH || '',
    confirmedOutputPath: env.CONFIRMED_OUTPUT_PATH || '',
    pendingPollIntervalMs: Number(env.PENDING_POLL_INTERVAL_MS || 3000),
    pipelineStageCompleteUrl: env.PIPELINE_STAGE_COMPLETE_URL || '',
    pipelineCompleteTimeoutMs: Number(env.PIPELINE_COMPLETE_TIMEOUT_MS || 5000),
    // SQLite 持久化路径：容器内建议 /var/lib/interface-agent/interface-agent.db（持久卷）
    dbPath: env.INTERFACE_AGENT_DB_PATH || '/var/lib/interface-agent/interface-agent.db',
    // 会话 Cookie 签名密钥（HMAC-SHA256）。未配置时启动会生成临时密钥并告警
    // （重启后所有会话 Cookie 失效）；生产必须配置。
    sessionSecret: env.INTERFACE_AGENT_SESSION_SECRET || '',
    // 仅在生产（TLS）下开启 Cookie 的 Secure 标志
    secureCookies: env.INTERFACE_AGENT_COOKIE_SECURE === '1',
    // 一次性启动码有效期（毫秒），spec 允许 60-120s
    startCodeTtlMs: Number(env.INTERFACE_AGENT_START_CODE_TTL_MS || 90000),
    // 异步生成 worker 轮询间隔（毫秒）
    generationPollIntervalMs: Number(env.GENERATION_POLL_INTERVAL_MS || 1500),
    // 交付 worker 轮询间隔（毫秒）—— 照 T5 generation worker 模式
    deliveryPollIntervalMs: Number(env.DELIVERY_POLL_INTERVAL_MS || 1500),
    // resolve CREATE 的服务间共享密钥（X-Internal-Token）。agent-pipeline 创建
    // 会话时必须携带此值。留空 → fail-closed（拒绝所有 create，仅允许 verify）。
    internalToken: env.INTERFACE_AGENT_INTERNAL_TOKEN || '',
    // 分享链接默认有效期（毫秒），默认 7 天；可在创建时用 expiresInMs 覆盖
    shareDefaultExpiresMs: Number(env.SHARE_DEFAULT_EXPIRES_MS || 7 * 24 * 60 * 60 * 1000),
    // 孤立版本产物回收（T8）。仅回收"版本产物路径下、DB 无对应 version 行、
    // 且年龄 ≥ maxAgeMs"的文件，绝不误删在途 tx 文件或兼容交付路径。
    // 设 ARTIFACT_CLEANUP_ENABLED=0 可整体关闭。
    artifactCleanupEnabled: env.ARTIFACT_CLEANUP_ENABLED || '1',
    artifactCleanupStartupDelayMs: Number(env.ARTIFACT_CLEANUP_STARTUP_DELAY_MS || 30000),
    artifactCleanupIntervalMs: Number(env.ARTIFACT_CLEANUP_INTERVAL_MS || 6 * 60 * 60 * 1000),
    artifactCleanupMaxAgeMs: Number(env.ARTIFACT_CLEANUP_MAX_AGE_MS || 60 * 60 * 1000),
  };
}
