import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';

// STATUS_DIR 解析順序（configs/ 底下的獨立 script 各自複製一份同樣邏輯）：
// STATUS_DIR_PATH → dirname(STATUS_FILE_PATH)（Increment 03 舊行為）→ ~/.claude/codd-status
export function resolveStatusDir(env = process.env) {
  if (env.STATUS_DIR_PATH) return resolve(env.STATUS_DIR_PATH);
  if (env.STATUS_FILE_PATH) return resolve(dirname(env.STATUS_FILE_PATH));
  return resolve(homedir(), '.claude/codd-status');
}

// <id>.hook.json / <id>.statusline.json（per CODD_TERMINAL_ID）
export function termDir(statusDir) {
  return join(statusDir, 'term');
}

// <config_key>.json（per Claude 帳號 / CLAUDE_CONFIG_DIR）
export function usageDir(statusDir) {
  return join(statusDir, 'usage');
}
