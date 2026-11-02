import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

export function openDb(dbPath) {
  if (db) return db;
  const absPath = resolve(dbPath);
  mkdirSync(dirname(absPath), { recursive: true, mode: 0o700 });
  db = new Database(absPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // DB 含 revoked_sessions / launch_profiles（含 shell command），鎖只給 owner 讀寫
  try { chmodSync(absPath, 0o600); } catch (e) { /* best-effort */ }

  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);

  const columnCount = db.prepare('SELECT COUNT(*) AS c FROM kanban_columns').get().c;
  if (columnCount === 0) {
    const insert = db.prepare('INSERT INTO kanban_columns (id, name, position) VALUES (?, ?, ?)');
    insert.run(1, 'Todo', 0);
    insert.run(2, 'In Progress', 1);
    insert.run(3, 'Done', 2);
  }

  const profileCount = db.prepare('SELECT COUNT(*) AS c FROM launch_profiles').get().c;
  if (profileCount === 0) {
    db.prepare(
      'INSERT INTO launch_profiles (name, command, cwd, env_json) VALUES (?, ?, ?, ?)'
    ).run(
      'claude-station',
      'claude --channels plugin:discord@claude-plugins-official',
      '~/Claude-station',
      '{}'
    );
  }

  return db;
}

// schema.sql 全是 CREATE ... IF NOT EXISTS：表已存在時不會補新欄位，舊 DB 要在這裡自己 ALTER。
// 每一步都要能重跑（先看欄位在不在）。
function migrate(db) {
  addColumnIfMissing(db, 'launch_profiles', 'color', 'TEXT');
  // 已讀狀態是新功能：之前留在舊版本的草稿（切版本時內容已經帶走，甚至已經提交）不該一次全部變成「未讀」。
  // 只在真的補上 read_payload 的那一次把它們標成讀過；欄位已經在就不動，重跑不會蓋掉之後的狀態
  db.transaction(() => {
    if (addColumnIfMissing(db, 'artifact_drafts', 'read_payload', 'TEXT')) {
      addColumnIfMissing(db, 'artifact_drafts', 'read_at', 'TEXT');
      db.prepare(`UPDATE artifact_drafts SET read_payload = payload, read_at = ?
        WHERE version < (SELECT current_version FROM artifacts WHERE artifacts.id = artifact_drafts.artifact_id)`)
        .run(new Date().toISOString());
    }
    addColumnIfMissing(db, 'artifact_drafts', 'read_at', 'TEXT');
  })();
}

// → true = 這一次真的加了欄位
function addColumnIfMissing(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return false;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    return true;
  } catch (e) {
    // server 與 MCP（apps/mcp 也呼叫 openDb）同時開同一個舊 DB 時，另一邊可能剛好先加了
    if (!/duplicate column name/i.test(String(e.message))) throw e;
    return false;
  }
}

export function getDb() {
  if (!db) throw new Error('DB not opened. Call openDb(path) first.');
  return db;
}
