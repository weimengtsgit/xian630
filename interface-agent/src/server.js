import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDeepSeekClient } from './lib/deepseek.js';

const config = loadConfig();
const app = createApp({
  config,
  deepseekClient: createDeepSeekClient(config),
});

app.listen(config.port, config.host, () => {
  console.log(`AI Prototype Workbench listening on http://${config.host}:${config.port}`);
  console.log(`Local URL: http://localhost:${config.port}`);
});
