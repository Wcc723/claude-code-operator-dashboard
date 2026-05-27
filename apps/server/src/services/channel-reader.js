import { readdir, readFile, writeFile, stat, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import matter from 'gray-matter';
import { tlog, tstart } from './trace.js';

export const IDENTITY_FILES = [
  'CLAUDE.md',
  'IDENTITY.md',
  'SOUL.md',
  'USER.md',
  'MEMORY.md',
];

const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

function assertSafeSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    const err = new Error(`invalid slug: ${slug}`);
    err.status = 400;
    err.code = 'INVALID_SLUG';
    throw err;
  }
  return slug;
}

export class ChannelReader {
  constructor(channelPath) {
    if (!channelPath) throw new Error('CHANNEL_PATH is required');
    this.root = resolve(channelPath);
    if (!existsSync(this.root)) {
      throw new Error(`CHANNEL_PATH does not exist: ${this.root}`);
    }
  }

  _skillsDir() { return join(this.root, '.claude', 'skills'); }
  _agentsDir() { return join(this.root, '.claude', 'agents'); }
  _tasksDir() { return join(this.root, 'tasks'); }
  _memoryDir() { return join(this.root, 'memory'); }

  async listSkills() {
    const dir = this._skillsDir();
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(dir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      const raw = await readFile(skillFile, 'utf8');
      const parsed = matter(raw);
      const st = await stat(skillFile);
      skills.push({
        name: parsed.data.name ?? entry.name,
        slug: entry.name,
        description: parsed.data.description ?? '',
        triggers_zh: parsed.data.triggers_zh ?? [],
        triggers_en: parsed.data.triggers_en ?? [],
        model: parsed.data.model ?? null,
        context: parsed.data.context ?? null,
        'disable-model-invocation': parsed.data['disable-model-invocation'] ?? false,
        'user-invocable': parsed.data['user-invocable'] ?? true,
        mtime: st.mtimeMs,
      });
    }
    return skills.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async getSkill(slug) {
    assertSafeSlug(slug);
    const file = join(this._skillsDir(), slug, 'SKILL.md');
    if (!existsSync(file)) return null;
    const raw = await readFile(file, 'utf8');
    const parsed = matter(raw);
    const st = await stat(file);
    return {
      slug,
      path: file,
      frontmatter: parsed.data,
      body: parsed.content,
      raw,
      mtime: st.mtimeMs,
    };
  }

  async saveSkill(slug, { frontmatter, body, expectedMtime }) {
    assertSafeSlug(slug);
    const file = join(this._skillsDir(), slug, 'SKILL.md');
    if (!existsSync(file)) throw new Error(`skill not found: ${slug}`);
    await this._safeWrite(file, frontmatter, body, expectedMtime);
    return this.getSkill(slug);
  }

  async listAgents() {
    const T = tstart('listAgents');
    const dir = this._agentsDir();
    if (!existsSync(dir)) { T.end({ n: 0, reason: 'no-dir' }); return []; }
    const filesT = tstart('listAgents');
    const files = (await readdir(dir)).filter(f => f.endsWith('.md'));
    filesT.end({ stage: 'readdir', n: files.length });
    const agents = [];
    let slowestMs = 0;
    let slowestFile = '';
    for (const file of files) {
      const full = join(dir, file);
      const fT = tstart('listAgents');
      const raw = await readFile(full, 'utf8');
      const parsed = matter(raw);
      const st = await stat(full);
      const ms = fT.elapsed();
      if (ms > slowestMs) { slowestMs = ms; slowestFile = file; }
      agents.push({
        name: parsed.data.name ?? basename(file, '.md'),
        slug: basename(file, '.md'),
        description: parsed.data.description ?? '',
        model: parsed.data.model ?? null,
        color: parsed.data.color ?? null,
        tools: parsed.data.tools ?? [],
        background: parsed.data.background ?? false,
        isolation: parsed.data.isolation ?? null,
        permissionMode: parsed.data.permissionMode ?? null,
        effort: parsed.data.effort ?? null,
        mtime: st.mtimeMs,
      });
    }
    if (slowestMs > 100) {
      tlog('listAgents', `⚠️  slowest file ${slowestFile} took ${slowestMs.toFixed(0)}ms`);
    }
    T.end({ n: files.length, slowestMs: slowestMs.toFixed(0) });
    return agents.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async getAgent(slug) {
    assertSafeSlug(slug);
    const file = join(this._agentsDir(), `${slug}.md`);
    if (!existsSync(file)) return null;
    const raw = await readFile(file, 'utf8');
    const parsed = matter(raw);
    const st = await stat(file);
    return {
      slug,
      path: file,
      frontmatter: parsed.data,
      body: parsed.content,
      raw,
      mtime: st.mtimeMs,
    };
  }

  async saveAgent(slug, { frontmatter, body, expectedMtime }) {
    assertSafeSlug(slug);
    const file = join(this._agentsDir(), `${slug}.md`);
    if (!existsSync(file)) throw new Error(`agent not found: ${slug}`);
    await this._safeWrite(file, frontmatter, body, expectedMtime);
    return this.getAgent(slug);
  }

  async listTasks() {
    const dir = this._tasksDir();
    if (!existsSync(dir)) return [];
    const files = (await readdir(dir)).filter(f => f.endsWith('.md'));
    const tasks = [];
    for (const file of files) {
      const full = join(dir, file);
      const raw = await readFile(full, 'utf8');
      const parsed = matter(raw);
      const st = await stat(full);
      tasks.push({
        name: parsed.data.name ?? basename(file, '.md'),
        slug: basename(file, '.md'),
        schedule: parsed.data.schedule ?? null,
        enabled: parsed.data.enabled ?? null,
        channel: parsed.data.channel ?? null,
        mtime: st.mtimeMs,
      });
    }
    return tasks.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async getTask(slug) {
    assertSafeSlug(slug);
    const file = join(this._tasksDir(), `${slug}.md`);
    if (!existsSync(file)) return null;
    const raw = await readFile(file, 'utf8');
    const parsed = matter(raw);
    const st = await stat(file);
    return {
      slug,
      path: file,
      frontmatter: parsed.data,
      body: parsed.content,
      raw,
      mtime: st.mtimeMs,
    };
  }

  async saveTask(slug, { frontmatter, body, expectedMtime }) {
    assertSafeSlug(slug);
    const file = join(this._tasksDir(), `${slug}.md`);
    if (!existsSync(file)) throw new Error(`task not found: ${slug}`);
    await this._safeWrite(file, frontmatter, body, expectedMtime);
    return this.getTask(slug);
  }

  async listMemoryDays({ limit = null } = {}) {
    const dir = this._memoryDir();
    if (!existsSync(dir)) return [];
    const files = (await readdir(dir))
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse();
    const sliced = limit ? files.slice(0, limit) : files;
    const out = [];
    for (const file of sliced) {
      const full = join(dir, file);
      const st = await stat(full);
      out.push({
        date: basename(file, '.md'),
        mtime: st.mtimeMs,
        size: st.size,
      });
    }
    return out;
  }

  async getMemoryDay(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid date format');
    const file = join(this._memoryDir(), `${date}.md`);
    if (!existsSync(file)) return null;
    const raw = await readFile(file, 'utf8');
    const parsed = matter(raw);
    const st = await stat(file);
    return {
      date,
      path: file,
      frontmatter: parsed.data,
      body: parsed.content,
      raw,
      mtime: st.mtimeMs,
    };
  }

  async listIdentityFiles() {
    const out = [];
    for (const name of IDENTITY_FILES) {
      const file = join(this.root, name);
      if (!existsSync(file)) continue;
      const st = await stat(file);
      out.push({ name, path: file, mtime: st.mtimeMs, size: st.size });
    }
    return out;
  }

  async getIdentityFile(name) {
    if (!IDENTITY_FILES.includes(name)) return null;
    const file = join(this.root, name);
    if (!existsSync(file)) return null;
    const raw = await readFile(file, 'utf8');
    const st = await stat(file);
    return {
      name,
      path: file,
      body: raw,
      mtime: st.mtimeMs,
    };
  }

  async saveIdentityFile(name, { body, expectedMtime }) {
    if (!IDENTITY_FILES.includes(name)) {
      const err = new Error(`identity file not allowed: ${name}`);
      err.code = 'NOT_ALLOWED';
      throw err;
    }
    const file = join(this.root, name);
    if (!existsSync(file)) {
      const err = new Error(`identity file not found: ${name}`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    await this._safeWritePlain(file, body ?? '', expectedMtime);
    return this.getIdentityFile(name);
  }

  async _safeWritePlain(file, body, expectedMtime) {
    if (expectedMtime != null) {
      const st = await stat(file);
      const diff = Math.abs(st.mtimeMs - Number(expectedMtime));
      if (diff > 5) {
        const err = new Error('CONFLICT: file changed since last read');
        err.code = 'CONFLICT';
        throw err;
      }
    }
    const tmp = join(dirname(file), `.${basename(file)}.tmp`);
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, file);
  }

  async _safeWrite(file, frontmatter, body, expectedMtime) {
    if (expectedMtime != null) {
      const st = await stat(file);
      const diff = Math.abs(st.mtimeMs - Number(expectedMtime));
      if (diff > 5) {
        const err = new Error('CONFLICT: file changed since last read');
        err.code = 'CONFLICT';
        throw err;
      }
    }
    const composed = matter.stringify(body ?? '', frontmatter ?? {});
    const tmp = join(dirname(file), `.${basename(file)}.tmp`);
    await writeFile(tmp, composed, 'utf8');
    await rename(tmp, file);
  }
}
