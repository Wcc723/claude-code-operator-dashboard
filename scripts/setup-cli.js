#!/usr/bin/env node
// Setup CLI — 把 CODD 的 hooks + statusline 裝進 user-level Claude Code settings
//
// 用法：
//   npm run setup -- status
//   npm run setup -- install   [--dry-run]
//   npm run setup -- uninstall [--dry-run]
//
// 共通 flags：
//   --only hooks,statusline,legacy   只動指定部分（預設全部）
//   --dry-run                        只印預覽，不寫檔
//   --settings <path>                覆蓋 settings 路徑（預設 ~/.claude/settings.json）
//   --channel <path>                 覆蓋 .env 的 CHANNEL_PATH（legacy 檢查用）
//   --node <path>                    hook / statusline 用的 node（預設：執行本 CLI 的 node）
//   --repo-root <path>               configs/ 腳本所在的 repo（預設：本 repo）
//   --json                           輸出 JSON
//
// 必須在跑 server 的那台機器（Mac mini）上執行：它改的是那台的 ~/.claude/settings.json。

import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getSetupStatus,
  planSetup,
  planUninstall,
  applySetup,
  uninstallSetup,
  parseParts,
} from '../apps/server/src/services/claude-setup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
// 和 server 讀同一份 .env，STATUS_DIR_PATH / CHANNEL_PATH 才會一致
dotenvConfig({ path: resolve(repoRoot, '.env') });

// ───────── arg parsing ─────────

const argv = process.argv.slice(2);
const VALUE_FLAGS = ['--only', '--settings', '--channel', '--node', '--repo-root'];

function getFlag(name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) fail(`${name} 需要一個值`);
  return v;
}

const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]));
const subcommand = positional[0] || 'status';
const flags = {
  only: getFlag('--only'),
  settings: getFlag('--settings'),
  channel: getFlag('--channel'),
  node: getFlag('--node'),
  repoRoot: getFlag('--repo-root'),
  dryRun: argv.includes('--dry-run'),
  json: argv.includes('--json'),
  help: argv.includes('--help') || argv.includes('-h'),
};

const opts = {
  ...(flags.settings ? { settingsPath: resolve(flags.settings) } : {}),
  ...(flags.channel !== undefined ? { channelPath: flags.channel } : {}),
  ...(flags.node ? { nodePath: resolve(flags.node) } : {}),
  repoRoot: flags.repoRoot ? resolve(flags.repoRoot) : repoRoot,
};

// ───────── output helpers ─────────

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function info(msg = '') { console.log(msg); }

function ago(iso) {
  if (!iso) return '—';
  const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (sec < 60) return '剛剛';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分鐘前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小時前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

const ICON = { installed: '✓', outdated: '⚠', missing: '✗' };

function printStatus(s) {
  info('');
  info(`settings   : ${s.settings_path}${s.settings_exists ? '' : '（尚不存在，安裝時會建立）'}`);
  info(`status dir : ${s.status_dir}`);
  if (s.error) info(`✗ ${s.error}`);
  info('');

  const h = s.hooks;
  let hookDetail = '';
  if (h.state === 'outdated') {
    const bits = [];
    if (h.events_outdated.length) bits.push(`需更新：${h.events_outdated.join(', ')}`);
    if (h.events_missing.length) bits.push(`缺少：${h.events_missing.join(', ')}`);
    hookDetail = ` — ${bits.join('；')}`;
  }
  info(`  ${ICON[h.state]} hooks       ${h.state}${hookDetail}`);

  const sl = s.statusline;
  const slDetail = sl.state === 'missing'
    ? (sl.has_foreign ? ' — 安裝時會包住你現有的 statusline（畫面不變）' : '')
    : ` — ${sl.mode === 'wrapped' ? 'wrapped（串接原本的 statusline）' : 'standalone'}`;
  info(`  ${ICON[sl.state]} statusline  ${sl.state}${slDetail}`);

  const lg = s.legacy;
  if (lg.present) info(`  ⚠ legacy      ${lg.entries} 個舊 channel 級 hook（${lg.file}）— install 會移除`);
  else info(`  ✓ legacy      無${lg.file ? '' : '（CHANNEL_PATH 未設定）'}`);

  info('');
  info(`  最近收到資料：hook ${ago(s.data.hook_last_at)} · statusline ${ago(s.data.statusline_last_at)} · usage ${ago(s.data.usage_last_at)}`);
  for (const w of s.warnings) info(`  ⚠ ${w}`);
  info('');
  info(s.complete ? '  設定完成。' : '  尚未完成：執行 `npm run setup -- install`（先加 --dry-run 預覽）');
  info('');
}

function handlerCommands(groups) {
  return (groups || []).flatMap(g => [
    ...(typeof g?.command === 'string' ? [g.command] : []),
    ...(Array.isArray(g?.hooks) ? g.hooks.map(h => h?.command).filter(Boolean) : []),
  ]);
}

const isGroup = (g) => g !== null && typeof g === 'object';

// 每個 event 用的是同一條 command，逐條印 JSON 太長；完整內容用 --json 看
function printHookChange(c) {
  const before = c.before?.hooks || {};
  const after = c.after?.hooks || {};
  const added = new Set();
  const removed = new Set();
  for (const ev of [...new Set([...Object.keys(before), ...Object.keys(after)])]) {
    // after 開頭可能是「保留既有 N 組 hook」的字串標記，不是 hook group
    const b = (before[ev] || []).filter(isGroup);
    const a = (after[ev] || []).filter(isGroup);
    const tag = !b.length ? '+ 新增' : !a.length ? '- 移除' : '~ 更新';
    const matcher = a[0]?.matcher ?? b[0]?.matcher;
    info(`    ${ev.padEnd(18)} ${tag}${matcher !== undefined ? `  (matcher ${JSON.stringify(matcher)})` : ''}`);
    handlerCommands(a).forEach(cmd => added.add(cmd));
    handlerCommands(b).forEach(cmd => removed.add(cmd));
  }
  for (const cmd of removed) if (!added.has(cmd)) info(`  - command: ${cmd}`);
  for (const cmd of added) if (!removed.has(cmd)) info(`  + command: ${cmd}`);
  const timeout = Object.values(after).flat().find(isGroup)?.hooks?.[0]?.timeout;
  if (timeout) info(`    timeout: ${timeout}s`);
}

function printChanges(changes) {
  if (!changes.length) {
    info('  沒有需要變更的項目（已是最新狀態）。');
    info('');
    return;
  }
  for (const c of changes) {
    info(`=== ${c.part} · ${c.file} ===`);
    info(`  ${c.summary}`);
    if (c.part === 'statusline') {
      info('--- before');
      info(JSON.stringify(c.before, null, 2));
      info('+++ after');
      info(JSON.stringify(c.after, null, 2));
    } else {
      printHookChange(c);
    }
    info('');
  }
}

function printHelp() {
  info(`用法：npm run setup -- <status|install|uninstall> [flags]

  status      顯示目前安裝狀態（不寫檔）
  install     安裝 / 更新 hooks + statusline，並移除舊的 channel 級 hook
  uninstall   移除 CODD hooks，statusline 還原成原本的指令

  --only hooks,statusline,legacy   只動指定部分（預設全部）
  --dry-run                        只印預覽，不寫檔
  --settings <path>                settings 路徑（預設 ~/.claude/settings.json）
  --channel <path>                 覆蓋 .env 的 CHANNEL_PATH
  --node <path>                    hook / statusline 使用的 node
  --repo-root <path>               configs/ 腳本所在的 repo
  --json                           輸出 JSON`);
}

// ───────── dispatcher ─────────

const SUBCOMMANDS = ['status', 'install', 'uninstall'];
if (flags.help) { printHelp(); process.exit(0); }
if (!SUBCOMMANDS.includes(subcommand)) fail(`未知的指令：${subcommand}（可用：${SUBCOMMANDS.join(' / ')}）`);

try {
  const parts = parseParts(flags.only);

  if (subcommand === 'status') {
    const s = getSetupStatus(opts);
    if (flags.json) info(JSON.stringify(s, null, 2));
    else printStatus(s);
  } else if (flags.dryRun) {
    const plan = subcommand === 'install' ? planSetup(parts, opts) : planUninstall(parts, opts);
    if (flags.json) info(JSON.stringify(plan, null, 2));
    else {
      info('');
      info(`(dry-run，不寫入任何檔案) ${subcommand} · parts: ${plan.parts.join(', ')}`);
      info('');
      printChanges(plan.changes);
    }
  } else {
    const result = subcommand === 'install' ? applySetup(parts, opts) : uninstallSetup(parts, opts);
    if (flags.json) info(JSON.stringify(result, null, 2));
    else {
      info('');
      if (result.applied.length) info(`✓ ${subcommand}：${result.applied.join(', ')}`);
      if (result.unchanged.length) info(`· 不需變更：${result.unchanged.join(', ')}`);
      for (const b of result.backups) info(`  備份：${b}`);
      for (const c of result.changes) info(`  - [${c.part}] ${c.summary}`);
      if (result.applied.length) info('  已在執行中的 Claude Code session 通常會自動重新載入 settings；沒生效就重開 session。');
      printStatus(result.status);
    }
  }
} catch (e) {
  fail(e.message);
}
