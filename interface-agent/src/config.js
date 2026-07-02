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
  };
}
