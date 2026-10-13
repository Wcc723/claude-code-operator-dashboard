#!/usr/bin/env node
// Channel CLI — install / update / uninstall / status 範本生命週期管理
//
// 用法：
//   npm run channel install
//   npm run channel update
//   npm run channel uninstall [--purge]
//   npm run channel status
//
// 共通 flags:
//   --channel <path>          覆蓋 .env 的 CHANNEL_PATH
//   --only hooks,agents,mcp   只動指定部分
//   --dry-run                 只印 diff 不寫
//   --force                   install 時強制覆蓋已存在的範本

import { config as dotenvConfig } from 'dotenv';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  unlinkSync,
  mkdirSync,
  statSync,
  renameSync,
} from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
dotenvConfig({ path: resolve(repoRoot, '.env') });

const HOOK_SCRIPT = resolve(repoRoot, 'configs/hooks/status-writer.js');
const HOOK_MARKER = 'codd:status-writer';
const AGENT_SRC = resolve(repoRoot, 'configs/agents/frontmatter-doctor.md');
const AGENT_BASENAME = 'frontmatter-doctor.md';
const MCP_KEY = 'codd-manager';
const MCP_SCRIPT = resolve(repoRoot, 'apps/mcp/src/index.js');

// ───────── arg parsing ─────────

const argv = process.argv.slice(2);
const subcommand = argv.find(a => !a.startsWith('--')) || 'status';
const flags = {
  channel: getFlag('--channel'),
  only: (getFlag('--only') || '').split(',').filter(Boolean),
  dryRun: argv.includes('--dry-run'),
  force: argv.includes('--force'),
  purge: argv.includes('--purge'),
};

function getFlag(name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  return argv[i + 1];
}

// hooks 模組已由 user-level 的 `npm run setup` 取代：channel 級 PostToolUse hook 會和它重複觸發，
// 所以 install / update 預設跳過，只有明確 --only hooks 才會動（uninstall / status 照常，方便清掉舊的）
const SUPERSEDED = new Set(['hooks']);

function shouldRun(module, cmd) {
  if (flags.only.length) return flags.only.includes(module);
  return !(SUPERSEDED.has(module) && (cmd === 'install' || cmd === 'update'));
}

// ───────── env / paths ─────────

const channelPath = resolve(flags.channel || process.env.CHANNEL_PATH || '');
if (!channelPath) fail('CHANNEL_PATH not set (either via --channel or .env)');
if (!existsSync(join(channelPath, '.claude'))) {
  fail(`channel path missing .claude/ dir: ${channelPath}`);
}

const kanbanDbPath = resolve(
  process.env.KANBAN_DB_PATH || resolve(repoRoot, 'apps/server/data/kanban.db')
);
const statusDirPath = resolve(
  process.env.STATUS_DIR_PATH
    || (process.env.STATUS_FILE_PATH && dirname(process.env.STATUS_FILE_PATH))
    || resolve(homedir(), '.claude/codd-status')
);

// ───────── helpers ─────────

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function info(msg) { console.log(msg); }

function readJson(file, fallback = {}) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { fail(`failed to parse JSON ${file}: ${e.message}`); }
}

function writeJsonAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

function writeTextAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, file);
}

function hashFile(p) {
  if (!existsSync(p)) return null;
  return createHash('sha1').update(readFileSync(p)).digest('hex');
}

function diffSummary(label, before, after) {
  return `\n=== ${label} ===\n${
    JSON.stringify(before === undefined ? null : before, null, 2)
  }\n  →\n${JSON.stringify(after === undefined ? null : after, null, 2)}\n`;
}

// ───────── hooks module ─────────

const hooks = {
  settingsPath: join(channelPath, '.claude/settings.json'),

  hookCommand() {
    return `STATUS_DIR_PATH=${statusDirPath} node ${HOOK_SCRIPT}`;
  },

  // Claude Code 官方 hook 結構：
  //   { matcher, hooks: [{ type: 'command', command }] }
  // marker 透過 inner hooks[0].command 的字串 + 額外 _marker_comment 欄位識別
  toWireFormat() {
    return {
      matcher: '.*',
      hooks: [
        { type: 'command', command: this.hookCommand() },
      ],
    };
  },

  findManagedIndex(arr) {
    if (!Array.isArray(arr)) return -1;
    return arr.findIndex(e => {
      const cmd = e?.hooks?.[0]?.command || e?.command || '';
      return cmd.includes('status-writer.js');
    });
  },

  status() {
    const settings = readJson(this.settingsPath);
    const list = settings.hooks?.PostToolUse;
    const idx = this.findManagedIndex(list);
    if (idx < 0) return { state: 'missing' };
    const existing = list[idx];
    const expected = this.toWireFormat();
    const synced = JSON.stringify(existing) === JSON.stringify(expected);
    return { state: synced ? 'synced' : 'outdated', existing, expected };
  },

  install() {
    const settings = readJson(this.settingsPath);
    settings.hooks = settings.hooks || {};
    settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];
    const idx = this.findManagedIndex(settings.hooks.PostToolUse);
    const wire = this.toWireFormat();
    if (idx >= 0 && !flags.force) {
      return { action: 'skip', reason: 'already installed (use update to refresh)' };
    }
    if (idx >= 0) settings.hooks.PostToolUse[idx] = wire;
    else settings.hooks.PostToolUse.push(wire);
    if (flags.dryRun) return { action: 'would-install', diff: diffSummary('hooks PostToolUse[*]', null, wire) };
    writeJsonAtomic(this.settingsPath, settings);
    return { action: 'installed' };
  },

  update() {
    const settings = readJson(this.settingsPath);
    settings.hooks = settings.hooks || {};
    settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];
    const idx = this.findManagedIndex(settings.hooks.PostToolUse);
    const wire = this.toWireFormat();
    if (idx < 0) {
      settings.hooks.PostToolUse.push(wire);
      if (flags.dryRun) return { action: 'would-add', diff: diffSummary('hooks PostToolUse[+]', null, wire) };
      writeJsonAtomic(this.settingsPath, settings);
      return { action: 'added' };
    }
    const before = settings.hooks.PostToolUse[idx];
    settings.hooks.PostToolUse[idx] = wire;
    if (flags.dryRun) return { action: 'would-update', diff: diffSummary('hooks PostToolUse[*]', before, wire) };
    writeJsonAtomic(this.settingsPath, settings);
    return { action: 'updated' };
  },

  uninstall() {
    if (!existsSync(this.settingsPath)) return { action: 'skip', reason: 'no settings.json' };
    const settings = readJson(this.settingsPath);
    if (!Array.isArray(settings.hooks?.PostToolUse)) return { action: 'skip', reason: 'no hooks' };
    const before = settings.hooks.PostToolUse;
    const cmdOf = (e) => e?.hooks?.[0]?.command || e?.command || '';
    const after = before.filter(e => !cmdOf(e).includes('status-writer.js'));
    if (after.length === before.length) return { action: 'skip', reason: 'not installed' };
    if (after.length === 0) delete settings.hooks.PostToolUse;
    else settings.hooks.PostToolUse = after;
    if (flags.dryRun) return { action: 'would-uninstall', diff: diffSummary('hooks removed', before, after) };
    writeJsonAtomic(this.settingsPath, settings);
    return { action: 'uninstalled' };
  },
};

// ───────── agents module ─────────

const agents = {
  targetPath: join(channelPath, '.claude/agents', AGENT_BASENAME),

  status() {
    if (!existsSync(this.targetPath)) return { state: 'missing' };
    const srcHash = hashFile(AGENT_SRC);
    const dstHash = hashFile(this.targetPath);
    const isManaged = readFileSync(this.targetPath, 'utf8').includes('codd:managed');
    if (!isManaged) return { state: 'present (unmanaged)' };
    return { state: srcHash === dstHash ? 'synced' : 'outdated' };
  },

  install() {
    if (existsSync(this.targetPath) && !flags.force) {
      return { action: 'skip', reason: 'already exists (use --force to overwrite)' };
    }
    if (flags.dryRun) return { action: 'would-install', diff: `+ ${this.targetPath}\n` };
    mkdirSync(dirname(this.targetPath), { recursive: true });
    copyFileSync(AGENT_SRC, this.targetPath);
    return { action: 'installed' };
  },

  update() {
    if (!existsSync(this.targetPath)) {
      if (flags.dryRun) return { action: 'would-install', diff: `+ ${this.targetPath}\n` };
      mkdirSync(dirname(this.targetPath), { recursive: true });
      copyFileSync(AGENT_SRC, this.targetPath);
      return { action: 'installed' };
    }
    const existing = readFileSync(this.targetPath, 'utf8');
    if (!existing.includes('codd:managed')) {
      return { action: 'skip', reason: 'file is unmanaged (manual edit detected). Use --force to override.' };
    }
    if (flags.dryRun) return { action: 'would-update', diff: `~ ${this.targetPath}\n` };
    copyFileSync(AGENT_SRC, this.targetPath);
    return { action: 'updated' };
  },

  uninstall() {
    if (!existsSync(this.targetPath)) return { action: 'skip', reason: 'not installed' };
    const existing = readFileSync(this.targetPath, 'utf8');
    if (flags.purge) {
      if (flags.dryRun) return { action: 'would-purge', diff: `- ${this.targetPath}\n` };
      unlinkSync(this.targetPath);
      return { action: 'purged' };
    }
    // soft uninstall: 改 marker
    const updated = existing.replace('codd:managed', 'codd:unmanaged');
    if (updated === existing) return { action: 'skip', reason: 'no marker to flip' };
    if (flags.dryRun) return { action: 'would-flip-marker', diff: 'codd:managed → codd:unmanaged\n' };
    writeTextAtomic(this.targetPath, updated);
    return { action: 'soft-uninstalled (file kept, marker flipped)' };
  },
};

// ───────── mcp module ─────────

const mcp = {
  configPath: join(channelPath, '.mcp.json'),

  entry() {
    return {
      command: 'node',
      args: [MCP_SCRIPT],
      env: {
        CHANNEL_PATH: channelPath,
        KANBAN_DB_PATH: kanbanDbPath,
      },
    };
  },

  status() {
    const cfg = readJson(this.configPath);
    const existing = cfg.mcpServers?.[MCP_KEY];
    if (!existing) return { state: 'missing' };
    const expected = this.entry();
    const synced = JSON.stringify(existing) === JSON.stringify(expected);
    return { state: synced ? 'synced' : 'outdated', existing, expected };
  },

  install() {
    const cfg = readJson(this.configPath, { mcpServers: {} });
    cfg.mcpServers = cfg.mcpServers || {};
    if (cfg.mcpServers[MCP_KEY] && !flags.force) {
      return { action: 'skip', reason: 'already installed (use update to refresh)' };
    }
    const entry = this.entry();
    if (flags.dryRun) return { action: 'would-install', diff: diffSummary(`mcpServers.${MCP_KEY}`, null, entry) };
    cfg.mcpServers[MCP_KEY] = entry;
    writeJsonAtomic(this.configPath, cfg);
    return { action: 'installed' };
  },

  update() {
    const cfg = readJson(this.configPath, { mcpServers: {} });
    cfg.mcpServers = cfg.mcpServers || {};
    const before = cfg.mcpServers[MCP_KEY] ?? null;
    const entry = this.entry();
    if (JSON.stringify(before) === JSON.stringify(entry)) {
      return { action: 'skip', reason: 'already synced' };
    }
    if (flags.dryRun) return { action: 'would-update', diff: diffSummary(`mcpServers.${MCP_KEY}`, before, entry) };
    cfg.mcpServers[MCP_KEY] = entry;
    writeJsonAtomic(this.configPath, cfg);
    return { action: before ? 'updated' : 'installed' };
  },

  uninstall() {
    if (!existsSync(this.configPath)) return { action: 'skip', reason: 'no .mcp.json' };
    const cfg = readJson(this.configPath);
    if (!cfg.mcpServers?.[MCP_KEY]) return { action: 'skip', reason: 'not installed' };
    const before = cfg.mcpServers[MCP_KEY];
    delete cfg.mcpServers[MCP_KEY];
    if (flags.dryRun) return { action: 'would-uninstall', diff: diffSummary(`mcpServers.${MCP_KEY}`, before, null) };
    writeJsonAtomic(this.configPath, cfg);
    return { action: 'uninstalled' };
  },
};

// ───────── dispatcher ─────────

const modules = { hooks, agents, mcp };

function runCommand(cmd) {
  const results = {};
  for (const [name, mod] of Object.entries(modules)) {
    if (!shouldRun(name, cmd)) {
      const reason = flags.only.length ? '--only filter' : 'superseded by `npm run setup`';
      results[name] = { action: 'skip', reason };
      continue;
    }
    try { results[name] = mod[cmd](); }
    catch (e) { results[name] = { action: 'error', reason: e.message }; }
  }
  return results;
}

function printResults(cmd, results) {
  const stateIcon = { synced: '✓', outdated: '⚠', missing: '✗' };
  info('');
  info(`channel: ${channelPath}`);
  if (flags.dryRun) info('(dry-run, no files written)');
  info('');
  for (const [name, res] of Object.entries(results)) {
    if (cmd === 'status') {
      const icon = stateIcon[res.state] || '?';
      info(`  ${icon} ${name.padEnd(8)} ${res.state}`);
    } else {
      const icon = res.action === 'error' ? '✗'
                  : res.action === 'skip' ? '·'
                  : (res.action.startsWith('would-') ? '?' : '✓');
      const detail = res.reason ? ` — ${res.reason}` : '';
      info(`  ${icon} ${name.padEnd(8)} ${res.action}${detail}`);
      if (res.diff && flags.dryRun) info(res.diff);
    }
  }
  info('');
}

const SUBCOMMANDS = ['install', 'update', 'uninstall', 'status'];
if (!SUBCOMMANDS.includes(subcommand)) {
  fail(`unknown subcommand: ${subcommand}. Use one of: ${SUBCOMMANDS.join(' / ')}`);
}

const results = runCommand(subcommand);
printResults(subcommand, results);
