#!/usr/bin/env node
import { loadApplicationEnv } from './src/config.js';

// Load configuration before importing modules that capture environment values.
try {
  loadApplicationEnv();
  const { startApplication } = await import('./login-service/server.js');
  await startApplication();
} catch (error) {
  console.error('服务启动失败:', error);
  process.exitCode = 1;
}
