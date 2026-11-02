# AGENTS.md

給在這個 repo 工作的 AI agent（Claude Code、Codex）。**要帶人安裝，請照 [docs/agent-install.md](docs/agent-install.md) 從「步驟 0」開始。**

## 這是什麼

Fancy CODD：跑在一台常駐 Mac 上的單人管理介面。用 Google 登入的網頁開 Claude Code session（node-pty），管理 PROJECTS（啟動設定）與 STATION（channel 的 skills、agents、tasks、memory、Kanban），顯示 session 狀態燈與 Claude / Codex 週用量，並托管 Claude 發布的 ARTIFACTS（HTML 頁面與設計畫布，CODD 開的 session 自動掛上 `codd-artifacts` MCP）。對外只經由 Cloudflare Tunnel + Access。

## 目錄

| 路徑 | 內容 |
|---|---|
| `apps/server` | Express API。`src/routes/`、`src/services/`（auth-gate、terminal-manager、claude-setup、claude-accounts、codex-accounts、bin-resolve…）、`src/db/`（`schema.sql` + `index.js` 的 `migrate()`） |
| `apps/server`：artifact 後端 | `services/artifact-repo.js`（SQLite、canvas spec 與回覆 payload 的驗證與限長、草稿的已讀差異 `diffPayload`）、`artifact-frame.js`（frame 文件 + bridge script + sandbox CSP）、`artifact-notifier.js`（提交後等 session 閒置，在終端機打一行 `[CODD]` 通知）、`artifact-mcp.js`（`codd-artifacts` 的 5 個工具）、`mcp-tokens.js`（per-session / host bearer token、`--mcp-config` 與自動允許的 `--settings` 檔）；`routes/artifacts.js`（`/api/artifacts`，經過 `protect`）、`routes/mcp.js`（`/api/mcp`，stateless Streamable HTTP，只收 bearer token + 本機直連）；`terminal-manager.js` 的 `buildSpawnCommand` 負責往 `claude` 指令接 flag |
| `apps/web` | Vite + Vue 3 SPA（`src/views/`、`src/components/`、`src/stores/`），production 時由 server 提供 `dist/` |
| `apps/web`：artifact 前端 | `views/ArtifactsList.vue`（`/artifacts`）、`views/ArtifactView.vue`（`/artifact/:id`，standalone 版面）、`components/artifact/`（ArtifactFrame、CanvasBoard、留言、提交）、`lib/artifact-bridge.js`（跟 iframe 的 postMessage 協定）、`lib/canvas-viewport.js`（畫布平移縮放）、`stores/artifact-draft.js`（草稿與提交） |
| `apps/web`：終端機 | `composables/terminalPool.js`（xterm 實例池、連結偵測、OSC 8 連結、`linkAtPoint`／`listLinks`）、`components/TerminalPane.vue`（點連結、觸控點擊）、`lib/terminal-touch.js`（觸控捲動與 `isTap`）、`lib/terminal-links.js`（純函式：找網址、接回軟／硬換行）、`lib/link-actions.js`（只開 http(s)、複製含後備）、`components/TerminalLinkSheet.vue`（開啟／複製的浮層與底部面板、連結清單） |
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
- 要實際起 server 時，用別的 port、暫存資料庫與暫存資料目錄（環境變數優先於 `.env`）：
  `PORT=3901 KANBAN_DB_PATH="$TMPDIR/codd-test.db" CODD_DATA_DIR="$TMPDIR/codd-data" node apps/server/src/index.js`
  沒帶 `CODD_DATA_DIR` 時，host token、MCP 設定檔與 session log 會寫進真正的 `apps/server/data/`，啟動時的清理也會刪到正在跑的 server 發出的 MCP 設定檔。
  例外：安裝流程（`docs/agent-install.md` 步驟 5）的試跑會用真正的 `.env` 與資料庫確認設定能啟動，但一樣換到沒被佔用的 port（3901 起）。
- 動到 setup 邏輯時，用暫存檔測：`node scripts/setup-cli.js install --dry-run --settings "$TMPDIR/settings.json" --channel "$TMPDIR/codd-channel"`。
  不帶 `--dry-run` 實測時也一定要帶 `--settings` 與 `--channel` 指到暫存目錄（或加 `--only hooks,statusline`），否則 `legacy` 部分會改到 `.env` 裡真正的 `<CHANNEL_PATH>/.claude/settings.json`。

## 慣例

- ESM（`"type": "module"`），Node >= 20。UI 文字、註解、文件用繁體中文（台灣用語）。
- `schema.sql` 只有 `CREATE … IF NOT EXISTS`；舊資料庫要補欄位，寫在 `db/index.js` 的 `migrate()`，每一步都要能重跑。
- 呼叫外部 CLI（cswap、codex）一律經過 `bin-resolve.js` 的 `resolveBin` / `childEnv`，因為 launchd 下 PATH 很短。
- 寫 `~/.claude/settings.json` 只能透過 `claude-setup.js`（有備份、原子寫入、只動 `hooks` 與 `statusLine`）。
- 終端機連結：只有 `http:`／`https:` 能開（`lib/terminal-links.js` 的 `webTarget`，去掉 `@` 前面的帳號資訊，`window.open` 帶 `noopener,noreferrer`），其他協定只能複製；網址顯示用文字插值，不用 `v-html`。OSC 8 連結的字跟網址主機不同時，⌘／Ctrl+點也要先給浮層，不直接開。
- Artifact：HTML 只能經 frame 路由進 sandbox iframe（不加 `allow-same-origin`、`allow-top-navigation`，SPA 不拿原始 HTML、不用 `v-html`）；MCP token 不能出現在 log、API 回應、錯誤訊息或 `_toJson`；打進終端機的只有按提交時的固定模板通知，草稿不通知也不打字，使用者的回覆只能透過工具讀；`artifact_drafts.updated_at` 是併發檢查的版本標記，標已讀不能動它。

## 安全規則

- **不要切換真實帳號**：不要執行 `cswap switch|add|remove|run|purge`、`codex login`、`codex logout`，也不要呼叫 `POST /api/accounts/claude/switch`、`POST /api/accounts/codex/switch`、`POST /api/accounts/codex/save-current`、`DELETE /api/accounts/codex/:id`。`codex logout` 會到 OpenAI 撤銷登入。
- **不要碰憑證**：不要讀、改或印出 `~/.codex/auth.json`、`~/.claude.json`、`~/.claude/` 裡的憑證檔、`~/.fancy-codd/`、`~/.cloudflared/`、`/Library/LaunchDaemons/com.cloudflare.cloudflared.plist`（ProgramArguments 裡有 tunnel token，`ps` 與 `launchctl print system/com.cloudflare.cloudflared` 也看得到，改用 `pgrep -x cloudflared`）。測試帳號功能時把 `CODEX_HOME`、`CODD_CODEX_VAULT` 指到暫存目錄。
- **artifact MCP 的 token 也是憑證**：不要讀或印出 `apps/server/data/mcp-host-token` 與 `apps/server/data/mcp/<id>.json`（`codd-artifacts.settings.json` 不含 token），不要帶真正的 token 呼叫 `/api/mcp`，也不要自己執行 `claude mcp add` 把 host token 寫進人類的 Claude 設定。
- **測試絕對不要啟動真正的 `claude`**：會用掉人類的帳號額度、觸發 user-level hooks。測 PTY、artifact MCP 或通知時用假的 shell + 假的 claude：
  - 起測試 server 時帶 `SHELL=<假 shell>`（TerminalManager 用 `$SHELL -i -c "<指令>"` 開 session）。假 shell 忽略 `-i`（不讀 `~/.zshrc`，免得 PATH 又被改回真正的 claude），把放了 stub `claude` 的目錄排在 PATH 最前面，確認 `command -v claude` 是那支 stub 才 `exec /bin/sh -c "$1"`，否則直接結束。
  - stub `claude` 可以讀 `--mcp-config` 拿 URL 與 token 呼叫 MCP、把 stdin 一行行印回來（看得到打進去的 `[CODD]` 通知），也可以寫 hook 狀態檔回報 idle。token 只放記憶體，不要印。
  - 同時把 `CODD_DATA_DIR`（per-session 與 host token、MCP 設定檔、session log）、`KANBAN_DB_PATH`、`STATUS_DIR_PATH`（stub 回報的狀態）都指到暫存目錄，launch profile 的指令在暫存資料庫裡設。
  - 只測 `buildSpawnCommand` 時當純函式測，不要 spawn；只需要一個會動的 PTY 時，profile 指令用 `cat`。
- **不要印出 `.env` 的值**：只看 key 名稱，例如 `grep -oE '^[A-Z_]+=' .env`。
- **不要佔用 3000 / 5173 做臨時測試**：那可能是正在用的 server 或人類的 dev server，改用其他 port。
- **資料庫實驗用副本**：`sqlite3 apps/server/data/kanban.db ".backup '$TMPDIR/kanban-copy.db'"`，再把 `KANBAN_DB_PATH` 指過去。
- **不要重啟常駐的 server**（`launchctl kickstart` / `bootout`）除非人類同意：重啟會結束所有執行中的 Claude session。
- `HOST` 保持 `127.0.0.1`，不要讓 server 直接對外。
- 只在人類要求時 commit 或 push。
