# Cloudflare Zero Trust Access 設定步驟

## 為什麼需要這個

只開 cloudflared tunnel **不夠**。tunnel 把你後端 admin UI（含 PTY spawn API、kanban、identity 編輯）對 internet 公開，唯一防線是後端 Google ID Token + ALLOWED_EMAIL。一旦 Google 帳號被盜，攻擊者立刻拿到你 Mac 的 shell。

加上 Cloudflare Access 後，所有流量在 Cloudflare edge 先被 policy 篩過一次（email allowlist + MFA / hardware key），不在 allowlist 的請求**根本打不到你後端**。這是真正的 defense-in-depth。

```
没 Access:  internet → cloudflared → 後端 (只有 Google 一層)
有 Access:  internet → Cloudflare edge (篩 allowlist + MFA) → cloudflared → 後端 (Google 又一層)
```

## 前置確認

- Cloudflare 帳號需要有 Zero Trust 服務（免費版 50 user，個人用綽綽有餘）
  - 第一次用會要你建立 team name（例如 `mycompany`）→ 你的 Access 入口會是 `<your-team>.cloudflareaccess.com`
- 網域已經在這個 Cloudflare 帳號、狀態是 Active。**建議先設好 Access，再把 hostname 接上 tunnel**（新增 Public Hostname 或 `cloudflared tunnel route dns`）：hostname 還沒有 DNS 記錄也能先建 Access application，這樣網站上線的第一秒就有 Access 保護

## 設定步驟

### 1. 進 Zero Trust dashboard

<https://one.dash.cloudflare.com/>

左側選單 → **Access** → **Applications** → 「Add an application」

### 2. 選 Application type

選 **Self-hosted**（不是 SaaS、不是 Private Network）

### 3. Configure application

| 欄位 | 填什麼 | 備註 |
|---|---|---|
| Application name | `Fancy CODD` | 隨意 |
| Session Duration | `24 hours` 或 `1 week` | 你方便為主；越短越安全 |
| Application domain | Subdomain `codd` + Domain `your-domain.com` | **必須完全匹配 cloudflared.yml 內的 hostname** |
| Path | 留空 | 全 path 都套用 policy |

⚠️ Application domain 一個字打錯 → Access policy 不會生效，請求會直通後端

### 4. Identity providers

- 預設會有 **One-time PIN**（email 收驗證碼）— 個人用這個就夠
- 進階：可加 Google / GitHub OAuth provider
  - 推薦用 **One-time PIN 在 Cloudflare 這層 + 後端 Google login** 的組合
  - 兩個獨立認證源（email 收件箱 + Google 密碼）才是真正的 2-factor

### 5. Policies（核心）

「Add a policy」：

| 欄位 | 填什麼 |
|---|---|
| Policy name | `Operator allow` |
| Action | **Allow** |
| Session duration | 同上 |

**Configure rules → Include**：

- Selector: `Emails`
- Value: 你的 email（後端那個 ALLOWED_EMAIL，要完全一致）

**Require**（可選但強烈建議擇一或多選）：

- Selector: `Authentication method` → `mfa`
  - 強制要有 MFA / hardware key
- Selector: `Country` → 限制只允許台灣 IP（或你常用的國家）
- Selector: `IP ranges` → 限制只允許特定 IP（家裡固定 IP / 公司 IP）

### 6. Setup

- CORS / cookies 設定不用改
- 點 「Add application」完成

## 驗證 Access 生效

設完後**用無痕視窗**（避免被既有 cookie 干擾）：

1. 開 `https://codd.your-domain.com`
2. 應該先看到 **Cloudflare 的 email 輸入畫面**（藍紫色，有 Cloudflare logo）
3. 輸入你的 email → 收件箱收到 6 位數驗證碼 → 輸入後才會跳到後端的 Google Sign-In
4. 兩層都過才能用

### 異常狀況排查

| 症狀 | 可能原因 |
|---|---|
| 直接跳到後端 Google Sign-In | Application domain 沒對到，或 policy 還在 Pending |
| Cloudflare 一直 redirect 自己 | DNS / tunnel hostname 沒設好 |
| Email PIN 收不到 | Cloudflare 的 email 進 spam folder；或 email 有 typo |
| `Access denied` | 你 email 不在 Include 清單，或 Require 條件沒過（例如沒開 MFA） |

### 用 curl 確認 policy 真的在邊緣擋

```bash
# 不帶任何 cookie / token 直接打：應回 302 redirect 到 Cloudflare Access 登入頁
curl -I https://codd.your-domain.com/api/health

# 預期：HTTP/2 302
#       location: https://<your-team>.cloudflareaccess.com/cdn-cgi/access/...
#
# 如果回 200 → policy 沒生效，後端直接接到請求
# 如果回 401（後端的 Google login 401）→ policy 沒生效，但 redirect 邏輯被吃掉了
```

## 與後端設定的關係

- `.env` 內 `ALLOWED_EMAIL` 仍要設，且應**等於** Cloudflare Access policy 內的 email
- 後端的 Google ID Token 檢查是第二層防線，不能因為加了 Access 就拿掉
- 兩層用同一個 email 看似冗餘，但分別保護兩個不同的攻擊路徑：
  - **Access**：擋掉「攻擊者連到後端」這件事本身
  - **後端 Google**：擋掉「攻擊者繞過 Cloudflare（例如 cloudflared local fallback）」的情境

## 升級選項（風險更低的進階設定）

### Google Advanced Protection Program

你的 Google 帳號本身要開 [Advanced Protection](https://landing.google.com/advancedprotection/)，強制使用 hardware key（YubiKey），擋 phishing。

### Cloudflare Access Service Token（給 CLI / 機器人）

若你要從手機 / 別台電腦的 script 打你的 codd API，不想每次都過 email PIN，可建立 [Service Token](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)：

```bash
curl https://codd.your-domain.com/api/health \
  -H "CF-Access-Client-Id: <id>.access" \
  -H "CF-Access-Client-Secret: <secret>"
```

Service token 在 Access policy 內以 **Include → Service Auth → Service Token** 設定。

### Tunnel 加 ingress 分離

進階：把 webhook / health 與 admin UI 分到不同 hostname。優先考慮改用上面的 Service Token；真的要拆時，公開的 hostname 一定要限制 path，而且用 `127.0.0.1`（server 只綁 IPv4，`localhost` 可能解析成 IPv6 而連不到）。本機設定檔模式（`cloudflared.yml`）寫法：

```yaml
ingress:
  - hostname: codd-health.your-domain.com    # 公開，無 Access；只放行完全等於 /api/health 的路徑
    service: http://127.0.0.1:3000
    path: ^/api/health$
  - hostname: codd.your-domain.com           # 私有，有 Access policy
    service: http://127.0.0.1:3000
  - service: http_status:404
```

Dashboard 管理模式（`cloudflared service install` 的 token 模式）則是在 tunnel 的 **Public Hostname** 再新增一筆 `codd-health.your-domain.com`：Service 選 `HTTP`、URL 填 `127.0.0.1:<PORT>`，**Path 必須填 `^/api/health$`**（留空會讓整個 CODD 在這個 hostname 上沒有 Access），而且不要把它加進 Access application。

建立後驗證其他路徑都進不去（兩個都應該回 `404`）：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://codd-health.your-domain.com/
curl -s -o /dev/null -w "%{http_code}\n" https://codd-health.your-domain.com/api/auth/me
```

這樣監控系統可以 ping `codd-health.*` 不被 Access 擋，admin UI 仍有完整保護。

## 參考

- [Cloudflare 官方 — Add a self-hosted application](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/)
- [Cloudflare 官方 — Access policies](https://developers.cloudflare.com/cloudflare-one/policies/access/)
- 本 repo: `configs/cloudflared.yml.example` — tunnel ingress 設定範例
- 本 repo: `configs/google-oauth-setup.md` — 後端 Google ID Token 設定（第二層防線）
