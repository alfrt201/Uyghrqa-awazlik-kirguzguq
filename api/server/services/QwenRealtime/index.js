const { createQwenRealtimeService } = require('@librechat/api');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');

/** Keep server wiring here; relay behavior and protocol handling live in packages/api. */
module.exports = () =>
  createQwenRealtimeService({
    apiKey: process.env.DASHSCOPE_API_KEY,
    endpoint: process.env.DASHSCOPE_REALTIME_URL,
    model: process.env.QWEN_REALTIME_MODEL,
    requireJwtAuth,
  });
