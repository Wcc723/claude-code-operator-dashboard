import { parseColor, sanitizeColor } from './colors.js';

// launch profile（UI 上叫 Project）：在哪個資料夾、用什麼指令開 session，外加一個標記色（新 session 會繼承）
export class LaunchProfileRepo {
  constructor(db) { this.db = db; }

  list() {
    return this.db
      .prepare('SELECT * FROM launch_profiles ORDER BY name')
      .all()
      .map(this._normalise);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM launch_profiles WHERE id = ?').get(id);
    return row ? this._normalise(row) : null;
  }

  create({ name, command, cwd, env = {}, color = null }) {
    if (!name) throw httpError(400, 'name required');
    if (!command) throw httpError(400, 'command required');
    if (!cwd) throw httpError(400, 'cwd required');
    const colorKey = parseColor(color); // 不合法 → throw（status 400）
    try {
      const info = this.db
        .prepare('INSERT INTO launch_profiles (name, command, cwd, env_json, color) VALUES (?, ?, ?, ?, ?)')
        .run(name, command, cwd, JSON.stringify(env || {}), colorKey);
      return this.get(info.lastInsertRowid);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw httpError(409, `name "${name}" already exists`);
      throw e;
    }
  }

  update(id, changes) {
    const cur = this.get(id);
    if (!cur) return null;
    // 有帶但是空字串：跟 create 一樣擋掉（沒帶 = 不改）
    for (const key of ['name', 'command', 'cwd']) {
      if (changes[key] !== undefined && changes[key] !== null && !changes[key]) throw httpError(400, `${key} required`);
    }
    const next = {
      name: changes.name ?? cur.name,
      command: changes.command ?? cur.command,
      cwd: changes.cwd ?? cur.cwd,
      env: changes.env ?? cur.env,
      // undefined = 不改；null / '' / 'none' = 清掉；其他不合法 → 400
      color: changes.color === undefined ? cur.color : parseColor(changes.color),
    };
    try {
      this.db
        .prepare(`UPDATE launch_profiles SET name=?, command=?, cwd=?, env_json=?, color=?, updated_at=datetime('now') WHERE id=?`)
        .run(next.name, next.command, next.cwd, JSON.stringify(next.env || {}), next.color, id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw httpError(409, `name "${next.name}" already exists`);
      throw e;
    }
    return this.get(id);
  }

  delete(id) {
    const info = this.db.prepare('DELETE FROM launch_profiles WHERE id = ?').run(id);
    return info.changes > 0;
  }

  _normalise(row) {
    return {
      ...row,
      env: row.env_json ? JSON.parse(row.env_json) : {},
      env_json: undefined,
      // 舊 DB migration 前的列 / 手動改壞的值 → null，不讓前端拿到白名單外的 key
      color: sanitizeColor(row.color),
    };
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
