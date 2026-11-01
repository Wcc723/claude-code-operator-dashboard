# Cloudflared 跑成 launchd Service（macOS）

## 為什麼要這樣做

直接 `cloudflared tunnel run` 是 foreground 模式 — 關 terminal、Mac mini 重開機、cloudflared crash 都會中斷，需要手動重啟。

裝成 launchd service 後：

- **開機自啟** — Mac mini 重新開機不用管
- **死了自動 restart** — 任何 crash / 網路問題斷線都會自我恢復
- **背景跑** — 不佔 terminal
- **log 自動寫檔** — 事後可查斷線原因

## 找你的 Tunnel

兩種方法看你帳號下所有 tunnel：

### A. CLI（最快）

```bash
cloudflared tunnel list
```

輸出範例：
```
ID                                   NAME           CREATED              CONNECTIONS
be48d3fb-3bf7-41cd-9f3c-7162edb7eb9b  codd-manager   2026-05-26T12:34:56  4x...
```

- `ID` = tunnel UUID（DNS CNAME 指的那串）
- `NAME` = 你建 tunnel 時起的名字
- `CONNECTIONS` = 目前有幾條 active connection 到 Cloudflare edge

### B. Dashboard

1. 進 [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. 左側選單 → **網路 (Networks)** → **通道 (Tunnels)**
3. 列表顯示所有 tunnel 名稱、狀態、connector 數

從 dashboard 可以：
- 直接看哪些 tunnel 是 active / inactive
- 編輯 Public Hostname（ingress rules）
- 拿 install token（service mode 需要）
- 刪 tunnel

## 安裝步驟

### 1. 拿 install token

dashboard → **Networks → Tunnels** → 點你的 tunnel → **Configure** → **Install and run a connector** → 選 **Mac** → 複製顯示的長 token 字串（很長，base64 編碼的 JSON）。

⚠️ 這個 token **含 tunnel 認證資訊**，別貼到 git / 公開地方。

### 2. 裝 service

在 dashboard 複製 token 後，於主機終端機執行（用 `pbpaste` 帶入剪貼簿，token 不會留在 shell history；不要把 token 直接打在指令列）：

```bash
# 需要 sudo（launchd 寫到 /Library/LaunchDaemons）
sudo cloudflared service install "$(pbpaste)"
```

這會做幾件事：
- 建立 `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist`，token 直接寫在它的 ProgramArguments（`tunnel run --token <token>`），不是 `/etc/cloudflared/config.yml`
- 啟動 launchd service 並設定開機自啟

裝完馬上會跑起來，幾秒內看到對應 connector 在 dashboard 顯示綠燈。

⚠️ 因為 token 在 plist 裡，也會出現在 `launchctl print system/com.cloudflare.cloudflared` 與 `ps` 的指令列：不要 `cat`、`plutil -p`、`grep` 這個 plist，不要 `ps aux | grep cloudflared`（改用 `pgrep -x cloudflared`），也不要把這些輸出貼到對話或 issue。

### 3. 驗證

```bash
# 看 service 狀態
sudo launchctl list | grep cloudflared

# 看 log（service 模式寫在 /Library/Logs；錯誤訊息在 .err.log，另有 .out.log）
tail -f /Library/Logs/com.cloudflare.cloudflared.err.log

# 確認 tunnel 真的通
curl -I https://codd.example.com/api/health
```

## 日常操作

```bash
# 停（暫時關閉）
sudo launchctl unload /Library/LaunchDaemons/com.cloudflare.cloudflared.plist

# 啟（停了之後重新跑）
sudo launchctl load /Library/LaunchDaemons/com.cloudflare.cloudflared.plist

# 重啟（改 config 後）
sudo launchctl unload /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
sudo launchctl load   /Library/LaunchDaemons/com.cloudflare.cloudflared.plist

# 看 log（持續）
tail -f /Library/Logs/com.cloudflare.cloudflared.err.log

# 看最近 100 行 log
tail -n 100 /Library/Logs/com.cloudflare.cloudflared.err.log
```

## 改 ingress 設定後

如果你用 **dashboard managed 模式（service install token）**：
- 設定改在 dashboard → Public Hostname tab
- 改完幾秒內 cloudflared 自動拉新設定，**不用重啟 service**

如果你用 **local config 模式**（裝 service 時不給 token 而是給 `--config` flag）：
- 改完 `cloudflared.yml` 要重啟 service 才生效

## 解除安裝

```bash
sudo cloudflared service uninstall
```

會停掉服務並移除 launchd plist（token 也跟著移除）。Tunnel 本身不會刪（仍在 Cloudflare 那邊），可以 `cloudflared tunnel delete <name>` 從 Cloudflare 移除。

## 排錯

### service install 失敗 / 重複安裝

如果之前裝過、要重裝：

```bash
sudo cloudflared service uninstall
# 先在 dashboard 複製新的 token
sudo cloudflared service install "$(pbpaste)"
```

### service 狀態看起來在跑但 tunnel 沒上線

```bash
# 看 log 最後幾行找錯誤
tail -n 50 /Library/Logs/com.cloudflare.cloudflared.err.log

# 常見錯誤：
# - "Unable to reach Cloudflare edge" → 網路 / 防火牆問題
# - "no ingress rules" → dashboard 那邊還沒設 Public Hostname
# - "Failed to authenticate" → token 過期或失效，去 dashboard 重新拿
```

### 想看 service 跑的是哪個 cloudflared

只取 ProgramArguments 的第一個元素（執行檔路徑）。其餘參數含 tunnel token，不要整段印出來：

```bash
plutil -extract ProgramArguments.0 raw /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
```

### 升級 cloudflared

```bash
brew upgrade cloudflared
# 升完不用重 install service，自動跑新版 binary
sudo launchctl unload /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
sudo launchctl load   /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
```

## 進階：強制用 HTTP/2 不要 QUIC

某些 NAT / router 對 UDP idle 連線砍 socket 快，會造成 cloudflared 假死。改用 TCP-based HTTP/2 比較穩：

### Dashboard managed 模式

dashboard → 你的 tunnel → **Cloudflared** tab → **Edge Transport Protocol** 改 `HTTP/2`

### Local config 模式

`/etc/cloudflared/config.yml` 加：
```yaml
protocol: http2
```

改完 reload service。

## 相關文件

- `configs/cloudflared.yml.example` — local config 模式範本（如不用 service mode）
- `configs/cloudflare-access-setup.md` — 在 tunnel 前面再加 Zero Trust Access policy
- 官方文件：<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/macos/>
