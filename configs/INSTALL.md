# 擴充 Channel — Hooks & Sub-agents 安裝指南

Fancy CODD 提供兩個可選的「注入式擴充」給 channel：

| 模組 | 內容 |
|---|---|
| **hooks** | `PostToolUse` hook，把 session 狀態（last tool / tool count / idle）寫進 `STATUS_FILE_PATH`，讓平台 sidebar widget 顯示 |
| **agents** | sub-agent `frontmatter-doctor`，體檢 channel 內所有 agents / skills 的 frontmatter |
| **mcp** | 把 `codd-manager` MCP server 掛進 channel 的 `.mcp.json`，agent 可呼叫 list_skills / kanban_* / get_agent_schema 等 |

社長用一個 CLI 管整套生命週期，**完全不用手動編 JSON**。

> **hooks 模組已由 user-level 安裝取代。** session 狀態改由下方的 `npm run setup` 裝在 `~/.claude/settings.json`，對所有由 app 開的 session 生效；channel 級的 PostToolUse hook 會和它重複觸發，`npm run setup -- install` 會順手移除（`legacy`）。`npm run channel install` / `update` 現在預設跳過 hooks 模組（只有明確 `--only hooks` 才會裝回舊的那條）；`npm run channel uninstall` 仍會清掉它。

---

## User-level 設定：session 狀態與用量（npm run setup）

### 為什麼要裝

側欄與底部面板要顯示的這些資訊，只有 Claude Code 自己知道，得靠它的 hooks 與 statusline 回報：

| 想看到的 | 來源 |
|---|---|
| session 在忙 / **等你輸入**（權限確認、AskUserQuestion、plan 核准）/ 閒置 | hooks |
| Claude 標題（`/rename` 自訂名稱）、最近一次 prompt | hooks（`SessionStart` / `UserPromptSubmit`） |
| Claude 標題、context 剩餘 % | statusline |
| 5h / 1w 用量與重置時間 | statusline（`rate_limits`） |

資料寫在 `STATUS_DIR_PATH`（預設 `~/.claude/codd-status/`）底下的 `term/` 與 `usage/`，server 只讀不寫。

### 一定要在跑 server 的機器上執行

安裝改的是 **那台機器（Mac mini）** 的 `~/.claude/settings.json`。在筆電上跑 CLI 只會改到筆電自己的設定，沒有用。兩種方式擇一：

- 網頁：打開 `/setup`（首頁未完成設定時也會出現引導），勾選 → **預覽變更** → **安裝**。動作由 server 執行，所以從手機操作也是改 Mac mini 的設定。
- CLI：SSH 到 Mac mini，在 repo 根目錄執行 `npm run setup -- …`（會讀同一份 `.env`，`STATUS_DIR_PATH` / `CHANNEL_PATH` 與 server 一致）。

```bash
npm run setup -- status                     # 看狀態與「最近收到資料」時間（不寫檔）
npm run setup -- install --dry-run          # 預覽：只列出會被動到的 hooks / statusLine 子樹
npm run setup -- install                    # 安裝或更新
npm run setup -- install --only statusline  # 只裝其中一部分
npm run setup -- uninstall                  # 移除
```

| Flag | 用途 |
|---|---|
| `--only hooks,statusline,legacy` | 只動指定部分（預設全部） |
| `--dry-run` | 只印預覽，不寫檔 |
| `--settings <path>` | 改其他 settings 檔（例如另一個 `CLAUDE_CONFIG_DIR` 帳號：`--settings ~/.claude-work/settings.json`） |
| `--channel <path>` | 覆蓋 `.env` 的 `CHANNEL_PATH`（legacy 檢查用） |
| `--node <path>` | 指定 hook / statusline 用的 node（預設是執行 CLI 的 node） |
| `--json` | 輸出 JSON |

### 會改什麼

只動 `hooks` 底下 10 個 event 的陣列與 `statusLine`，其他 key（`env`、`permissions`、`model`、你原本的 hooks…）一律不碰。寫入前會在原檔旁邊備份成 `settings.json.codd-bak-YYYYMMDDHHmmss`，再以暫存檔 + rename 原子寫入。重複執行不會重複加，已是最新就完全不寫檔。

**hooks**：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`Notification`、`Stop`、`StopFailure`、`SessionEnd` 各 **附加** 一組（不取代你原本的 hook）：
（`PostToolUseFailure` 是後來加的：工具失敗時 Claude Code 只送它、不送 `PostToolUse`，少了它狀態會卡在「等你核准」。舊的安裝 `status` 會顯示 `outdated`，再跑一次 `install` 即可。）

```json
{
  "matcher": "*",
  "hooks": [{
    "type": "command",
    "command": "[ -z \"$CODD_TERMINAL_ID\" ] || [ ! -x '/path/to/node' ] || [ ! -f '/abs/repo/configs/hooks/status-writer.js' ] || STATUS_DIR_PATH='/Users/<you>/.claude/codd-status' '/path/to/node' '/abs/repo/configs/hooks/status-writer.js'",
    "timeout": 5
  }]
}
```

- `matcher: "*"` 只寫在 `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `PermissionRequest` / `Notification`；依官方文件，省略 matcher 也是 match-all，其他 event 就不寫。
- **非 app 開的 session 幾乎零成本**：app spawn 的 PTY 才有 `CODD_TERMINAL_ID`；其他 session（你在 Terminal.app 直接開的 `claude`）在 shell 判斷這一步就結束，不會啟動 node。
- node 或 script 不見了（nvm 移除舊版、repo 搬走）時，`[ ! -x … ]` / `[ ! -f … ]` 讓指令直接結束，不會每個 event 都跳 hook error。
- 用 `command` 內含 `status-writer.js` 辨識是不是 CODD 裝的。

**statusLine**：

- 原本 **沒有** statusline → 裝成 standalone：`if [ -x '<node>' ] && [ -f '<script>' ]; then STATUS_DIR_PATH='…' '<node>' '<repo>/configs/statusline/codd-statusline.js'; else :; fi`，顯示一行簡易狀態（資料夾 · model · ctx · 5h 剩餘）。
- 原本 **已有** statusline（例如 RayAgentHub 的 wrapper）→ 裝成 wrapped：then 那段後面加 `--chain-b64 <原指令的 base64>`，else 那段是 `/bin/sh -c '<原指令>'`。CODD 先記錄資料，再把同一份 stdin 交給原指令執行並原樣輸出，**畫面跟原本一模一樣**；node 或 script 不見時直接跑原指令，**原本的 statusline 不會消失**。`padding`、`refreshInterval` 等其他欄位保留。已經包過的不會再包第二層。
- statusline 對 **每個** session 都會跑（用量要從任何一個 session 取得），只做同步讀寫小檔、不連網。

**legacy**：舊版 `npm run channel install` 在 `CHANNEL_PATH/.claude/settings.json` 的 `PostToolUse` 裝過一條 status-writer hook。新的 user-level hook 裝好後兩者會重複觸發，`install` 會把舊的那條移除（同樣先備份，其他 hook 保留）。

### 怎麼還原

```bash
npm run setup -- uninstall                   # 移除 CODD hooks；statusline 還原成原本那條（原本沒有就刪掉）
npm run setup -- uninstall --only statusline # 只還原 statusline
```

網頁 `/setup` 也有「移除」按鈕。想完全回到某個時間點，直接用備份覆蓋：

```bash
ls ~/.claude/settings.json.codd-bak-*
cp ~/.claude/settings.json.codd-bak-20261012153000 ~/.claude/settings.json
```

`uninstall` 不會把 legacy hook 裝回去。

### 注意事項

- 指令寫的是當下 node 與 repo 的 **絕對路徑**（Homebrew 會改用 `/opt/homebrew/bin/node` 或 `<prefix>/opt/<formula>` 這類不帶版本號的路徑）。用 nvm 換 node 版本、或搬動 repo 後，`status` 會顯示 `outdated` 或「設定裡的 node 已不存在」，再跑一次 `install` 即可。在那之前 CODD 的 hooks / 用量紀錄會暫停，但原本的 statusline 照常顯示、也不會跳 hook error。網頁安裝用的是 server 的 node，CLI 用的是執行 CLI 的 node；兩者不同時，以最後一次安裝為準。
- Claude Code 會監看 settings 檔並自動重新載入，大多數已開著的 session 不用重開；沒生效就重開該 session。
- 若 settings 裡 `disableAllHooks` 是 `true`，hooks 與 statusline 都不會執行，`status` 會提示。
- 不同帳號用不同 `CLAUDE_CONFIG_DIR` 時，每個目錄的 `settings.json` 都要各裝一次（`--settings`）。
- `status` 的「最近收到資料」來自 `term/*.hook.json`、`term/*.statusline.json`、`usage/*.json` 的修改時間；裝好後在 app 開一個 session 送一句 prompt，就應該會更新。

---

## 前置作業

1. 完成根目錄 `.env`（至少 `CHANNEL_PATH=...` 跟 `STATUS_FILE_PATH=...`）
2. `npm install` 過

---

## 4 個 subcommand

### 1. 看狀態 — 不寫任何 file

```bash
npm run channel status
```

輸出範例：
```
channel: /path/to/your-channel

  ✗ hooks    missing
  ✗ agents   missing
  ✗ mcp      missing
```

### 2. 安裝 — 把三個模組部署進 channel

```bash
# 先 dry-run 看會動到什麼
npm run channel install -- --dry-run

# 確認後實裝
npm run channel install
```

行為：
- 已安裝的條目直接 skip（idempotent）
- `.claude/settings.json` 加 `hooks.PostToolUse` 一條，command 帶 `STATUS_FILE_PATH=... node <abs>/configs/hooks/status-writer.js`
- `.claude/agents/frontmatter-doctor.md` 從範本 copy 過去（含 `codd:managed` marker）
- `.mcp.json` 加 `mcpServers.codd-manager`，env 帶你 .env 內的 `KANBAN_DB_PATH`

### 3. 升級 — Fancy CODD 升版後同步 channel

```bash
npm run channel update
```

- 對含 `codd:managed` marker 的 agent 強制覆蓋成最新範本
- Hook command 的絕對路徑同步更新（避免搬 repo 後失效）
- `.mcp.json` 的 codd-manager 條目同步成最新 args / env

### 4. 卸載 — 移除注入內容

```bash
# 軟卸載：移 settings.json / .mcp.json 條目；agent file 保留但 marker 改 unmanaged
npm run channel uninstall

# 硬卸載：連 agent file 也刪
npm run channel uninstall -- --purge
```

---

## 共通 flags

| Flag | 用途 |
|---|---|
| `--channel <path>` | 覆蓋 `.env` 的 `CHANNEL_PATH` |
| `--only hooks,agents,mcp` | 只動其中幾個（逗號分隔） |
| `--dry-run` | 只印 diff 不寫 |
| `--force` | install 時強制覆蓋已存在的 agent file |
| `--purge` | uninstall 時連 agent file 一起刪 |

---

## 範本身份識別

CLI 透過 marker 區分「自己裝的」vs「社長手寫的」：

- **Hooks**: command 內含 `status-writer.js` 字串 + description 含 `[codd:status-writer]`
- **Agents**: file 內含 `<!-- codd:managed source=... -->` 註解
- **MCP**: `mcpServers.codd-manager` key

`uninstall` / `update` 只動帶 marker 的條目。社長手寫的其他 hook / agent / mcp server **不會被誤改**。

---

## Troubleshooting

### `npm run channel status` 顯示 hook 已裝，但 status file 沒更新

1. 確認 Claude Code session 有 reload `.claude/settings.json`（重啟 session 一次）
2. 在 session 內跑任一 tool（例如 `Read`），看 `cat $STATUS_FILE_PATH` 有沒有新 timestamp
3. Hook 命令手測：`echo '{"session_id":"test","tool_name":"Read"}' | STATUS_FILE_PATH=/tmp/codd-test.json node configs/hooks/status-writer.js`，再 `cat /tmp/codd-test.json`

### `@frontmatter-doctor` 找不到 schema

代表 `codd-manager` MCP 沒掛上。確認：
- `npm run channel status` 顯示 `mcp synced`
- Claude Code session 啟動時有 detect 到新 MCP（重啟一次）
- 平台 server 不需要起就好（MCP 是 stdio，直接 spawn）

### CLI 對 `.mcp.json` 報 JSON parse 錯

CLI 不破壞檔案。先看 `.bak` 備份（CLI 寫前會建）：`<channel>/.mcp.json.bak`。

---

## 手動 fallback（不想用 CLI）

如果你想完全手動操作，三件事：

1. **Hook** — 編 `<channel>/.claude/settings.json`，加：
   ```json
   "hooks": {
     "PostToolUse": [{
       "matcher": ".*",
       "command": "STATUS_FILE_PATH=/Users/<you>/.claude/codd-status.json node /abs/path/configs/hooks/status-writer.js"
     }]
   }
   ```

2. **Agent** — `cp configs/agents/frontmatter-doctor.md <channel>/.claude/agents/`

3. **MCP** — 編 `<channel>/.mcp.json`：
   ```json
   {
     "mcpServers": {
       "codd-manager": {
         "command": "node",
         "args": ["/abs/path/apps/mcp/src/index.js"],
         "env": {
           "CHANNEL_PATH": "<channel-abs>",
           "KANBAN_DB_PATH": "<from .env>"
         }
       }
     }
   }
   ```
