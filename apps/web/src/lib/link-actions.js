// 連結的「開啟」與「複製」（要碰 DOM / window，跟純函式的 terminal-links.js 分開）。

import { webTarget } from './terminal-links.js';

/**
 * 在新分頁開網頁：只開 http(s)（javascript: data: file: blob: … 一律不開），不給新分頁 window.opener、不送 Referer，
 * 也不帶網址裡 @ 前面的帳號密碼。永遠不改目前頁面的網址。
 * @returns {boolean} 有沒有開（網址不合格 = false）
 */
export function openWebUrl(url) {
  const target = webTarget(url);
  if (!target) return false;
  window.open(target.href, '_blank', 'noopener,noreferrer');
  return true;
}

// 舊方法：選取一個看不到的 textarea 再 execCommand('copy')。必須在使用者手勢（click）裡同步呼叫。
// readonly：iOS 不會因為 focus 它而跳出鍵盤；font-size 12pt：iOS 不會因為 focus 而放大頁面；
// iOS 只認 setSelectionRange，select() 不夠。
function execCopy(text) {
  const prev = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;font-size:12pt;border:0;padding:0;';
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy') === true;
  } catch {
    ok = false;
  } finally {
    ta.remove();
    try { prev?.focus?.({ preventScroll: true }); } catch {}
  }
  return ok;
}

/**
 * 複製文字到剪貼簿。
 * https（安全來源）用 navigator.clipboard；區網 http 直連沒有這個 API，改用 execCommand（同一個手勢內同步做）。
 * @returns {Promise<'clipboard' | 'exec' | null>} null = 都失敗，呼叫端要讓使用者自己選取複製
 */
export async function copyText(text) {
  const s = String(text ?? '');
  const api = window.isSecureContext ? navigator.clipboard : null;
  if (!api?.writeText) return execCopy(s) ? 'exec' : null;
  try {
    await api.writeText(s);
    return 'clipboard';
  } catch {
    // 權限被拒、文件沒 focus…：再試舊方法（Chrome 的使用者手勢還在有效期內）
    return execCopy(s) ? 'exec' : null;
  }
}
