# Google OAuth 2.0 Client ID 設定步驟

本平台用 **Google Identity Services + ID Token** 驗證身份，**不需要 client secret**。

## 1. 建立 OAuth Client

1. 進 [Google Cloud Console](https://console.cloud.google.com/)
2. 上面選一個 project（或新建一個，名稱例如 `fancy-codd`）
3. 左側 → APIs & Services → **OAuth consent screen**
   - User type：**External**
   - App name：Fancy CODD
   - Support email / Developer email：填你自己
   - **Test users**：把你的 Google email（即 `ALLOWED_EMAIL`）加進去
   - 其他 scopes 不用加（ID token 模式預設給 email/profile，不需要額外授權）
4. 左側 → APIs & Services → **Credentials** → Create Credentials → **OAuth client ID**
   - Application type：**Web application**
   - Name：Fancy CODD Web
   - **Authorized JavaScript origins**：加兩個
     - `http://localhost:5173` （dev）
     - `https://codd.example.com` （換成你的 tunnel hostname）
   - **Authorized redirect URIs**：**留空**（ID Token 模式不需要 redirect）
5. 建立後拿到 **Client ID**（長得像 `xxxxx-yyyy.apps.googleusercontent.com`）
   - 把它寫進根目錄 `.env` 的 `GOOGLE_CLIENT_ID`
   - Vite 已設定自動從 root `.env` 讀此值並注入為 `import.meta.env.VITE_GOOGLE_CLIENT_ID`。**不要建立 `apps/web/.env`**（Vite 不會讀它），也不要在 root `.env` 另設不同值的 `VITE_GOOGLE_CLIENT_ID`：server 只認 `GOOGLE_CLIENT_ID` 為 audience，前端用別的 Client ID 時登入一律 401 `Wrong recipient`
   - **Client secret 不用複製，本平台不會用到**

## 2. 設定 ALLOWED_EMAIL

`.env` 內 `ALLOWED_EMAIL` 必須**完全等於**你的 Google 登入 email（大小寫不敏感，後端會 `.toLowerCase()`）。

## 3. 換 hostname / 上線時

- 換 tunnel hostname → 回 Credentials → 把 Authorized JavaScript origins 補上新域名（**舊的不用刪**，可同時存在）
- Authorized origins 不接受 wildcard，所以 quick tunnel 不適用 — 用 named tunnel + 固定 hostname

## 4. 安全提醒

- Client ID 本來就會出現在前端 HTML 裡，洩漏沒事（不是 secret）
- 真正的安全來自三件事：
  1. **後端用 `google-auth-library.verifyIdToken()` 驗 audience（aud）== 你的 client_id**，別的 app 簽出來的 token 無效
  2. **`payload.email === ALLOWED_EMAIL` 且 `payload.email_verified === true`**，非 allowlist 即拒
  3. **Authorized JavaScript origins 只列你信任的 domain**，第三方網站無法在自家頁面渲染你的 Sign-In button 拿到 token
- Session cookie 用 HTTP-only + Secure + SameSite=Strict，防 XSS 偷、防 CSRF
- 強烈建議 Google 帳號開啟 2FA — 上游帳號被盜任何 OAuth 方案都擋不住
