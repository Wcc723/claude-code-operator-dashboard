# AGENTS.md

給在這個 repo 工作的 AI agent（Claude Code、Codex）。**要帶人安裝，請照 [docs/agent-install.md](docs/agent-install.md) 從「步驟 0」開始。**

## 這是什麼

Fancy CODD：跑在一台常駐 Mac 上的單人管理介面。用 Google 登入的網頁開 Claude Code session（node-pty），管理 PROJECTS（啟動設定）與 STATION（channel 的 skills、agents、tasks、memory、Kanban），顯示 session 狀態燈與 Claude / Codex 週用量。對外只經由 Cloudflare Tunnel + Access。

## 目錄

| 路徑 | 內容 |
|---|---|
| `apps/server` | Express API。`src/routes/`、`src/services/`（auth-gate、terminal-manager、claude-setup、claude-accounts、codex-accounts、bin-resolve…）、`src/db/`（`schema.sql` + `index.js` 的 `migrate()`） |
| `apps/web` | Vite + Vue 3 SPA（`src/views/`、`src/components/`、`src/stores/`），production 時由 server 提供 `dist/` |
| `apps/mcp` | stdio MCP server `codd-manager`，重用 server 的 services |
| `scripts/` | `setup-cli.js`（user-level hooks + statusline）、`channel-cli.js`（channel 擴充） |
| `configs/` | `hooks/status-writer.js`、`statusline/codd-statusline.js`、`agents/`、OAuth 與 Cloudflare 文件 |
| `docs/` | `agent-install.md`（安裝手冊） |

server、web（Vite）、scripts 都讀根目錄 `.env`（範例見 `.env.example`）；`apps/mcp` 不讀 `.env`，只吃 `scripts/channel-cli.js` 寫進 `<channel>/.mcp.json` 的 env。新增環境變數時一併寫進 `.env.example`。

## 常用指令

```bash
npm install
npm run dev                                  # Express :3000 + Vite :5173
npm run build                                # apps/web/dist
npm start                                    # NODE_ENV=production 時同時提供網頁
node scripts/setup-cli.js status --json      # hooks / statusline 狀態（唯讀）
node scripts/channel-cli.js status           # channel 擴充狀態（唯讀）
```

目前沒有自動化測試。改完至少：

- `node --check <改過的 .js>`；動到前端就跑 `npm run build`。
- 要實際起 server 時，用別的 port 和暫存資料庫（環境變數優先於 `.env`）：
  `PORT=3901 KANBAN_DB_PATH="$TMPDIR/codd-test.db" node apps/server/src/index.js`
  例外：安裝流程（`docs/agent-install.md` 步驟 5）的試跑會用真正的 `.env` 與資料庫確認設定能啟動，但一樣換到沒被佔用的 port（3901 起）。
- 動到 setup 邏輯時，用暫存檔測：`node scripts/setup-cli.js install --dry-run --settings "$TMPDIR/settings.json" --channel "$TMPDIR/codd-channel"`。
  不帶 `--dry-run` 實測時也一定要帶 `--settings` 與 `--channel` 指到暫存目錄（或加 `--only hooks,statusline`），否則 `legacy` 部分會改到 `.env` 裡真正的 `<CHANNEL_PATH>/.claude/settings.json`。

## 慣例

- ESM（`"type": "module"`），Node >= 20。UI 文字、註解、文件用繁體中文（台灣用語）。
- `schema.sql` 只有 `CREATE … IF NOT EXISTS`；舊資料庫要補欄位，寫在 `db/index.js` 的 `migrate()`，每一步都要能重跑。
- 呼叫外部 CLI（cswap、codex）一律經過 `bin-resolve.js` 的 `resolveBin` / `childEnv`，因為 launchd 下 PATH 很短。
- 寫 `~/.claude/settings.json` 只能透過 `claude-setup.js`（有備份、原子寫入、只動 `hooks` 與 `statusLine`）。

## 安全規則

- **不要切換真實帳號**：不要執行 `cswap switch|add|remove|run|purge`、`codex login`、`codex logout`，也不要呼叫 `POST /api/accounts/claude/switch`、`POST /api/accounts/codex/switch`、`POST /api/accounts/codex/save-current`、`DELETE /api/accounts/codex/:id`。`codex logout` 會到 OpenAI 撤銷登入。
- **不要碰憑證**：不要讀、改或印出 `~/.codex/auth.json`、`~/.claude.json`、`~/.claude/` 裡的憑證檔、`~/.fancy-codd/`、`~/.cloudflared/`、`/Library/LaunchDaemons/com.cloudflare.cloudflared.plist`（ProgramArguments 裡有 tunnel token，`ps` 與 `launchctl print system/com.cloudflare.cloudflared` 也看得到，改用 `pgrep -x cloudflared`）。測試帳號功能時把 `CODEX_HOME`、`CODD_CODEX_VAULT` 指到暫存目錄。
- **不要印出 `.env` 的值**：只看 key 名稱，例如 `grep -oE '^[A-Z_]+=' .env`。
- **不要佔用 3000 / 5173 做臨時測試**：那可能是正在用的 server 或人類的 dev server，改用其他 port。
- **資料庫實驗用副本**：`sqlite3 apps/server/data/kanban.db ".backup '$TMPDIR/kanban-copy.db'"`，再把 `KANBAN_DB_PATH` 指過去。
- **不要重啟常駐的 server**（`launchctl kickstart` / `bootout`）除非人類同意：重啟會結束所有執行中的 Claude session。
- `HOST` 保持 `127.0.0.1`，不要讓 server 直接對外。
- 只在人類要求時 commit 或 push。
