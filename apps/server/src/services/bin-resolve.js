// 找外部 CLI（cswap / codex）的執行檔。
//
// server 可能由 launchd 啟動，PATH 只有 /usr/bin:/bin 之類，直接 spawn('cswap') 會 ENOENT。
// 解析順序：環境變數（CSWAP_BIN / CODEX_BIN）→ PATH → ~/.local/bin → /opt/homebrew/bin → /usr/local/bin
// （codex 另外試 Codex.app / ChatGPT.app 內附的 CLI）。
// 每次呼叫都重新找（只是幾個 stat），裝好 cswap 不必重開 server。

import { accessSync, statSync, constants as fsConstants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// launchd 下 HOME 仍會設定；env 沒有 HOME 才退回 os.homedir()
const FALLBACK_DIRS = (env) => [
  join(env.HOME || homedir(), '.local/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

// 只裝了桌面 App、沒有獨立 CLI 時，用 App 內附的那支
const EXTRA_CANDIDATES = {
  codex: [
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  ],
};

const ENV_VARS = {
  cswap: 'CSWAP_BIN',
  codex: 'CODEX_BIN',
};

export function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function isExecutableFile(p) {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 回傳 { path, source, envVar }；找不到時 path 為 null。
 * 有設環境變數就「只」用它：明確指定卻指錯時不偷偷退回 PATH 上的另一支（測試 / 多版本並存時才不會跑錯檔）。
 */
export function resolveBin(name, env = process.env) {
  const envVar = ENV_VARS[name] ?? null;
  const fromEnv = envVar ? env[envVar] : null;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    const p = resolve(expandHome(fromEnv.trim()));
    return { path: isExecutableFile(p) ? p : null, source: 'env', envVar };
  }

  const seen = new Set();
  const dirs = [
    ...String(env.PATH ?? '').split(delimiter).filter(d => d && isAbsolute(d)),
    ...FALLBACK_DIRS(env),
  ];
  for (const dir of dirs) {
    const p = join(dir, name);
    if (seen.has(p)) continue;
    seen.add(p);
    if (isExecutableFile(p)) return { path: p, source: 'path', envVar };
  }
  for (const p of EXTRA_CANDIDATES[name] ?? []) {
    if (isExecutableFile(p)) return { path: p, source: 'bundle', envVar };
  }
  return { path: null, source: null, envVar };
}

// server 自己的 secret 不需要讓 cswap / codex 看見（其餘照傳：HOME、CLAUDE_CONFIG_DIR、proxy、憑證路徑…）
const STRIP_ENV_KEYS = ['SESSION_SECRET'];

/**
 * 子行程 env：沿用 process.env，PATH 補上執行檔所在目錄與常見安裝位置
 * （launchd 下 PATH 不完整時，cswap 的 python / codex 的 helper 才找得到）。
 */
export function childEnv(binPath, extra = {}, env = process.env) {
  const out = { ...env };
  for (const k of STRIP_ENV_KEYS) delete out[k];
  const parts = [];
  const push = (d) => { if (d && !parts.includes(d)) parts.push(d); };
  if (binPath) push(dirname(binPath));
  for (const d of String(env.PATH ?? '').split(delimiter)) push(d);
  for (const d of [...FALLBACK_DIRS(env), '/usr/bin', '/bin', '/usr/sbin', '/sbin']) push(d);
  out.PATH = parts.join(delimiter);
  // 輸出給程式解析，不要顏色碼
  out.NO_COLOR = '1';
  return { ...out, ...extra };
}
