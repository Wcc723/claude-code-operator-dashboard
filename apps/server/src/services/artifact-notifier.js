// 使用者提交 artifact 回覆後，在建立該 artifact 的 Claude session 終端機打一行通知並送出。
// - 通知文字是固定模板 + 淨化過的 title；使用者提交的內容不會打進終端機，Claude 只能用 artifact_read_submissions 讀。
// - 只往「掛了 artifact MCP 的互動式 claude」打字：terminal.resolveLive(id, { requireMcp: true })，
//   restart 後 profile 指令改成 bash / codex 之類的就不送（no_session），免得 title 被 shell 當指令執行。
// - 只在 hook 或 Claude Code 的 session registry 明確回報 idle 時才送。busy / waiting（權限確認、選單）一定不送：
//   打進去的數字與 Enter 會被選單吃掉、等於替使用者按了「同意」。
//   unknown（沒裝 hooks、registry 也找不到）無從判斷：預設不送、跟 busy 一樣等，超過 maxWaitMs → expired，
//   提交仍保存，Claude 下次用 artifact_list / artifact_get 看 unread_count 就會發現。
//   notifyOnUnknown（CODD_ARTIFACT_NOTIFY_UNKNOWN=1）才在 unknown 時照送（風險自負）。
//   查狀態本身出錯（enrichOne 丟例外）不算 unknown，一律等。
// - 每個活著的 PTY 一條佇列，同一時間只有一個 driver（正在送或排了下一輪的計時器）；送完隔一個 poll 週期才看下一則，
//   讓 Claude 有時間把狀態切成 busy。session restart 後，舊 id 佇列裡的通知搬到新 PTY 的佇列，不會兩條佇列同時打字。
// - 送之前重新讀 artifact 與提交：artifact 已刪除、或那次提交 Claude 已經讀過（前一則通知時一起讀了）→ skipped，不打字。

const SEND_ENTER_DELAY_MS = 120;
const TITLE_MAX = 60;
const STATE_ERROR = 'error';

// 控制 / 格式 / 私用 / 未指派字元、換行分隔符、變化選擇符（含 tag 字元、零寬字元、bidi 覆寫）：
// 終端機上看不見、但模型讀得到，不能夾帶在以使用者身分打進去的文字裡
const TITLE_STRIP_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

export function sanitizeNotifyTitle(title) {
  const s = String(title ?? '').replace(TITLE_STRIP_RE, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX).join('') : s;
}

export function notifyText({ artifact, submission }) {
  const title = sanitizeNotifyTitle(artifact?.title) || '（未命名）';
  const id = String(artifact?.id ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
  const seq = Number.isInteger(submission?.seq) ? submission.seq : '?';
  return `[CODD] artifact「${title}」(${id}) 收到第 ${seq} 次提交，請用 artifact_read_submissions 讀取後依回饋處理。`;
}

export class ArtifactNotifier {
  constructor({ terminal, insights, repo, pollMs = 3000, maxWaitMs = 30 * 60 * 1000, notifyOnUnknown = false } = {}) {
    this.terminal = terminal;
    this.insights = insights;
    this.repo = repo;
    this.pollMs = pollMs;
    this.maxWaitMs = maxWaitMs;
    this.sendStates = new Set(notifyOnUnknown ? ['idle', 'unknown'] : ['idle']);
    this.queues = new Map(); // live terminal id → { jobs: [], driving: bool, running: bool }
    this.timers = new Map(); // timer → 取消時要做的事（_sleep 用來讓等待中的 promise 收尾）
    this.stopped = false;
    this._order = 0;
    // server 重啟後 PTY 全部結束：上次沒送出的 pending 不會再有機會送
    try { repo?.expireStalePending?.(); } catch (e) { console.error('[artifact-notifier] reset pending failed:', e?.message); }
  }

  /**
   * → { status, session_label }
   * notify:false（使用者取消勾選）→ disabled，不送。
   * 立刻能送就等送完才回；要等 session 閒置就先回 pending，之後在背景送。
   */
  async notify({ artifact, submission, notify = true } = {}) {
    const originId = artifact?.origin_terminal_id ?? null;
    const rec = this._resolve(originId);
    const sessionLabel = (rec && await this._label(rec)) || artifact?.origin_label || null;

    if (!notify) return this._final(submission, 'disabled', sessionLabel);
    if (this.stopped || !rec) return this._final(submission, 'no_session', sessionLabel);

    return new Promise((resolve) => {
      const job = {
        artifact,
        submission,
        originId,
        sessionLabel,
        order: ++this._order,
        deadline: Date.now() + this.maxWaitMs,
        status: 'none',
        // 第一個「確定」的結果回給 route：sent / no_session / failed / expired / skipped，或開始等待時的 pending
        reply: (status) => {
          if (job.replied) return;
          job.replied = true;
          resolve({ status, session_label: sessionLabel });
        },
        replied: false,
      };
      const q = this._queue(rec.id);
      q.jobs.push(job);
      // 前面還有待送的：這則確定要排隊，先標 pending
      if (q.jobs.length > 1) {
        this._setStatus(job, 'pending');
        job.reply('pending');
      }
      // 佇列已經有 driver（正在送、或排了下一輪）就交給它，不另開一條輪詢
      if (!q.driving) this._pump(rec.id);
    });
  }

  stop() {
    this.stopped = true;
    for (const [t, onCancel] of this.timers) {
      clearTimeout(t);
      onCancel?.();
    }
    this.timers.clear();
    // pending 的不再送；還在等結果的 route 回 pending（DB 狀態維持 pending，重啟時會改成 no_session）
    for (const q of this.queues.values()) {
      for (const job of q.jobs) job.reply(job.status === 'none' ? 'pending' : job.status);
    }
    this.queues.clear();
  }

  // ---------- 內部 ----------

  _queue(key) {
    let q = this.queues.get(key);
    if (!q) {
      q = { jobs: [], driving: false, running: false };
      this.queues.set(key, q);
    }
    return q;
  }

  // 只認掛了 artifact MCP 的互動式 claude（TerminalManager 的 requireMcp）；沒有 resolveLive 的 terminal 一律當沒有 session
  _resolve(id) {
    if (typeof id !== 'string' || !id || typeof this.terminal?.resolveLive !== 'function') return null;
    try {
      return this.terminal.resolveLive(id, { requireMcp: true }) ?? null;
    } catch {
      return null;
    }
  }

  // insights 不在 → null；enrichOne 丟例外 → STATE_ERROR（跟「沒有資料」分開）
  async _enrich(rec) {
    if (!this.insights?.enrichOne) return null;
    try { return await this.insights.enrichOne(rec); } catch { return STATE_ERROR; }
  }

  async _label(rec) {
    const e = await this._enrich(rec);
    return (e && e !== STATE_ERROR ? e.title : null) || rec.profile_name || null;
  }

  async _state(rec) {
    const e = await this._enrich(rec);
    if (e === STATE_ERROR) return STATE_ERROR;
    const s = e?.activity?.state;
    return typeof s === 'string' ? s : 'unknown';
  }

  _setStatus(job, status) {
    if (job.status === status) return;
    job.status = status;
    try { this.repo?.setNotifyStatus?.(job.submission.id, status); }
    catch (e) { console.error('[artifact-notifier] setNotifyStatus failed:', e?.message); }
  }

  _final(submission, status, sessionLabel) {
    try { if (submission?.id != null) this.repo?.setNotifyStatus?.(submission.id, status); }
    catch (e) { console.error('[artifact-notifier] setNotifyStatus failed:', e?.message); }
    return { status, session_label: sessionLabel };
  }

  _later(fn, ms) {
    if (this.stopped) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) fn();
    }, ms);
    t.unref?.();
    this.timers.set(t, null);
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      if (this.stopped) return resolve(false);
      const t = setTimeout(() => { this.timers.delete(t); resolve(!this.stopped); }, ms);
      t.unref?.();
      this.timers.set(t, () => resolve(false));
    });
  }

  // 舊 PTY 佇列裡的通知整批搬到新 PTY 的佇列（依提交先後排），新佇列沒有 driver 就幫它開一個
  _migrate(fromKey, toKey) {
    const from = this.queues.get(fromKey);
    if (!from) return;
    this.queues.delete(fromKey);
    from.driving = false;
    const to = this._queue(toKey);
    to.jobs.push(...from.jobs);
    to.jobs.sort((a, b) => a.order - b.order);
    from.jobs = [];
    if (!to.driving) this._pump(toKey);
  }

  // 處理某個 PTY 佇列的第一則；一個佇列同一時間只有一個 driver
  async _pump(key) {
    const q = this.queues.get(key);
    if (!q || q.running || this.stopped) return;
    const job = q.jobs[0];
    if (!job) {
      this.queues.delete(key);
      q.driving = false;
      return;
    }
    q.driving = true;
    q.running = true;
    let next = 0; // 下一輪多久後再跑
    let migrateTo = null;
    try {
      const r = await this._attempt(job, key);
      if (this.stopped) return;
      if (r === 'done') {
        const i = q.jobs.indexOf(job);
        if (i >= 0) q.jobs.splice(i, 1);
        // 送出後隔一個 poll 週期再處理下一則（等 Claude 進入 busy）
        next = job.status === 'sent' && q.jobs.length ? this.pollMs : 0;
      } else if (r && typeof r === 'object' && r.migrate) {
        migrateTo = r.migrate;
      } else {
        next = this.pollMs; // 這則還沒完，pollMs 後重查
      }
    } catch (e) {
      console.error('[artifact-notifier] unexpected error:', e?.message);
      this._setStatus(job, 'failed');
      job.reply('failed');
      const i = q.jobs.indexOf(job);
      if (i >= 0) q.jobs.splice(i, 1);
    } finally {
      q.running = false;
    }
    if (this.stopped) return;
    if (migrateTo) {
      this._migrate(key, migrateTo);
      return;
    }
    if (this.queues.get(key) !== q) return;
    if (!q.jobs.length) {
      this.queues.delete(key);
      q.driving = false;
      return;
    }
    if (next) this._later(() => this._pump(key), next);
    else this._pump(key);
  }

  // → 'done'（這則結束：sent / no_session / expired / failed / skipped）| 'wait'（還要等）| { migrate: 新 PTY id }
  async _attempt(job, key) {
    const rec = this._resolve(job.originId);
    if (!rec) return this._finish(job, 'no_session');
    if (rec.id !== key) return { migrate: rec.id };
    const state = await this._state(rec);
    if (this.stopped) return 'wait';
    if (state === 'ended') return this._finish(job, 'no_session');
    if (!this.sendStates.has(state)) {
      // busy / waiting / unknown / 查不到狀態：等
      if (Date.now() >= job.deadline) return this._finish(job, 'expired');
      this._setStatus(job, 'pending');
      job.reply('pending');
      return 'wait';
    }
    const fresh = this._recheck(job);
    if (fresh === null) return this._finish(job, 'skipped');
    // 查狀態的 await 期間可能剛好被 restart：再確認一次目標
    const live = this._resolve(job.originId);
    if (!live) return this._finish(job, 'no_session');
    if (live.id !== key) return { migrate: live.id };
    return this._finish(job, await this._send(key, notifyText({ artifact: fresh, submission: job.submission })));
  }

  // 送之前重讀：artifact 被刪、或這次提交已經被 Claude 讀過 → null（不用通知）；
  // 否則回最新的 artifact meta（改過名就用新標題）。repo 沒有這些方法或讀取失敗 → 用原本的
  _recheck(job) {
    const repo = this.repo;
    if (typeof repo?.getMeta !== 'function') return job.artifact;
    try {
      const meta = repo.getMeta(job.artifact?.id);
      if (!meta) return null;
      if (typeof repo.getSubmission === 'function' && job.submission?.id != null) {
        const sub = repo.getSubmission(job.submission.id);
        if (!sub || sub.read_at) return null;
      }
      return meta;
    } catch (e) {
      console.error('[artifact-notifier] recheck failed:', e?.message);
      return job.artifact;
    }
  }

  _finish(job, status) {
    this._setStatus(job, status);
    job.reply(status);
    return 'done';
  }

  async _send(id, text) {
    try {
      const r1 = this.terminal.write(id, Buffer.from(text, 'utf8'));
      if (!r1) return 'no_session';
      // 先打字、隔一下再按 Enter：一起送的話 Claude Code 可能把 \r 當成貼上內容的一部分
      const ok = await this._sleep(SEND_ENTER_DELAY_MS);
      if (!ok) return 'failed';
      const r2 = this.terminal.write(id, Buffer.from('\r', 'utf8'));
      if (!r2) return 'no_session';
      return 'sent';
    } catch (e) {
      console.error('[artifact-notifier] write failed:', e?.message);
      return 'failed';
    }
  }
}
