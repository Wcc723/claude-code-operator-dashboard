# Fancy CODD 安裝手冊（給 Agent 照著做）

這份文件寫給 AI coding agent（Claude Code、Codex）閱讀並執行。人類先完成下面的「開始之前」，再對 agent 說一句「請讀 docs/agent-install.md，帶我安裝 CODD」，agent 從「步驟 0」開始，一路帶到驗收。

**完成時的樣子**：一台常駐的 Mac（下稱「主機」，例如 Mac mini）用 launchd 跑著 Fancy CODD server，外部從 `https://<hostname>` 進來，先過 Cloudflare Access，再用 Google 帳號登入；可以開 Claude Code session，側欄狀態燈會跟著變，底部顯示 Claude 的 1w 週用量。

## 開始之前（人類在主機的「終端機」App 操作）

agent 要在 repo 裡才讀得到這份文件，所以這幾步由人類先做：

1. 安裝 Xcode Command Line Tools（含 git）：執行 `xcode-select --install`，在跳出的對話框按「安裝」。
2. 安裝 Claude Code 並登入：執行 `curl -fsSL https://claude.ai/install.sh | bash`，開一個新的終端機視窗，執行一次 `claude` 照畫面登入。想改用 Codex 帶安裝也可以，但主機上仍然要有登入過的 `claude`（CODD 開的 session 就是它）。
3. clone repo。位置**不要**放在 `~/Documents`、`~/Desktop`、`~/Downloads` 或 iCloud 底下：這些資料夾受 macOS 隱私權保護，launchd 跑的 server 讀不到。

   ```bash
   mkdir -p ~/Github && git clone https://github.com/Wcc723/claude-code-operator-dashboard.git ~/Github/fancy-codd && cd ~/Github/fancy-codd
   ```

   repo 是私有的話，先設定好 GitHub 存取權（例如 SSH key 或 `gh auth login`）。
4. 在這個資料夾執行 `claude`（或 `codex`），貼上：`請讀 docs/agent-install.md，帶我安裝 CODD`

## 給 Agent 的規則

1. **在主機上執行。** 所有指令都在主機的 repo 根目錄執行，標明「人類在瀏覽器」的步驟除外。開始前一次問完兩件事：
   - 「現在這台就是要常駐跑 CODD 的 Mac 嗎？」不是的話（例如筆電），請人類改到主機上開 agent 或用 SSH 連過去，不要在筆電上安裝。
   - 「你有 Cloudflare 帳號，而且有一個網域已經加進去、狀態是 Active 嗎？」沒有的話給兩個選擇：(a) 先暫停，等人類把網域加進 Cloudflare、改好 nameserver、dashboard 顯示 Active（可能要等幾小時）再繼續；(b) 只在主機本機使用：不設 `TUNNEL_HOSTNAME`，步驟 4 的 origin 改填 `http://localhost:<PORT>` 與 `http://localhost`，跳過步驟 8、9，步驟 12 在主機上用 Chrome 開 `http://localhost:<PORT>`。之後要對外時再補做步驟 8、9，並把 hostname 加進 OAuth origins。
2. **只向人類要只有他能給的東西**（見下表），其餘自己做、自己驗證。同一步需要的值一次問完。
3. **寫入 repo 以外的位置之前，先取得人類同意。** 包含：安裝工具（Homebrew、`brew install`、`uv tool install`、`npm install -g`、`curl … | sh` 這類安裝程式，先列出要裝的全部項目，一次取得同意）、`~/.zshrc` 等 shell 設定檔、`~/Library/LaunchAgents/`（步驟 6）、`~/.claude/settings.json` 與 `<CHANNEL_PATH>/.claude/settings.json`（步驟 7，後者是 legacy 清除）、CHANNEL_PATH 裡的其他檔案（步驟 11）、任何 `sudo`、Cloudflare 帳號上的資源。能 dry-run 的先 dry-run，把結果摘要給人類看。repo 內的 `.env`、`configs/cloudflared.yml`、`apps/web/dist`、`apps/server/data/` 可以直接寫。
4. **不要顯示任何秘密。** 不要 `cat .env`，不要印出 `SESSION_SECRET`（直接產生並寫進 `.env`）。不要讀或印 `~/.codex/auth.json`、`~/.claude.json`、`~/.cloudflared/`、`/etc/cloudflared/`、`~/.fancy-codd/`，也不要讀或印 `apps/server/data/mcp-host-token` 與 `apps/server/data/mcp/` 裡的 `.json`（artifact MCP 的 bearer token，只能看是否存在與權限）。檢查 `.env` 一律用步驟 0 的檢查程式（只印狀態與 hostname，不印秘密值）。
   - Cloudflare tunnel token 不要讓人類貼進對話，也不要直接打在指令列（會留在 `~/.zsh_history`）。人類在 dashboard 複製 token 後，自己在主機終端機執行 `sudo cloudflared service install "$(pbpaste)"`。
   - 用 token 安裝的 cloudflared 服務會把 token 放在 `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` 的 ProgramArguments，也會出現在 `launchctl print system/com.cloudflare.cloudflared` 與 `ps` 的指令列。不要 `cat`、`plutil -p`、`grep` 這個 plist，不要執行 `launchctl print system/com.cloudflare.cloudflared`，不要 `ps aux | grep cloudflared`（改用 `pgrep -x cloudflared`）。檢查服務只用 `ls` 與 `sudo launchctl list | grep cloudflared`，排錯只看 `/Library/Logs/com.cloudflare.cloudflared.err.log`（另有 `.out.log`）。
5. **絕對不要執行**：`cswap switch|add|remove|run|purge`、`codex login`（請人類自己做）、`codex logout`（會到 OpenAI 撤銷登入，帳號庫裡存的副本跟著失效）、`cloudflared tunnel delete`，也不要刪除 `apps/server/data/` 或任何 settings 備份。
6. **不要把 server 直接開到網路上。** `HOST` 維持 `127.0.0.1`，不要改成 `0.0.0.0`，也不要設定路由器轉 port。對外只能走 Cloudflare Tunnel，而且要先加 Access。
7. **重啟 server 會結束所有執行中的 Claude session**（server 關閉時會終止所有 PTY）。步驟 6 完成後，任何重啟都要先問人類。
8. **中斷後如何續做**：每一步都可以重跑，也都附「驗證」。重新開始時先跑步驟 0，照決策表跳到第一個沒過的步驟。
9. CLI 直接用 `node scripts/setup-cli.js …` 與 `node scripts/channel-cli.js …` 執行。改用 `npm run` 的話，`--dry-run`、`--only` 這類 flag 必須寫在 `--` 後面，否則會被 npm 吃掉而腳本照樣執行（`npm run channel install --dry-run` 會變成真的安裝）。channel CLI 的子指令一定要放在第一個參數。
10. `configs/INSTALL.md` 後半段（channel 級 hook、`STATUS_FILE_PATH`）是舊版說明，跟本文件衝突時以本文件為準。

### 需要人類提供或操作的項目

| 項目 | 用途 | 步驟 |
|---|---|---|
| 完成「開始之前」：Xcode Command Line Tools、安裝並登入 `claude`、clone repo | 全部 | 開始前 |
| 確認這台是主機；確認有 Cloudflare 帳號與 Active 的網域 | 全部 | 開始前 |
| 同意要安裝的工具；選擇 Node 的安裝方式，需要時自己裝 Homebrew 或 Node 的 `.pkg`（要輸入管理者密碼） | Node、cloudflared、uv | 1、9、10 |
| `claude` 沒登入時，在主機終端機執行一次 `claude` 登入 | session | 1 |
| `ALLOWED_EMAIL`：唯一能登入的 Google 帳號 | `.env`、Access policy | 3 |
| `CHANNEL_PATH`：channel 資料夾的絕對路徑（沒有可以新建；不能在受保護的資料夾） | `.env` | 3 |
| 對外 hostname，例如 `codd.example.com`（網域必須已經在他的 Cloudflare 帳號） | OAuth origin、Access、Tunnel | 3 |
| 在 Google Cloud Console 建 OAuth Client，貼回 Client ID | `GOOGLE_CLIENT_ID` | 4 |
| 主機自動登入（FileVault 開著時要先決定關不關）、不自動睡眠（系統設定） | 常駐 | 6 |
| Cloudflare Zero Trust Access 設定 | Access | 8 |
| Cloudflare dashboard 建 tunnel、自己執行 `sudo cloudflared service install "$(pbpaste)"` | Tunnel | 9 |
| `cswap add`、`codex login`（選用） | 用量面板 | 10 |
| 用瀏覽器登入 CODD、開 session、送一句 prompt | 驗收 | 12 |
| 在 CODD 開的 session 請 Claude 發布一個 artifact，再開它給的連結（選用） | 驗收 Artifact | 12 |

## 步驟 0：偵測現況（唯讀）

在 repo 根目錄整段執行。全部唯讀，不會印出秘密值（hostname 不是秘密，會印出來）。`.env` 與「hooks / statusline」兩段都需要 `node_modules`：還沒 `npm install` 時，`.env` 段改用 `grep -oE '^[A-Z_]+=' .env` 看有哪些 key，hooks 段會印 `hooks: skip`。

```bash
echo "== 工具 =="
node -v; npm -v; git --version; xcode-select -p 2>&1
for b in node claude cswap codex cloudflared uv brew; do printf '%-12s %s\n' "$b" "$(command -v "$b" || echo '-')"; done
printf '%-12s %s\n' 'shell node' "$("$SHELL" -i -c 'command -v node' 2>/dev/null | tail -1)"
printf '%-12s %s\n' 'shell claude' "$("$SHELL" -i -c 'command -v claude' 2>/dev/null | tail -1)"
"$SHELL" -i -c 'claude auth status --json' 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v="unknown";try{v=JSON.parse(s.slice(s.indexOf("{"))).loggedIn}catch{}console.log("claude login".padEnd(12),v)})'
echo "== 位置 =="
case "$PWD" in "$HOME"/Documents*|"$HOME"/Desktop*|"$HOME"/Downloads*|"$HOME/Library/Mobile Documents"*) echo "repo location: PROTECTED ($PWD)";; *) echo "repo location: ok ($PWD)";; esac
echo "== 主機常駐 =="
fdesetup status 2>&1 | head -1
defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser >/dev/null 2>&1 && echo "autologin: on" || echo "autologin: off"
pmset -g | awk '$1=="sleep"{print "system sleep:",$2}'
echo "== 相依套件 =="
node -e "require('better-sqlite3');require('@homebridge/node-pty-prebuilt-multiarch');console.log('native modules ok')" 2>&1 | tail -1
echo "== build =="
test -f apps/web/dist/index.html && echo "dist ok" || echo "dist missing"
CID=$(grep -E '^GOOGLE_CLIENT_ID=' .env 2>/dev/null | cut -d= -f2-)
if test -f apps/web/dist/index.html && test -n "$CID"; then grep -qF "$CID" apps/web/dist/assets/*.js 2>/dev/null && echo "dist client id ok" || echo "dist client id stale"; fi
echo "== .env =="
test -f .env || echo ".env missing"
test -f .env && stat -f '.env mode          %Lp' .env
test -f .env && ! test -d node_modules/dotenv && echo ".env: 詳細檢查要等步驟 2"
test -f .env && test -d node_modules/dotenv && node -e '
const fs=require("fs"),path=require("path"),os=require("os");
const e=require("dotenv").parse(fs.readFileSync(".env"));
const ph=/^(x{6,}|replace_me|you@example\.com|\/path\/to\/|\/Users\/you\/|changeme$|change_me$|secret$)/;
const req=["CHANNEL_PATH","GOOGLE_CLIENT_ID","ALLOWED_EMAIL","SESSION_SECRET"];
for(const k of [...req,"KANBAN_DB_PATH","STATUS_DIR_PATH"]){const v=e[k]||"";
  console.log(k.padEnd(18),!v?(req.includes(k)?"MISSING":"(unset, default)"):ph.test(v)?"PLACEHOLDER":"ok")}
console.log("SECRET >= 32 chars".padEnd(18),(e.SESSION_SECRET||"").length>=32);
const c=e.CHANNEL_PATH||"";console.log("CHANNEL dir/.claude".padEnd(18),!!c&&fs.existsSync(c),"/",!!c&&fs.existsSync(path.join(c,".claude")));
const prot=["Documents","Desktop","Downloads","Library/Mobile Documents"].map(d=>path.join(os.homedir(),d));
const cr=c&&path.resolve(c);console.log("CHANNEL location".padEnd(18),!c?"-":prot.some(p=>cr===p||cr.startsWith(p+"/"))?"PROTECTED":"ok");
console.log("NODE_ENV".padEnd(18),e.NODE_ENV||"(unset)");
console.log("PORT / HOST".padEnd(18),(e.PORT||"3000")+" / "+(e.HOST||"127.0.0.1"));
const h=e.TUNNEL_HOSTNAME||"";console.log("TUNNEL_HOSTNAME".padEnd(18),!h||/example\.com$/.test(h)?"MISSING/PLACEHOLDER":h);
const db=path.resolve(e.KANBAN_DB_PATH||"apps/server/data/kanban.db");
console.log("DB file".padEnd(18),fs.existsSync(db)?"exists":"missing");'
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2); PORT=${PORT:-3000}
echo "== server (port $PORT) =="
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2
curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || echo "health: no response"
echo; echo "== hooks / statusline =="
if test -d node_modules/dotenv; then
  node scripts/setup-cli.js status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("complete="+j.complete,"hooks="+j.hooks.state,"statusline="+j.statusline.state,"legacy="+j.legacy.present,"warnings="+j.warnings.length,"error="+j.error)})'
else echo "hooks: skip（先做步驟 2）"; fi
echo "== launchd / tunnel =="
ls ~/Library/LaunchAgents/com.fancy-codd.server.plist 2>/dev/null || echo "server agent: none"
launchctl print "gui/$(id -u)/com.fancy-codd.server" 2>/dev/null | grep -E '^\s*(state|pid|last exit code) =' || echo "server agent: not loaded"
ls /Library/LaunchDaemons/com.cloudflare.cloudflared.plist 2>/dev/null || echo "cloudflared service: none"
pgrep -x cloudflared >/dev/null && echo "cloudflared process: running" || echo "cloudflared process: none"
ls configs/cloudflared.yml 2>/dev/null || echo "configs/cloudflared.yml: none"
echo "== 外部 =="
H=$(grep -E '^TUNNEL_HOSTNAME=' .env 2>/dev/null | cut -d= -f2)
case "$H" in ""|*example.com) echo "external health: skip（TUNNEL_HOSTNAME 未設）";; *) echo "external health: $(curl -s -o /dev/null --max-time 8 -w '%{http_code}' "https://$H/api/health")";; esac
```

### 決策表

由上往下找第一個符合的列。

| 看到 | 跳到 |
|---|---|
| `repo location: PROTECTED` | 先請人類把 repo 搬到例如 `~/Github`，在新位置重開 agent 再從步驟 0 開始。已經做過步驟 3 以後的步驟時，照步驟 6「失敗時」的搬移順序補做 |
| 沒有 `node`、版本低於 20 或是 21；`node` 與 `shell node` 的路徑不同；`xcode-select` 報錯；`shell claude` 空白；`claude login` 不是 `true` | 步驟 1 |
| `native modules` 那行是錯誤訊息；`hooks: skip`；`.env: 詳細檢查要等步驟 2` | 步驟 2 |
| `.env missing`；`.env mode` 不是 `600`；`CHANNEL_PATH`、`ALLOWED_EMAIL`、`SESSION_SECRET`、`KANBAN_DB_PATH`、`STATUS_DIR_PATH` 任一為 `MISSING`/`PLACEHOLDER`；`CHANNEL dir` 為 false；`CHANNEL location` 為 `PROTECTED`；`NODE_ENV` 不是 `production`；`TUNNEL_HOSTNAME` 為 `MISSING/PLACEHOLDER`（只在本機使用時略過這一項） | 步驟 3 |
| `GOOGLE_CLIENT_ID` 為 `MISSING` 或 `PLACEHOLDER` | 步驟 4 |
| `dist missing`、`dist client id stale`、`DB file missing` | 步驟 5 |
| `lsof` 有輸出但 health 不是 `{"ok":true}` | 疑難排解「port 被佔用」 |
| `server agent: none` 或 `not loaded` | 步驟 6（還沒試跑過就先做步驟 5） |
| server agent 已載入，但 `state` 不是 `running`、`last exit code` 是非 0 的數字，或 `health: no response` | 步驟 6 的「失敗時」（看 `~/Library/Logs/fancy-codd-server.log`） |
| `FileVault is On`、`autologin: off` 或 `system sleep` 不是 `0`，而人類還沒做過決定 | 步驟 6 的「主機常駐」 |
| `complete=false` 或 `warnings` 大於 0 | 步驟 7 |
| `external health: 200` | **網站正在公開、沒有 Access**：立刻做步驟 8 |
| `external health: 000` | hostname 還沒接到 tunnel：人類確認過步驟 8 的 Access 已建立就做步驟 9，否則先做步驟 8 |
| `external health: 502` | server 沒在跑或 Tunnel 指到錯的 port：步驟 6、步驟 9 的「失敗時」 |
| `external health: 530`（頁面顯示 1033） | connector 沒連上：步驟 9 的「失敗時」 |
| `external health:` 是 `302`、`skip` 以外的其他值 | 步驟 9 的「失敗時」 |
| 以上全部通過（`external health: 302`，或只在本機使用時為 `skip`） | 步驟 12，然後問人類要不要做 10、11 與步驟 12 的「選用：Artifact」 |

步驟 9 只看外部檢查：`cloudflared service`、`configs/cloudflared.yml` 這些檔案存在不代表 tunnel 有通，也可能是別條 tunnel 留下的。

## 步驟 1：前置工具

- **目的**：主機有 Node（package.json `engines` 要求 `>=20`）、編譯工具、git、登入過的 `claude`，而且 agent、互動式 shell、launchd 用的是**同一支** node。
- **需要人類**：Xcode Command Line Tools 安裝對話框；同意要安裝的工具（規則 3）；選擇 Node 的安裝方式，需要時自己裝 Homebrew 或 Node 的 `.pkg`（要輸入管理者密碼）；`claude` 沒登入時自己執行一次 `claude` 登入。

**Node**：支援 20、22、24（better-sqlite3 12 支援 20、22、23、24、25、26，不支援 21）。已經有支援的版本，而且步驟 0 的 `node` 與 `shell node` 路徑相同，就沿用。沒有的話請人類選一種：

| 方式 | 做法 | node 路徑 |
|---|---|---|
| A. nodejs.org 安裝檔（乾淨的 Mac 建議用這個） | 人類到 <https://nodejs.org/> 下載 Node 24 LTS 的 macOS `.pkg` 並安裝 | `/usr/local/bin/node` |
| B. Homebrew | 沒有 `brew` 時，人類先照 <https://brew.sh/> 安裝 Homebrew（要管理者密碼）。之後 agent 取得同意再執行 `brew install node@24`，並把 `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` 加進 `~/.zshrc` | `/opt/homebrew/opt/node@24/bin/node`（keg-only，不加 PATH 就找不到；升級小版本路徑也不變） |
| C. nvm（主機本來就在用 nvm 時） | agent 取得同意後 `nvm install 24`。`nvm alias default 24` 會改掉主機上所有專案的預設 Node，要另外問 | `~/.nvm/versions/node/v24.x.x/bin/node`（升級小版本路徑會變） |

選定後固定，之後換 Node 要重做步驟 2、6、7。

| 工具 | 檢查 | 沒有時 |
|---|---|---|
| Xcode Command Line Tools（含 git、python3） | `xcode-select -p` 有路徑 | `xcode-select --install`，請人類按「安裝」。node-pty、better-sqlite3 找不到對應 Node 版本的預編譯檔時會現場編譯，沒有它就裝不起來 |
| claude CLI | 步驟 0 的 `shell claude` 有路徑、`claude login` 是 `true` | 沒裝：取得同意後 `curl -fsSL https://claude.ai/install.sh \| bash`。`false` 或 `unknown`：請人類在主機終端機執行一次 `claude` 完成登入 |

server 用 `$SHELL -i -c "<指令>"` 開 session，所以 `node` 與 `claude` 必須能被「互動式 shell」找到，不能只在 agent 自己的 PATH 上。確認兩邊是同一支 node：

```bash
printf 'agent: %s\nshell: %s\n' "$(command -v node)" "$("$SHELL" -i -c 'command -v node' 2>/dev/null | tail -1)"
```

- **驗證**：上面兩行路徑相同，`node -v` 的主版本在支援清單內；步驟 0 的 `shell claude` 有路徑、`claude login` 是 `true`。
- **失敗時**：
  - 兩行路徑不同 → 以 `shell` 那支為準（session 與 MCP 都用它）。請人類在新的終端機視窗重開 agent，或之後的指令都改用那支 node 的絕對路徑。
  - nvm 在非互動 shell 找不到時先 `source ~/.nvm/nvm.sh`。
  - `shell claude` 空白 → `~/.zshrc` 沒把 `~/.local/bin` 加進 PATH，請人類同意後補上。

## 步驟 2：安裝相依套件

- **目的**：裝好 npm workspaces（server、web、mcp），並編譯原生模組 better-sqlite3 與 node-pty。
- **需要人類**：無。

```bash
npm install
node -e "require('better-sqlite3');require('@homebridge/node-pty-prebuilt-multiarch');console.log('native modules ok')"
```

- 不要加 `--ignore-scripts`：原生模組靠套件自己的 install script 編譯，repo 沒有 postinstall。
- **驗證**：印出 `native modules ok`。
- **失敗時**：`gyp ERR!` 或 `No Xcode or CLT version detected` → 回步驟 1 裝 CLT；`NODE_MODULE_VERSION` 不符 → 用之後 launchd 會用的那支 node 執行 `npm rebuild better-sqlite3 @homebridge/node-pty-prebuilt-multiarch`。

## 步驟 3：收集資訊並寫入 `.env`

- **目的**：server 啟動所需的設定。server、setup CLI、channel CLI、Vite 都只讀根目錄 `.env`；`apps/mcp` 不讀 `.env`，它的值由步驟 11 寫進 `.mcp.json`。`apps/web/.env` 不需要建立，Vite 不會讀它。
- **需要人類**（一次問完）：`ALLOWED_EMAIL`、`CHANNEL_PATH`、對外 hostname（只在本機使用時不用給）。
  - CHANNEL_PATH 是 CODD 管理的 Claude Code 工作資料夾，裡面可以有 `.claude/skills/`、`.claude/agents/`、`tasks/`、`memory/`。server 只要求資料夾存在；步驟 11 另外要求有 `.claude/`。人類沒有的話，建議（取得同意後）`mkdir -p ~/Claude-station/.claude`，資料庫預設的 project `claude-station` 也是用這個路徑。
  - CHANNEL_PATH 跟 repo 一樣不能放在 `~/Documents`、`~/Desktop`、`~/Downloads` 或 iCloud 底下。寫入前先檢查：

```bash
C="<人類給的絕對路徑>"
case "$C" in "$HOME"/Documents*|"$HOME"/Desktop*|"$HOME"/Downloads*|"$HOME/Library/Mobile Documents"*) echo "CHANNEL_PATH: PROTECTED，請人類換位置";; *) test -d "$C" && echo "CHANNEL_PATH: ok" || echo "CHANNEL_PATH: 資料夾不存在";; esac
```

先建立 `.env`、收緊權限、產生 `SESSION_SECRET`（已有有效值就不動，不會印出來）：

```bash
test -f .env || cp .env.example .env; chmod 600 .env
node -e '
const fs=require("fs"),f=".env";let s=fs.readFileSync(f,"utf8");
const cur=(s.match(/^SESSION_SECRET=(.*)$/m)||[])[1]||"";
if(cur.length>=32&&!/^replace_me/.test(cur)){console.log("SESSION_SECRET: 已有有效值，不動");process.exit(0)}
const v=require("crypto").randomBytes(32).toString("hex");
s=/^SESSION_SECRET=.*$/m.test(s)?s.replace(/^SESSION_SECRET=.*$/m,()=>"SESSION_SECRET="+v):s.replace(/\n*$/,"\n")+"SESSION_SECRET="+v+"\n";
fs.writeFileSync(f,s);fs.chmodSync(f,0o600);console.log("SESSION_SECRET: 已寫入（長度 "+v.length+"）")'
```

再用 `setenv` 寫其他值。它會取代同名的行（包含被註解掉的 `# KEY=`），沒有就加在檔尾。每次 shell 呼叫都是新的 shell，所以函式要和使用它的指令寫在**同一個**指令區塊（步驟 4、10 也附了同樣的定義；其他地方用到 `setenv` 時，要先貼上這個函式）：

```bash
setenv() { node -e '
const [k,v]=process.argv.slice(1),fs=require("fs");let s=fs.readFileSync(".env","utf8");
const re=new RegExp("^#?\\s*"+k+"=.*$","m");
s=re.test(s)?s.replace(re,()=>k+"="+v):s.replace(/\n*$/,"\n")+k+"="+v+"\n";
fs.writeFileSync(".env",s);console.log("set "+k)' "$1" "$2"; }
setenv CHANNEL_PATH "<人類給的絕對路徑>"
setenv ALLOWED_EMAIL "<人類給的 email>"
setenv NODE_ENV production
setenv KANBAN_DB_PATH "$PWD/apps/server/data/kanban.db"
setenv STATUS_DIR_PATH "$HOME/.claude/codd-status"
setenv TUNNEL_HOSTNAME "<hostname>"     # 只在本機使用時刪掉這行（範例值會被當成未設）
```

| 變數 | 來源 | 說明 |
|---|---|---|
| `CHANNEL_PATH` | 人類 | **必填**。絕對路徑且必須存在，否則 server 拒絕啟動 |
| `GOOGLE_CLIENT_ID` | 步驟 4 | **必填** |
| `ALLOWED_EMAIL` | 人類 | **必填**。大小寫不拘 |
| `SESSION_SECRET` | agent 產生 | **必填**。少於 32 字元或是範例值時 server 拒絕啟動 |
| `NODE_ENV` | `production` | 實務上必填。沒有它 server 不提供網頁（只剩 API），cookie 也不加 Secure |
| `KANBAN_DB_PATH` | repo 內絕對路徑 | 範例檔是 `/path/to/...` 佔位值，不改會啟動失敗。也可以刪掉該行用預設 `apps/server/data/kanban.db` |
| `STATUS_DIR_PATH` | `~/.claude/codd-status` | 範例檔是 `/Users/you/...` 佔位值，不改的話 hook 寫不進去。也可以刪掉該行用預設值 |
| `PORT` | 預設 3000 | 被別的程式佔用就換一個，Tunnel 的目標要跟著改 |
| `HOST` | 預設 `127.0.0.1` | 不要改 |
| `SESSION_TTL_DAYS` | 預設 7 | 登入有效天數 |
| `TUNNEL_HOSTNAME` | hostname | 本手冊以它為準：步驟 0 用它做外部檢查，步驟 8、9、12 的 `<hostname>` 都是它。server 也用它組 artifact 連結（沒設 `CODD_PUBLIC_URL` 時是 `https://<hostname>/artifact/<id>`）。只在本機使用時不設，並把 `.env` 裡範例的 `TUNNEL_HOSTNAME=codd.example.com` 刪掉或註解掉（步驟 0 會把範例值當成未設，server 組連結時則會照用） |
| `CODD_PUBLIC_URL`、`CODD_ARTIFACTS_MCP`、`CODD_ARTIFACTS_AUTO_ALLOW`、`CODD_ARTIFACT_NOTIFY_UNKNOWN`、`CODD_ARTIFACT_MAX_BYTES` | 不用設 | Artifact 的選填設定，預設值就能用。說明見 [README 的 Artifact 段](../README.md#設定env皆選填) |
| `CSWAP_BIN`、`CODEX_BIN`、`CODEX_HOME`、`CODD_CODEX_VAULT` | 步驟 10 | 選填 |
| `CLAUDE_CONFIG_DIR` | 預設 `~/.claude` | 只有人類本來就用自訂 Claude 設定目錄時才設；會傳給 session，步驟 7 也會改裝到 `$CLAUDE_CONFIG_DIR/settings.json` |
| `VITE_GOOGLE_CLIENT_ID` | 不要設 | 前端與 server 必須用同一個 Client ID（server 只認 `GOOGLE_CLIENT_ID` 為 audience），設成不同值會登入 401 `Wrong recipient` |

- **驗證**：重跑步驟 0 的 `.env` 段：除了 `GOOGLE_CLIENT_ID` 之外都是 `ok`，`.env mode` 是 `600`，`NODE_ENV` 是 `production`，`CHANNEL dir/.claude` 至少第一個是 true，`CHANNEL location` 是 `ok`，`TUNNEL_HOSTNAME` 印出 hostname。
- **失敗時**：`CHANNEL dir` 為 false → 路徑打錯或資料夾還沒建立；`CHANNEL location` 為 `PROTECTED` → 請人類把 channel 資料夾搬出受保護的位置，再重設 `CHANNEL_PATH`。

## 步驟 4：Google OAuth Client ID（人類在瀏覽器）

- **目的**：拿到登入用的 Client ID。本系統用 Google Identity Services 的 ID token，**不需要 client secret**。
- **需要人類**：照 [configs/google-oauth-setup.md](../configs/google-oauth-setup.md) 在 [Google Cloud Console](https://console.cloud.google.com/) 操作。把下面這些值直接告訴人類：

| 欄位 | 值 |
|---|---|
| 同意畫面 User type / Audience | External；保持 Testing 狀態即可，不用發布 |
| App name / Support email | `Fancy CODD` / 人類自己的 email |
| Test users | `ALLOWED_EMAIL` |
| Client 類型 | Web application |
| Authorized JavaScript origins | `https://<hostname>`；只在本機使用時改填 `http://localhost:<PORT>` 與 `http://localhost`；要在主機跑 `npm run dev` 才另加 `http://localhost:5173` |
| Authorized redirect URIs | 留空 |

選單名稱可能是舊版的「APIs & Services → OAuth consent screen / Credentials」，或新版的「Google Auth Platform → Branding / Audience / Clients」。

**只要帶回 Client ID**（`<數字>-<亂碼>.apps.googleusercontent.com`）。Client ID 不是秘密，可以貼在對話裡；client secret 不要貼。拿到後：

```bash
setenv() { node -e '
const [k,v]=process.argv.slice(1),fs=require("fs");let s=fs.readFileSync(".env","utf8");
const re=new RegExp("^#?\\s*"+k+"=.*$","m");
s=re.test(s)?s.replace(re,()=>k+"="+v):s.replace(/\n*$/,"\n")+k+"="+v+"\n";
fs.writeFileSync(".env",s);console.log("set "+k)' "$1" "$2"; }
setenv GOOGLE_CLIENT_ID "<client id>"
grep -cE '^GOOGLE_CLIENT_ID=[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$' .env
```

- **驗證**：grep 印出 `1`。
- **注意**：Client ID 同時用在兩個地方：build 時編進前端，server 啟動時讀來驗證 token。之後改了要重跑 `npm run build`，server 已在跑的話也要重啟。origin 的修改可能要等幾分鐘才生效。

## 步驟 5：初始化資料庫、build、本機試跑

- **目的**：建立 SQLite、產生前端、確認 server 能用 `.env` 正常啟動。
- **需要人類**：無。

```bash
npm --workspace apps/server run migrate   # 印出 [migrate] DB initialised at <path>；可重跑（server 每次啟動也會做同樣的事）
npm run build                             # 產生 apps/web/dist
grep -lF "$(grep -E '^GOOGLE_CLIENT_ID=' .env | cut -d= -f2)" apps/web/dist/assets/*.js   # 有印出檔名 = Client ID 已編進前端
```

試跑用 `.env` 的設定與真正的資料庫，但 port 從 3901 開始找一個沒人用的（環境變數優先於 `.env`），不會撞到已經在跑的 CODD 或人類的 dev server。這是 AGENTS.md「臨時測試用別的 port 與暫存資料庫」的例外：這裡要確認的就是真正的設定能啟動。session log 與 artifact MCP 設定檔的目錄（`CODD_DATA_DIR`）改用暫存的：server 啟動時會清掉那裡殘留的 MCP 設定檔，用真正的目錄會清到正在跑的 CODD 發給 session 的那些。

```bash
SMOKE=3901; while lsof -nP -iTCP:"$SMOKE" -sTCP:LISTEN >/dev/null; do SMOKE=$((SMOKE+1)); done
LOG="${TMPDIR:-/tmp}/codd-smoke.log"
PORT=$SMOKE CODD_DATA_DIR="${TMPDIR:-/tmp}/codd-smoke-data" node apps/server/src/index.js > "$LOG" 2>&1 & PID=$!
for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS --max-time 1 "http://127.0.0.1:$SMOKE/api/health" 2>/dev/null && break; sleep 1; done; echo
curl -s -o /dev/null -w 'GET / -> %{http_code}\n' "http://127.0.0.1:$SMOKE/"
kill $PID; wait $PID 2>/dev/null; cat "$LOG"
```

- **驗證**：印出 `{"ok":true}`、`GET / -> 200`，log 有 `[codd-server] listening on http://127.0.0.1:<試跑的 port>` 與 `closed cleanly`。
- **失敗時**：

| log 或結果 | 處理 |
|---|---|
| `GOOGLE_CLIENT_ID is required`、`ALLOWED_EMAIL is required` | 步驟 3、4 |
| `SESSION_SECRET is placeholder or too short` | 重跑步驟 3 的產生指令 |
| `CHANNEL_PATH does not exist` | 修正 CHANNEL_PATH |
| `EACCES` / `ENOENT` 且路徑以 `/path/to` 開頭 | `KANBAN_DB_PATH` 還是佔位值 |
| `GET / -> 404` | `NODE_ENV` 不是 `production`（回步驟 3 執行 `setenv NODE_ENV production`），或沒有 `apps/web/dist` |
| `EADDRINUSE` | 疑難排解「port 被佔用」 |

## 步驟 6：用 launchd 常駐 server

repo 沒有附 server 的 plist，以下是建議做法：放在使用者的 LaunchAgent，登入後自動啟動、掛掉自動重啟。用 LaunchAgent 而不是 LaunchDaemon，是因為 session 以使用者身分跑 `claude`，而 macOS 上 Claude Code 的登入憑證放在使用者的鑰匙圈。代價是要有人登入桌面 server 才會起來，所以主機需要自動登入。

- **需要人類**：同意寫入 `~/Library/LaunchAgents/com.fancy-codd.server.plist`（已經存在時先看差異）；主機常駐的設定（見下）。
- **先確認**：用的 node 必須是步驟 2 編譯原生模組時那一支，也就是步驟 1 確認過的 `command -v node`。

**主機常駐**：先跑唯讀檢查，結果給人類看。

```bash
fdesetup status | head -1
defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser >/dev/null 2>&1 && echo "autologin: on" || echo "autologin: off"
pmset -g | awk '$1=="sleep"{print "system sleep:",$2}'
```

- `FileVault is On`：macOS 開著 FileVault 時不能自動登入，而新的 Mac 預設是開的。請人類二選一：(a) 到「系統設定 → 隱私權與安全性 → FileVault」關閉，關完再開自動登入；(b) 保留 FileVault，接受每次重開機後都要有人在主機輸入一次密碼登入，server 才會起來（步驟 12 #9 的預期跟著改）。
- `autologin: off`（FileVault 已關）：請人類到「系統設定 → 使用者與群組」的「自動以此身分登入」選自己的帳號。
- `system sleep` 不是 `0`：請人類到「系統設定 → 能源」（舊版叫「能源節約器」）打開「顯示器關閉時防止自動進入睡眠」（Prevent automatic sleeping when the display is off）。筆電要接著電源，設定在「電池 → 選項」。

**產生 plist**：先寫到 repo 內的暫存檔（`apps/server/data/` 不進 git），跟現有的比對：

```bash
REPO="$PWD"; NODE="$(command -v node)"; LABEL=com.fancy-codd.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"; NEW="$REPO/apps/server/data/$LABEL.plist.new"; LOG="$HOME/Library/Logs/fancy-codd-server.log"
mkdir -p "$REPO/apps/server/data"
cat > "$NEW" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$REPO/apps/server/src/index.js</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>SHELL</key><string>${SHELL:-/bin/zsh}</string>
    <key>LANG</key><string>${LANG:-en_US.UTF-8}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
plutil -lint "$NEW" && if [ -e "$PLIST" ]; then diff "$PLIST" "$NEW" && echo "跟現有 plist 相同"; else echo "還沒有 plist"; fi
```

plist 已經存在而且有差異時（例如人類自己改過 `EnvironmentVariables`），把 diff 給人類看，取得同意才覆寫。同意後安裝（既有的 plist 會先備份到 `apps/server/data/`）：

```bash
LABEL=com.fancy-codd.server; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"; NEW="$PWD/apps/server/data/$LABEL.plist.new"
if [ -e "$PLIST" ]; then BK="$PWD/apps/server/data/$LABEL.plist.bak-$(date +%Y%m%d%H%M%S)"; cp -p "$PLIST" "$BK"; echo "既有 plist 已備份到 $BK"; fi
mkdir -p "$HOME/Library/LaunchAgents" && cp "$NEW" "$PLIST" && launchctl bootstrap "gui/$(id -u)" "$PLIST"
```

launchd 給的 PATH 很短，所以 plist 明確補上 node 所在目錄、`~/.local/bin`、`/opt/homebrew/bin`。`.env` 仍由 server 自己讀；plist 的 `EnvironmentVariables` 優先於 `.env`（dotenv 不覆蓋已存在的變數）。

- **驗證**：

```bash
PORT=$(grep -E '^PORT=' .env | cut -d= -f2); PORT=${PORT:-3000}
launchctl print "gui/$(id -u)/com.fancy-codd.server" | grep -E '^\s*(state|pid|last exit code) ='   # state = running
curl -fsS "http://127.0.0.1:$PORT/api/health"                                                          # {"ok":true}
tail -n 20 ~/Library/Logs/fancy-codd-server.log                                                        # 有 listening 那行
```

| 日常操作 | 指令 |
|---|---|
| 重啟（會結束所有 session，先問人類） | `launchctl kickstart -k gui/$(id -u)/com.fancy-codd.server` |
| 停止並移除 | `launchctl bootout gui/$(id -u)/com.fancy-codd.server` |
| 改 `.env` 後 | 重啟 |
| 改 plist 後 | `bootout` 再 `bootstrap` |
| 更新程式 | `git pull && npm install && npm run build`，再重啟 |

- **失敗時**：
  - `Bootstrap failed: 5: Input/output error` → 已經載入過（先問人類，再 `bootout`），或 plist 有誤（看 `plutil -lint`）。
  - 透過 SSH 執行時 `gui/<uid>` 網域不存在 → 主機上沒有登入中的桌面 session，請人類登入主機或開啟自動登入。
  - `state` 不是 running、`last exit code` 非 0 → 看 log，錯誤訊息同步驟 5。
  - log 出現 `Operation not permitted` → repo 或 CHANNEL_PATH 放在 `~/Documents`、`~/Desktop`、`~/Downloads` 或 iCloud 底下，受 macOS 隱私權限制（步驟 0 的 `repo location`、`CHANNEL location` 會顯示 `PROTECTED`）。請人類把資料夾搬到例如 `~/Github`（另一個做法是在系統設定給這支 node「完整磁碟取用權限」，但那等於讓所有用它跑的程式都能讀整台電腦，不建議）。很多地方寫死了絕對路徑，搬完照這個順序補做：
    1. 問過人類後 `launchctl bootout gui/$(id -u)/com.fancy-codd.server`（會結束所有 session）。
    2. 搬的是 repo：在新位置重開 agent，執行步驟 3 的 `setenv KANBAN_DB_PATH "$PWD/apps/server/data/kanban.db"`（資料庫在 repo 裡，已經跟著搬過去）。搬的是 channel：`setenv CHANNEL_PATH "<新路徑>"`，並在 PROJECTS 改掉用到舊路徑的 project。
    3. 重做步驟 6 的產生 plist 與安裝（plist 裡有 repo 路徑）。
    4. 重做步驟 7 的 `install`（hook 與 statusline 指令裡有 repo 路徑）。
    5. 有做過步驟 11 的話執行 `node scripts/channel-cli.js update`（`.mcp.json` 裡有 repo、channel 與資料庫路徑）。channel 搬了的話，舊位置的 `.mcp.json` 不會自動清掉。
  - `launchctl list` 裡的 `application.*CODD*` 是另一個桌面 App，跟這個 server 無關。

## 步驟 7：hooks 與 statusline

- **目的**：讓 Claude Code 回報 session 狀態（忙碌、等你輸入、閒置）、標題、最近 prompt、週用量。安裝位置是主機的 user-level `~/.claude/settings.json`（有設 `CLAUDE_CONFIG_DIR` 時改為 `$CLAUDE_CONFIG_DIR/settings.json`）。
- **需要人類**：看過 dry-run 之後同意寫入。

```bash
node scripts/setup-cli.js status
node scripts/setup-cli.js install --dry-run
```

把 dry-run 摘要給人類，重點：10 個 hook event 各「附加」一組 CODD hook（不取代原有的）；原本已有 statusline 時（`has_foreign: true`）會包成 wrapped 模式，畫面不變；寫入前備份成 `settings.json.codd-bak-<時間>`；這個檔案的其他設定不動。dry-run 若出現 `=== legacy · <channel>/.claude/settings.json ===`（步驟 0 的 `legacy=true`），代表 install 也會從 `<CHANNEL_PATH>/.claude/settings.json` 移除舊的 CODD status-writer hook（同樣先備份成 `.codd-bak-<時間>`），這是 repo 以外的第二個檔案，要一併告訴人類。同意後：

```bash
"$(command -v node)" scripts/setup-cli.js install     # 用跟 plist 同一支 node；不同時加 --node <plist 裡的 node>
node scripts/setup-cli.js status --json
```

- 指令裡會寫入 node 與 repo 的絕對路徑。換 Node 版本或搬 repo 後 `status` 會出現 `outdated` 或「node 已不存在」，重跑 `install` 即可。
- 人類有多個 Claude 設定目錄時，每個都要裝：`--settings <dir>/settings.json`。
- 也可以登入網頁後在 `/setup` 安裝，效果相同（用的是 server 的 node）。
- **驗證**：`complete` 為 `true`，`hooks.state` 與 `statusline.state` 都是 `installed`，`warnings` 是空陣列。「最近收到資料」要等步驟 12 送出 prompt 後才會更新。
- **失敗時**：`無法解析 JSON` 或 `不是 object` → settings 檔本身有問題，把錯誤訊息給人類看，不要自動修；`在讀取後被其他程式修改` → 重跑一次；`warnings` 提到 `disableAllHooks` → 請人類決定是否關掉。

## 步驟 8：Cloudflare Access（先把門裝好）

- **目的**：在 Cloudflare 邊緣先擋掉所有不在名單上的人，後端的 Google 登入變成第二道關卡。**一定要在步驟 9 把 hostname 接上 tunnel 之前做**，否則中間這段時間整個網站（包含開 shell 的 API）只剩 Google 登入一道關卡。hostname 還沒有 DNS 記錄也能先建 Access application。只在本機使用時跳過。
- **需要人類**：照 [configs/cloudflare-access-setup.md](../configs/cloudflare-access-setup.md) 在 [Zero Trust dashboard](https://one.dash.cloudflare.com/) 操作。直接給他這些值：

| 欄位 | 值 |
|---|---|
| Application type | Self-hosted |
| Application domain | 完全等於 `TUNNEL_HOSTNAME`，Path 留空 |
| Policy | Action `Allow`，Include → Emails → `ALLOWED_EMAIL` |
| Identity provider | One-time PIN 即可 |
| 第一次使用 | 會要求建立 team name |

- **驗證**：hostname 還沒接上 tunnel，這時 curl 驗不到。請人類確認 Access → Applications 裡有這個 application，domain 一字不差等於 `TUNNEL_HOSTNAME`、Path 空白，policy 只 Include `ALLOWED_EMAIL`。真正的檢查在步驟 9：外部必須回 `302`。
- **注意**：`/api/health` 也在 Access 後面。外部監控用 Service Token（Access policy 的 Include → Service Auth → Service Token），不要建立沒有 Access 的 hostname。人類堅持把 health 拆到另一個 hostname 時（做法見 [configs/cloudflare-access-setup.md 的「Tunnel 加 ingress 分離」](../configs/cloudflare-access-setup.md#tunnel-加-ingress-分離)；模式 A 是在 tunnel 的 dashboard 再新增一個 Public Hostname，例如 `codd-health.<domain>`，不加進 Access application）：Path 必須填 `^/api/health$`、Service 用 `http://127.0.0.1:<PORT>`，建立後驗證 `curl -s -o /dev/null -w '%{http_code}\n' https://<health-host>/` 與 `https://<health-host>/api/auth/me` 都回 `404`。Path 留空會讓整個 CODD 在那個 hostname 上沒有 Access。

## 步驟 9：Cloudflare Tunnel

- **目的**：不開任何 port，讓 `https://<hostname>` 連到主機的 `http://127.0.0.1:<PORT>`。只在本機使用時跳過。
- **先確認**：步驟 8 的 Access application 已經建立。
- **需要人類**：同意安裝 cloudflared；Cloudflare dashboard 操作；`sudo`。

| 模式 | 適合 | 做法 |
|---|---|---|
| **A. Dashboard 管理 + launchd 服務（建議）** | 常駐 | [configs/cloudflared-service-setup.md](../configs/cloudflared-service-setup.md) |
| B. 本機設定檔 + `npm run tunnel` | 測試 | [configs/cloudflared.yml.example](../configs/cloudflared.yml.example)。前景執行，關掉終端機或重開機就斷，單用它達不到常駐（步驟 12 #9）；要常駐得另外寫 launchd job，或改用模式 A |

同一條 tunnel 不要同時用兩種模式跑。

**安裝 cloudflared**（取得同意後 agent 可代做）：有 Homebrew 用 `brew install cloudflared`；沒有的話請人類從 <https://github.com/cloudflare/cloudflared/releases> 下載 macOS 的 `.pkg`（Apple Silicon 選 arm64）安裝。

**模式 A，人類要做的**：

1. Zero Trust dashboard → Networks → Tunnels → 建立 Cloudflared tunnel（名稱例如 `codd-manager`）。
2. Install connector 選 Mac，複製 token，**人類自己**在主機終端機執行 `sudo cloudflared service install "$(pbpaste)"`（token 不會留在 shell history）。不要把 token 直接打在指令列，也不要貼進對話。
3. 新增 Public Hostname：hostname 填 `TUNNEL_HOSTNAME`，Service 選 `HTTP`，URL 填 `127.0.0.1:<PORT>`（用 `127.0.0.1`，不要用 `localhost`，server 只綁 IPv4）。

**模式 B，agent 可做的**（`cloudflared tunnel login` 要人類在瀏覽器完成；`create`、`route dns` 會改 Cloudflare 帳號，先問；`route dns` 會讓 hostname 上線，執行前再確認一次步驟 8 已完成）：

```bash
cloudflared tunnel create codd-manager
cloudflared tunnel route dns codd-manager <hostname>
cp configs/cloudflared.yml.example configs/cloudflared.yml   # 填 tunnel UUID、credentials-file、hostname；service 改成 http://127.0.0.1:<PORT>
npm run tunnel                                               # 前景執行
```

- **驗證**：重跑步驟 0，`external health` 是 `302`；再用 `curl -sI https://<hostname>/api/health | grep -iE '^(HTTP|location)'` 確認 `location` 指向 `<team>.cloudflareaccess.com`。只看檔案存在不算通過。模式 A 另外請人類確認 dashboard 上 connector 為 Healthy。
- **失敗時**：

| 外部檢查 | 原因與處理 |
|---|---|
| `000` | DNS 還沒生效或 hostname 沒接到 tunnel：模式 A 檢查 Public Hostname，模式 B 檢查 `route dns`。新的 DNS 記錄可能要等幾分鐘 |
| `200` | Access 沒套到這個 hostname，**網站正在公開**：立刻回步驟 8 檢查 Application domain 的拼字 |
| `502` | server 沒在跑（看步驟 6 的 log），或 Service URL 的 port 不對 |
| `530`（頁面顯示 1033） | connector 沒連上：模式 A 看 `tail -n 50 /Library/Logs/com.cloudflare.cloudflared.err.log`（另有 `.out.log`，權限不足時請人類加 `sudo`）；模式 B 看前景執行的輸出 |

- `sudo cloudflared service install` 說已安裝 → 這台已經有別的 tunnel 用掉 `com.cloudflare.cloudflared` 服務。不要讀那個 plist 來判斷是哪條 tunnel（裡面有 token），請人類在 dashboard 看各 tunnel 的 connector，再決定要沿用那條 tunnel 加 Public Hostname，還是改用模式 B。

## 步驟 10：用量面板與帳號切換（選用）

- **目的**：側欄底部顯示 Claude（透過 `cswap`）與 Codex（透過 `codex app-server`）的週用量，並能切換帳號。沒裝也能用：Claude 會退回 statusline 回報的目前帳號用量，Codex 區塊自動隱藏。
- **需要人類**：同意要安裝的工具（uv、cswap、Codex CLI，規則 3）；新增帳號、登入，全部由人類自己做。

| 項目 | 安裝 | 驗證 |
|---|---|---|
| uv | 有 Homebrew 用 `brew install uv`；沒有的話 `curl -LsSf https://astral.sh/uv/install.sh \| env UV_NO_MODIFY_PATH=1 sh`（裝到 `~/.local/bin`，不改 shell 設定檔） | `uv --version`（agent 的 PATH 沒有 `~/.local/bin` 時用 `~/.local/bin/uv --version`） |
| cswap（claude-swap） | `uv tool install claude-swap` | `cswap --version` |
| 加入 Claude 帳號 | 人類依 `cswap help` 自己操作（例如登入某帳號後 `cswap add`） | 面板列出帳號 |
| Codex CLI | `brew install --cask codex` 或 `npm install -g @openai/codex`（Node 用 nodejs.org 安裝檔時 `npm install -g` 會因權限失敗，改用 Homebrew 或請人類決定）；只裝了 Codex.app 或 ChatGPT.app 時 server 會用 App 內附的 CLI | `codex --version` |
| Codex 登入 | 人類執行 `codex login`（沒有瀏覽器用 `codex login --device-auth`） | 面板出現 CODEX 區塊 |

- **launchd 找不到執行檔**：server 會依序找 `CSWAP_BIN`/`CODEX_BIN` → PATH → `~/.local/bin` → `/opt/homebrew/bin` → `/usr/local/bin`（Codex 另找 App 內附的）。裝完用 `command -v cswap`、`command -v codex` 看路徑，不在這幾個目錄時（例如 nvm 的全域 npm）寫進 `.env`，再請人類同意重啟 server：

```bash
setenv() { node -e '
const [k,v]=process.argv.slice(1),fs=require("fs");let s=fs.readFileSync(".env","utf8");
const re=new RegExp("^#?\\s*"+k+"=.*$","m");
s=re.test(s)?s.replace(re,()=>k+"="+v):s.replace(/\n*$/,"\n")+k+"="+v+"\n";
fs.writeFileSync(".env",s);console.log("set "+k)' "$1" "$2"; }
P="$(command -v codex)"; test -n "$P" && setenv CODEX_BIN "$P" || echo "找不到 codex，先安裝"
# cswap 同理：P="$(command -v cswap)"; test -n "$P" && setenv CSWAP_BIN "$P"
```

- **加第二個 Codex 帳號**（人類操作）：面板按「加入帳號庫」存下目前帳號 → 主機上 `codex login` 登入另一個帳號 → 面板按 ↻ → 再按「加入帳號庫」。**不要先 `codex logout`**。
- **驗證**：登入網頁後側欄底部出現 Claude 的 `1w`；有裝 Codex 時出現 CODEX 區塊。
- **失敗時**：面板顯示「安裝 cswap 才能切換帳號」（滑鼠移上去看到「找不到 cswap」，或「CSWAP_BIN 指到的 cswap 不存在或不能執行」）→ 設好 `CSWAP_BIN` 並重啟；Codex 只能看不能切換 → 憑證存在系統鑰匙圈（keyring 模式），這是預期行為。

## 步驟 11：Channel 擴充與 codd-manager MCP（選用）

- **目的**：在 CHANNEL_PATH 裝 `frontmatter-doctor` sub-agent，並把 `codd-manager` MCP server 寫進 `<channel>/.mcp.json`，讓 channel 裡的 agent 能查 skills、agents、tasks、memory 與 Kanban。
- **需要人類**：同意寫入 CHANNEL_PATH。

```bash
node scripts/channel-cli.js status
node scripts/channel-cli.js install --dry-run     # 給人類看
node scripts/channel-cli.js install               # 同意後
node scripts/channel-cli.js status
```

- 預設只裝 `agents` 與 `mcp`。`hooks` 模組已被步驟 7 取代，顯示 `missing` 是正常的，不要用 `--only hooks` 裝回來。
- `.mcp.json` 裡會寫入 `CHANNEL_PATH` 與 `KANBAN_DB_PATH` 的絕對路徑（MCP server 自己不讀 `.env`）。
- `.mcp.json` 啟動 MCP 用的是裸指令 `node`，由 session 的互動式 shell PATH 決定是哪一支，而 MCP 會載入 better-sqlite3。確認那支 node 載得起原生模組：

```bash
"$SHELL" -i -c "cd '$PWD' && node -e \"require('better-sqlite3');console.log('mcp node ok')\"" 2>&1 | tail -1
```

- **驗證**：`status` 顯示 `✓ agents   synced` 與 `✓ mcp      synced`；上面印出 `mcp node ok`。人類在 channel 資料夾開 `claude`，第一次會詢問是否啟用 `.mcp.json` 的 server，允許後用 `/mcp` 看得到 `codd-manager`。
- **失敗時**：
  - 這支 CLI 在模組出錯時 exit code 仍是 0，要看輸出有沒有 `error`。
  - `channel path missing .claude/ dir` → 建立 `<channel>/.claude`。
  - CHANNEL_PATH 為空字串時 CLI 會默默改用目前目錄，所以一定要先確認 `.env` 有值或加 `--channel <path>`。
  - `/mcp` 顯示 `codd-manager` failed，或沒印出 `mcp node ok` → 互動式 shell 的 node 不是步驟 2 編譯原生模組的那支。修正 `~/.zshrc` 的 PATH，讓它跟步驟 6 plist 的 node 相同（步驟 1）。不要只為了 MCP 用另一支 node 執行 `npm rebuild`，那會讓 launchd 的 server 載不起來。

## 步驟 12：驗收

| # | 誰 | 檢查 | 預期 |
|---|---|---|---|
| 1 | agent | 步驟 0 全段 | 決策表全部通過 |
| 2 | agent | `curl -sI https://<hostname>/api/health` | `302` 到 `cloudflareaccess.com`（只在本機使用時略過） |
| 3 | 人類 | 無痕視窗開 `https://<hostname>`（只在本機使用時，在主機用 Chrome 開 `http://localhost:<PORT>`） | 先出現 Cloudflare 的 email PIN，再出現 Google 登入，登入後進到首頁（本機使用時直接出現 Google 登入） |
| 4 | 人類 | PROJECTS 新增或修改一個 project：資料夾用 CHANNEL_PATH，指令填 `claude` | 儲存成功 |
| 5 | 人類 | 從該 project 開 session | 終端機出現 Claude Code 畫面 |
| 6 | 人類 | 在 session 送一句 prompt | 側欄狀態燈從忙碌變成閒置或等待輸入 |
| 7 | agent | `node scripts/setup-cli.js status` | 「最近收到資料」的 hook 與 statusline 是「剛剛」或幾分鐘前 |
| 8 | 人類 | 看側欄底部 USAGE | 顯示 Claude 的 `1w`（沒裝 cswap 時要等 statusline 回報一次） |
| 9 | 人類（可選） | 重開主機 | 自動登入後 health 正常，外部可再登入。保留 FileVault 的話：有人在主機輸入密碼登入之後才正常，登入前外部回 `502` |

資料庫預設的 project `claude-station`（指令帶 Discord channel plugin、資料夾 `~/Claude-station`）不一定適用，開不起來時到 PROJECTS 改掉即可。

### 選用：Artifact

CODD 開的 Claude session 會自動掛上 artifact 工具（HTTP MCP `codd-artifacts`，說明見 [README 的 Artifact 段](../README.md#artifacthtml-頁面與設計畫布)），不需要另外安裝。這裡確認它有開起來。

- **需要人類**：開 session、請 Claude 發布、開連結都由人類在瀏覽器做。agent 不要自己開 session，也不要帶 token 呼叫 `/api/mcp`（規則 4）。
- 前提：上面的 #5、#6 已通過。hooks（步驟 7）只有「按提交後自動通知 session」才需要；不按提交、開口請 Claude 讀，不需要 hooks。

agent 先在主機上跑（唯讀；不帶 token，所以預期是 401）：

```bash
PORT=$(grep -E '^PORT=' .env | cut -d= -f2); PORT=${PORT:-3000}
curl -s -o /dev/null -w '/api/mcp -> %{http_code}\n' "http://127.0.0.1:$PORT/api/mcp"
test -f apps/server/data/mcp-host-token && stat -f 'host token mode %Lp' apps/server/data/mcp-host-token || echo "host token: none"
grep -F '[codd-server] artifacts:' ~/Library/Logs/fancy-codd-server.log | tail -1
```

| # | 誰 | 檢查 | 預期 |
|---|---|---|---|
| A1 | agent | 上面的指令 | `/api/mcp -> 401`、`host token mode 600`；log 那行是 `https://<hostname>/artifacts（MCP on）`（只在本機使用時是 `http://localhost:<PORT>/artifacts`） |
| A2 | 人類 | 從 CODD 開一個指令是 `claude` 的 session，送：「用 artifact_create 發布一個 html artifact，標題叫『測試』，內容是一個按鈕」 | Claude 直接呼叫工具，終端機沒有跳出權限詢問；回覆一個 `https://<hostname>/artifact/<id>` 連結 |
| A3 | 人類 | 開那個連結（手機或其他電腦也行） | 登入後看到那個按鈕；側欄 ARTIFACTS 有這一筆，來源是剛才的 session |
| A4 | 人類（可選） | 在頁面按「留言」、點按鈕寫一句，什麼都不按，回 session 說「看一下」 | Claude 呼叫 `artifact_read_submissions`，說得出那句留言；終端機沒有出現 `[CODD]`；頁面頂列「已儲存」旁邊從「未讀」變成「已讀」（最多 20 秒）。再說一次「看一下」，Claude 回沒有新的回覆 |
| A5 | 人類（可選） | 再留一句，這次按「提交」 | Claude 閒置時，session 出現一行 `[CODD] artifact「測試」(<id>) 收到第 1 次提交…`，Claude 接著呼叫 `artifact_read_submissions`；頁面的「紀錄」顯示「已通知」 |

- **失敗時**：

| 看到 | 原因與處理 |
|---|---|
| `/api/mcp -> 404`，log 那行是 `MCP off` | `.env` 有 `CODD_ARTIFACTS_MCP=0`；或 log 有 `artifact MCP disabled`，代表 `apps/server/data/` 寫不進去（看權限、磁碟空間）。修好後請人類同意再重啟 |
| `/api/mcp -> 404`，log 沒有 `artifacts:` 那行 | server 還在跑更新前的程式。請人類同意後重啟（步驟 6 的「日常操作」，會結束所有 session） |
| `/api/mcp -> 403` | 請求帶了轉送 header 或不是本機直連，例如 shell 設了 `http_proxy`，curl 經過了 proxy。這個檢查一定要在主機上直接打 `127.0.0.1`（必要時加 `--noproxy '*'`），不要經過 tunnel |
| Claude 說沒有 `artifact_create` 這類工具 | session 是在 server 更新前開的（重開 session）；project 的指令不是單純的 `claude …`，例如開頭是別的指令、包了一層腳本，或含有 `;`、`&&`、`\|`、`<`、`>`、`#`、`$(`、結尾是 `\`（請人類到 PROJECTS 改成單純的 `claude …`，其他設定放到 project 的 env）；或 `.env` 有 `CODD_ARTIFACTS_MCP=0` |
| 呼叫 artifact 工具仍然跳出權限詢問 | project 的指令自己已經帶 `--settings`：CODD 為了不蓋掉它，就不加自動允許的設定。請人類在那份 settings 的 `permissions.allow` 加上 `"mcp__codd-artifacts"`，或在詢問時選允許。其他原因：`.env` 有 `CODD_ARTIFACTS_AUTO_ALLOW=0`，或人類的 settings 有 deny 規則 |
| 說「看一下」，Claude 回沒有新的回覆（或說讀不到），但頁面上明明有留言 | 看頁面頂列：「儲存失敗」就是沒存進去，點一下重試。「已讀」代表 Claude 真的讀過了，請人類叫 Claude 帶 `full: true` 全部重看。Claude 在別的 session 時，要帶 artifact 的 id；只有建立它的 session 才能省略 id、才會標成已讀 |
| 提交後 session 沒出現 `[CODD]` 那行 | 看頁面「紀錄」的通知狀態。「等 session 閒置」：Claude 正在忙、或停在權限確認或選單，閒置後才會送（最多等 30 分鐘），這是預期行為。Claude 明明閒著卻一直是「等 session 閒置」，最後變成「等太久，沒有通知」：hooks 沒裝或沒作用（回步驟 7，`setup-cli status` 要是 `complete`），CODD 判斷不出 session 狀態就不送；`CODD_ARTIFACT_NOTIFY_UNKNOWN=1` 可以改成照送，但 Claude 停在選單時打進去的字會被當成選擇，要人類自己決定。「session 已結束」：在頁面按「接手…」交給另一個 session。不管哪種，提交都已保存，在 session 裡請 Claude 用 `artifact_read_submissions` 讀即可 |
| Claude 給的連結是 `http://localhost:…`（而人類要從外面開） | `.env` 沒有 `TUNNEL_HOSTNAME`，也沒有 `CODD_PUBLIC_URL`。用步驟 3 的 `setenv TUNNEL_HOSTNAME "<hostname>"`（或 `setenv CODD_PUBLIC_URL "https://<hostname>"`），請人類同意後重啟。已經給出的連結把前面換成 `https://<hostname>` 就能開，路徑 `/artifact/<id>` 不變 |
| Claude 給的連結是 `https://codd.example.com/…` | `.env` 的 `TUNNEL_HOSTNAME` 還是範例值（步驟 0 把它當成未設，server 組連結時照用）。對外使用就改成真正的 hostname；只在本機使用就把那行刪掉或註解掉，連結會變成 `http://localhost:<PORT>/…`。改完請人類同意後重啟 |

## 疑難排解

| 症狀 | 原因與處理 |
|---|---|
| port 被佔用（`EADDRINUSE`，或 `lsof` 看到別的程式） | `lsof -nP -iTCP:<PORT> -sTCP:LISTEN` 看是誰。不是 CODD 就在 `.env` 換 `PORT`，並同步改 Tunnel 的 Service URL，再重啟 |
| `npm install` 時 node-pty 或 better-sqlite3 編譯失敗 | 裝 Xcode CLT（步驟 1）；Node 用支援的版本（不要用 21） |
| `was compiled against a different Node.js version` | 換過 Node。用 launchd 那支 node 跑 `npm rebuild better-sqlite3 @homebridge/node-pty-prebuilt-multiarch`，並重做步驟 6、7 |
| 開 session 出現 `posix_spawnp failed` | node-pty 的 `spawn-helper` 沒有執行權限或編譯不完整，執行 `npm rebuild @homebridge/node-pty-prebuilt-multiarch` 後重啟 |
| 開 session 回 `cwd does not exist` | project 的資料夾不存在，到 PROJECTS 修改 |
| session 一開就結束、`command not found: claude` | 互動式 shell 找不到 claude，見步驟 1 的 `shell claude` 檢查 |
| session 出現 Claude 的登入畫面 | 主機的 `claude` 沒登入（步驟 0 的 `claude login`），請人類在主機終端機執行一次 `claude` 登入 |
| 沒有 Google 登入按鈕，console 有 `The given origin is not allowed for the given client ID` | OAuth Client 的 JavaScript origins 沒有 `https://<hostname>`，補上後等幾分鐘 |
| 登入失敗，401 `Wrong recipient` | 前端與 server 的 Client ID 不同：`.env` 設了跟 `GOOGLE_CLIENT_ID` 不同的 `VITE_GOOGLE_CLIENT_ID`（刪掉它），或換過 Client ID 後沒重新 build 或重啟。重跑 `npm run build`，再重啟 server |
| 登入回 `email not allowed` | Google 帳號跟 `ALLOWED_EMAIL` 不同 |
| 登入後又被踢回登入頁（401 循環） | 用 `http://` 加區網 IP 或非 localhost 位址開啟，Secure cookie 存不進去，改用 `https://<hostname>`；剛換過 `SESSION_SECRET` 時重新登入即可 |
| 登入回 429 | 5 分鐘內嘗試超過 10 次，等一下再試 |
| `GET /` 回 404 | `NODE_ENV` 不是 `production`（步驟 3）或沒有 build（步驟 5） |
| 外部回 `000` | hostname 沒接到 tunnel 或 DNS 還沒生效（步驟 9） |
| 外部回 `502` | server 沒在跑（看步驟 6 的 log），或 Tunnel 指到錯的 port |
| 外部回 `530`、頁面顯示 1033 | connector 沒連上，看 `/Library/Logs/com.cloudflare.cloudflared.err.log`（步驟 9） |
| 外部 health 回 `200` | Access 沒套到這個 hostname，網站正在公開（步驟 8） |
| 重開機後 server 沒起來、外部 `502` | 主機沒有自動登入：FileVault 開著或沒設自動登入（步驟 6 的「主機常駐」） |
| 狀態燈不會變 | `setup-cli status` 不是 `complete`；session 不是從 CODD 開的；或 session 用的 Claude 設定目錄跟安裝的不同（`CLAUDE_CONFIG_DIR`） |
| 升級 Node 後 statusline 顯示 `outdated` 或 node 不存在 | 用新的 node 重跑步驟 7 的 `install`，plist 的 node 也要換（步驟 6） |
| 面板顯示「安裝 cswap 才能切換帳號」，終端機明明有 cswap | 滑鼠移上去看提示：「找不到 cswap」代表 launchd 的 PATH 沒有它，「CSWAP_BIN 指到的 cswap 不存在」代表 `CSWAP_BIN` 寫錯。設好 `CSWAP_BIN`（Codex 對應 `CODEX_BIN`）並重啟 |
| log 出現 `Operation not permitted` | macOS 隱私權限制，見步驟 6 的失敗處理 |
| Artifact：Claude 沒有 `artifact_create` 工具、仍跳權限詢問、提交後沒收到 `[CODD]` 通知、連結是 `localhost` 或 `codd.example.com` | 見步驟 12「選用：Artifact」的失敗處理 |
