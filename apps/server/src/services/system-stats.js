import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

// 主機狀態取樣器：只有在有人看（touch）時才取樣，閒置 60 s 自動停。
// 外部指令只在背景定時跑，永遠不會因為 request 而 fork process。
const FAST_MS = 5_000;          // cpu / memory / event loop
const PROC_MS = 10_000;         // claude process 數
const SLOW_MS = 60_000;         // disk / battery
const IDLE_STOP_MS = 60_000;
const EXEC_TIMEOUT_MS = 2_000;
const LOOP_RESOLUTION_MS = 20;
// setInterval 會有幾 ms 漂移，留 1 s 容忍避免 10 s 任務被擠到 15 s
const DRIFT_MS = 1_000;

const IS_DARWIN = process.platform === 'darwin';
// 固定 PATH + C locale：小數點、單位格式一致，不吃使用者 shell 設定
const EXEC_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' };

const PRESSURE = { 1: 'normal', 2: 'warn', 4: 'critical' };

const round1 = n => Math.round(n * 10) / 10;
const round2 = n => Math.round(n * 100) / 100;

// 永不 reject：{ code: 0|exit code|null(timeout/ENOENT), stdout }
function run(file, args) {
  return new Promise(done => {
    execFile(
      file,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 256 * 1024, env: EXEC_ENV, windowsHide: true },
      (err, stdout) => {
        if (!err) return done({ code: 0, stdout: String(stdout) });
        done({ code: typeof err.code === 'number' ? err.code : null, stdout: String(stdout ?? '') });
      }
    );
  });
}

// vm_stat：page size 從 header 讀（Apple Silicon 是 16 KiB，不能寫死 4096）。
// 對齊 Activity Monitor：App = anonymous − purgeable；Cached = file-backed + purgeable。
export function parseVmStat(text) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!pageSize) return null;
  const pages = {};
  for (const line of text.split('\n')) {
    const m = /^"?([^":]+)"?:\s+(\d+)\.?\s*$/.exec(line.trim());
    if (m) pages[m[1].trim().toLowerCase()] = Number(m[2]);
  }
  const anon = pages['anonymous pages'];
  const wired = pages['pages wired down'];
  const compressor = pages['pages occupied by compressor'];
  if (![anon, wired, compressor].every(Number.isFinite)) return null;
  const purgeable = pages['pages purgeable'] ?? 0;
  const fileBacked = pages['file-backed pages'] ?? 0;
  return {
    app_bytes: Math.max(0, anon - purgeable) * pageSize,
    wired_bytes: wired * pageSize,
    compressed_bytes: compressor * pageSize,
    cached_bytes: (fileBacked + purgeable) * pageSize,
  };
}

// `total = 8192.00M  used = 6618.31M  free = 1573.69M  (encrypted)`
export function parseSwapUsage(text) {
  const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  const field = name => {
    const m = new RegExp(`${name} = ([\\d.]+)([KMGT])`).exec(text);
    return m ? Math.round(Number(m[1]) * unit[m[2]]) : null;
  };
  const total = field('total');
  const used = field('used');
  if (total == null || used == null) return null;
  return { used_bytes: used, total_bytes: total };
}

export function parsePressure(text) {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^\d+$/.test(t)) return PRESSURE[Number(t)] ?? null;
  }
  return null;
}

// 沒有 InternalBattery 行（Mac mini）→ null
export function parseBattery(text) {
  const m = /InternalBattery[^\n]*?(\d{1,3})%;([^\n]*)/.exec(text);
  if (!m) return null;
  const source = /'AC Power'/.test(text) ? 'ac' : /'Battery Power'/.test(text) ? 'battery' : null;
  return {
    percent: Number(m[1]),
    // "charging" / "finishing charge" 才算充電中；"AC attached; not charging"、"charged"、"discharging" 都不算
    charging: /^\s*(charging|finishing charge)\b/i.test(m[2]),
    source,
  };
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  const cpus = os.cpus();
  for (const { times: t } of cpus) {
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total, cores: cpus.length };
}

export class SystemSampler {
  constructor({ terminal } = {}) {
    this.terminal = terminal;
    this._timer = null;
    this._ready = null;
    this._lastTouch = 0;
    this._lastProcAt = 0;
    this._lastSlowAt = 0;
    this._inflight = { fast: false, proc: false, slow: false };
    this._prevCpu = null;
    this._loop = null;
    this._d = {
      sampled_at: null,
      cpu_percent: null,
      cores: os.cpus().length,
      load: null,
      uptime_sec: null,
      memory: null,
      disk: null,
      battery: null,
      claude_processes: null,
      rss_bytes: null,
      loop_p99_ms: null,
    };
  }

  touch() {
    this._lastTouch = Date.now();
    if (!this._timer) this._start();
  }

  // 第一次 touch 後，等第一輪取樣（含外部指令，最多 ~2 s）完成
  ready() {
    return this._ready ?? Promise.resolve();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._ready = null;
    if (this._loop) {
      this._loop.disable();
      this._loop = null;
    }
  }

  snapshot() {
    const d = this._d;
    return structuredClone({
      sampled_at: d.sampled_at,
      platform: process.platform,
      cpu: { percent: d.cpu_percent, cores: d.cores },
      load: d.load,
      uptime_sec: d.uptime_sec,
      memory: d.memory,
      disk: d.disk,
      battery: d.battery,
      claude: { app_running: this._appRunning(), system_processes: d.claude_processes },
      server: { rss_bytes: d.rss_bytes, event_loop_p99_ms: d.loop_p99_ms },
    });
  }

  _appRunning() {
    try {
      return (this.terminal?.list?.() ?? []).filter(s => s.status === 'running' && !s.removed).length;
    } catch {
      return null;
    }
  }

  _start() {
    // 停過再起：舊的 cpu 基準已過期，從頭算（第二次取樣才有 %）
    this._prevCpu = null;
    this._d.cpu_percent = null;
    this._lastProcAt = 0;
    this._lastSlowAt = 0;
    this._loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    this._loop.enable();
    this._timer = setInterval(() => { this._tick(); }, FAST_MS);
    this._timer.unref();
    this._ready = this._tick();
  }

  async _tick() {
    if (Date.now() - this._lastTouch > IDLE_STOP_MS) {
      this.stop();
      return;
    }
    const now = Date.now();
    const jobs = [this._guard('fast', () => this._sampleFast())];
    if (now - this._lastProcAt >= PROC_MS - DRIFT_MS) {
      this._lastProcAt = now;
      jobs.push(this._guard('proc', () => this._sampleProcs()));
    }
    if (now - this._lastSlowAt >= SLOW_MS - DRIFT_MS) {
      this._lastSlowAt = now;
      jobs.push(this._guard('slow', () => this._sampleSlow()));
    }
    await Promise.all(jobs);
  }

  // 同類取樣還沒跑完就跳過這輪，不疊加 child process
  async _guard(kind, fn) {
    if (this._inflight[kind]) return;
    this._inflight[kind] = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[system-stats] ${kind} sample failed:`, e?.message ?? e);
    } finally {
      this._inflight[kind] = false;
    }
  }

  async _sampleFast() {
    const d = this._d;
    const cur = cpuTimes();
    if (this._prevCpu) {
      const dTotal = cur.total - this._prevCpu.total;
      const dIdle = cur.idle - this._prevCpu.idle;
      if (dTotal > 0) d.cpu_percent = round1(Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100)));
    }
    this._prevCpu = cur;
    d.cores = cur.cores;
    d.load = os.loadavg().map(round2);
    d.uptime_sec = Math.floor(os.uptime());
    d.rss_bytes = process.memoryUsage.rss();

    const loop = this._loop;
    if (loop && loop.count > 0) {
      // histogram 記的是整段 timer 間隔（含 resolution 本身），扣掉才是真正的延遲
      d.loop_p99_ms = round1(Math.max(0, loop.percentile(99) / 1e6 - LOOP_RESOLUTION_MS));
      loop.reset();
    }

    d.memory = await this._readMemory();
    d.sampled_at = new Date().toISOString();
  }

  async _readMemory() {
    const total = os.totalmem();
    const fallback = {
      total_bytes: total,
      used_bytes: total - os.freemem(),
      app_bytes: null,
      wired_bytes: null,
      compressed_bytes: null,
      cached_bytes: null,
      pressure: null,
      swap: null,
    };
    if (!IS_DARWIN) return fallback;

    // macOS 的 freemem 只算 free pages，cache 也被當成 used，數字永遠接近滿 → 用 vm_stat
    const [vm, sc] = await Promise.all([
      run('/usr/bin/vm_stat', []),
      run('/usr/sbin/sysctl', ['-n', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level']),
    ]);
    const parts = parseVmStat(vm.stdout);
    const mem = parts
      ? {
          ...fallback,
          ...parts,
          used_bytes: Math.min(total, parts.app_bytes + parts.wired_bytes + parts.compressed_bytes),
        }
      : fallback;
    // sysctl 其中一個 key 失敗時 exit code 非 0，但另一個的輸出仍然有效
    mem.swap = parseSwapUsage(sc.stdout);
    mem.pressure = parsePressure(sc.stdout);
    return mem;
  }

  async _sampleProcs() {
    if (process.platform === 'win32') {
      this._d.claude_processes = null;
      return;
    }
    const { code, stdout } = await run('/usr/bin/pgrep', ['-x', 'claude']);
    if (code === 0) this._d.claude_processes = stdout.split('\n').filter(l => /^\d+$/.test(l.trim())).length;
    else if (code === 1) this._d.claude_processes = 0;   // pgrep：1 = 沒有符合的 process
    else this._d.claude_processes = null;
  }

  async _sampleSlow() {
    const d = this._d;
    try {
      // 量家目錄所在的 volume（APFS 的 Data volume），不是唯讀的 system volume '/'
      const s = await statfs(os.homedir());
      const total = s.blocks * s.bsize;
      const avail = s.bavail * s.bsize;
      d.disk = {
        total_bytes: total,
        avail_bytes: avail,
        used_percent: total > 0 ? round1(((total - avail) / total) * 100) : null,
      };
    } catch {
      d.disk = null;
    }

    if (IS_DARWIN) {
      const { code, stdout } = await run('/usr/bin/pmset', ['-g', 'batt']);
      d.battery = code === 0 ? parseBattery(stdout) : null;
    } else {
      d.battery = null;
    }
  }
}
