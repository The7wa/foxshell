'use strict';
const { Client } = require('ssh2');
const { EventEmitter } = require('events');
const fs = require('fs');

const RAW_STATS_CMD =
  "cat /proc/stat;echo '##FS-MEM';cat /proc/meminfo;echo '##FS-NET';cat /proc/net/dev;echo '##FS-LOAD';cat /proc/loadavg;echo '##FS-DF';df -kP /;echo '##FS-UP';cat /proc/uptime;echo '##FS-END'";

const STATS_INTERVAL = 2000;

class SSHSession extends EventEmitter {
  constructor(tabId, send) {
    super();
    this.tabId = tabId;
    this.send = send; // (type, payload) => webContents.send('ssh-event', {tabId, type, payload})
    this.client = null;
    this.jumpClients = []; // 跳板机链上的所有中间 Client
    this.sftp = null;
    this._sftpQ = null; // 惰性 SFTP 初始化的等待队列
    this.shells = new Map(); // paneId -> shell stream（一个连接可开多个终端，供分屏使用）
    this._pendingResize = new Map();
    this.forwards = new Map(); // 转发规则 id -> net.Server
    this.statsTimer = null;
    this.prev = null; // 上一帧 cpu/net 采样
    this.prevNet = null;
    this.cfg = null;
    this.closed = false;
  }

  emit_(type, payload) {
    this.send(type, payload);
  }

  // 用一个 Client 发起连接（支持 keyboard-interactive），Promise 化
  dial(c, opts, password) {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      c.on('keyboard-interactive', (name, instr, lang, prompts, finish) => finish([password || '']));
      c.once('ready', () => {
        c.removeListener('error', onError);
        try { c.setNoDelay(true); } catch (_) {}
        resolve();
      });
      c.once('error', onError);
      c.connect(opts);
    });
  }

  cleanupHops() {
    for (const jc of this.jumpClients) {
      try { jc.end(); } catch (_) {}
    }
    this.jumpClients = [];
  }

  async connect(cfg) {
    this.cfg = cfg;
    const c = new Client();
    this.client = c;
    const opts = {
      host: cfg.host,
      port: cfg.port || 22,
      username: cfg.username,
      readyTimeout: 15000,
      keepaliveInterval: 15000,
      tryKeyboard: true,
      hostHash: cfg.hostHash || 'sha256',
      hostVerifier: cfg.hostVerifier || ((_fp, done) => done(false)),
    };
    if (cfg.authType === 'key') {
      opts.privateKey = cfg.keyData; // Buffer
      if (cfg.passphrase) opts.passphrase = cfg.passphrase;
    } else {
      opts.password = cfg.password;
    }

    try {
      // 跳板机链：数量不限，按顺序 跳板1 → 跳板2 → … → 目标
      const hops = cfg.jumps || [];
      let sock = null;
      for (let i = 0; i < hops.length; i++) {
        const hop = hops[i];
        const jc = new Client();
        const hopOpts = {
          host: hop.host,
          port: hop.port || 22,
          username: hop.username || cfg.username || 'root',
          password: hop.password,
          readyTimeout: 15000,
          keepaliveInterval: 15000,
          tryKeyboard: true,
          hostHash: hop.hostHash || cfg.hostHash || 'sha256',
          hostVerifier: hop.hostVerifier || ((_fp, done) => done(false)),
        };
        if (sock) hopOpts.sock = sock; // 上一跳建立的隧道
        this.emit_('status', { state: 'connecting', message: `跳板机 ${i + 1}/${hops.length} ${hop.host}...` });
        try {
          await this.dial(jc, hopOpts, hop.password);
        } catch (err) {
          throw new Error(`跳板机 ${i + 1} (${hop.host}) 连接失败：${err.message || err}`);
        }
        jc.on('error', () => {}); // 链路异常由最终连接的 close 事件统一上报
        this.jumpClients.push(jc);
        // 通过本跳板机连向下一跳（或最终目标）
        const next = i + 1 < hops.length ? hops[i + 1] : { host: cfg.host, port: cfg.port || 22 };
        sock = await new Promise((resolve, reject) => {
          jc.forwardOut('127.0.0.1', 0, next.host, next.port || 22, (err, s) => (err ? reject(err) : resolve(s)));
        });
      }
      if (sock) opts.sock = sock;
      if (hops.length) this.emit_('status', { state: 'connecting', message: '正在连接目标服务器...' });
      await this.dial(c, opts, cfg.password);
    } catch (err) {
      this.cleanupHops();
      if (!this.closed) this.emit_('status', { state: 'failed', message: String(err.message || err) });
      return;
    }

    this.emit_('status', { state: 'connected' });
    this.loadCommands();
    // 连接建立后的断线检测
    c.on('close', () => {
      if (!this.closed) this.close('连接已断开');
    });
    c.on('error', (err) => {
      if (!this.closed) this.emit_('status', { state: 'failed', message: String(err.message || err) });
    });
    // SFTP 通道按需建立（首次打开文件面板/传输时），减少连接建立耗时
    this.startStats(cfg);
  }

  loadCommands() {
    if (!this.client || this.closed) return;
    const cmd = "{ echo $PATH | tr ':' '\\n' | while read d; do ls \"$d\" 2>/dev/null; done | sort -u | head -c 100000; echo '##FS-ALIAS'; alias 2>/dev/null; }";
    this.client.exec(cmd, (err, stream) => {
      if (err) return;
      let out = '';
      stream.on('data', (d) => (out += d.toString()));
      stream.on('close', () => {
        if (this.closed || !out) return;
        const idx = out.indexOf('##FS-ALIAS');
        const list = out.slice(0, idx === -1 ? undefined : idx).split('\n')
          .map((s) => s.trim())
          .filter((s) => s && !s.includes('/') && !s.includes(' ') && s.length <= 64);
        if (idx !== -1) {
          for (const line of out.slice(idx + 9).split('\n')) {
            const m = /^(?:alias\s+)?([\w.-]+)=/.exec(line.trim());
            if (m) list.push(m[1]);
          }
        }
        if (list.length) this.emit_('commands', { list });
      });
    });
  }

  // 惰性初始化 SFTP 通道；并发调用只会建立一次
  ensureSftp() {
    return new Promise((resolve) => {
      if (this.sftp) return resolve(this.sftp);
      if (!this.client || this.closed) return resolve(null);
      if (this._sftpQ) return this._sftpQ.push(resolve);
      this._sftpQ = [resolve];
      this.client.sftp((err, sftp) => {
        const q = this._sftpQ;
        this._sftpQ = null;
        if (!err) {
          this.sftp = sftp;
          this.emit_('sftp-ready', {});
        }
        q.forEach((r) => r(err ? null : sftp));
      });
    });
  }

  // ---------- 端口转发（ssh -L 本地转发） ----------
  startForward(rule) {
    if (this.forwards.has(rule.id)) return;
    const net = require('net');
    const server = net.createServer((sock) => {
      if (!this.client || this.closed) return sock.destroy();
      this.client.forwardOut('127.0.0.1', sock.remotePort || 0, rule.dstHost, rule.dstPort, (err, stream) => {
        if (err) {
          sock.destroy();
          return this.emit_('forward-error', { id: rule.id, message: String(err.message || err) });
        }
        sock.pipe(stream).pipe(sock);
        stream.on('error', () => sock.destroy());
      });
      sock.on('error', () => {});
    });
    server.on('error', (err) => {
      this.forwards.delete(rule.id);
      this.emit_('forward-error', { id: rule.id, message: String(err.message || err) });
    });
    server.listen(rule.localPort, '127.0.0.1', () => {
      this.forwards.set(rule.id, server);
      this.emit_('forward-state', { id: rule.id, active: true, localPort: rule.localPort });
    });
  }

  stopForward(ruleId) {
    const server = this.forwards.get(ruleId);
    if (server) {
      try { server.close(); } catch (_) {}
      this.forwards.delete(ruleId);
    }
    this.emit_('forward-state', { id: ruleId, active: false });
  }

  // 在当前连接上打开一个新的交互终端（paneId 由渲染进程分配）
  openShell(paneId, cols, rows) {
    if (!this.client || this.closed) {
      return this.emit_('pane-error', { paneId, message: '连接未建立' });
    }
    this.client.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, (err, stream) => {
      if (err) return this.emit_('pane-error', { paneId, message: String(err.message || err) });
      this.shells.set(paneId, stream);
      const pending = this._pendingResize.get(paneId);
      if (this._pendingResize.delete(paneId) && pending) {
        try { stream.setWindow(pending.rows, pending.cols, 0, 0); } catch (_) {}
      }
      let outBuf = null;
      let outTimer = null;
      const flushOut = () => {
        if (outTimer) { clearTimeout(outTimer); outTimer = null; }
        if (!outBuf || !outBuf.length) return;
        const data = outBuf;
        outBuf = null;
        this.emit_('pane-data', { paneId, data });
      };
      const pushOut = (d) => {
        outBuf = outBuf ? Buffer.concat([outBuf, d]) : Buffer.from(d);
        if (outBuf.length >= 64 * 1024) flushOut();
        else if (!outTimer) outTimer = setTimeout(flushOut, 16);
      };
      stream.on('data', pushOut);
      stream.stderr.on('data', pushOut);
      stream.on('close', () => {
        flushOut();
        this.shells.delete(paneId);
        this.emit_('pane-closed', { paneId });
      });
      stream.on('error', () => {});
      this.emit_('pane-ready', { paneId });
    });
  }

  write(paneId, data) {
    const s = this.shells.get(paneId);
    if (s) s.write(data);
  }

  resize(paneId, cols, rows) {
    const s = this.shells.get(paneId);
    if (s) {
      try { s.setWindow(rows, cols, 0, 0); } catch (_) {}
    } else {
      this._pendingResize.set(paneId, { cols, rows });
    }
  }

  closePane(paneId) {
    this._pendingResize.delete(paneId);
    const s = this.shells.get(paneId);
    if (s) {
      try { s.end(); } catch (_) {}
      this.shells.delete(paneId);
    }
  }

  // ---------- 资源监控（Linux 服务器） ----------
  startStats(cfg) {
    this.statsTimer = setInterval(() => this.sampleStats(cfg.host), STATS_INTERVAL);
    this.sampleStats(cfg.host);
  }

  sampleStats(host) {
    if (!this.client || this.closed) return;
    this.client.exec(RAW_STATS_CMD, (err, stream) => {
      if (err) {
        clearInterval(this.statsTimer);
        this.statsTimer = null;
        this.emit_('stats', { supported: false });
        return;
      }
      let out = '';
      stream.on('data', (d) => (out += d.toString()));
      stream.on('close', () => {
        try {
          this.emit_('stats', { supported: true, ...this.parseStats(host, out) });
        } catch (_) {
          clearInterval(this.statsTimer);
          this.statsTimer = null;
          this.emit_('stats', { supported: false });
        }
      });
    });
  }

  parseStats(host, out) {
    const sec = (tag) => {
      const start = out.indexOf(tag);
      const next = out.indexOf('##FS-', start + 1);
      return out.slice(start + tag.length, next === -1 ? undefined : next);
    };
    // CPU
    const cpuLine = /^cpu\s+([\d\s]+)/m.exec(out);
    if (!cpuLine) throw new Error('bad stats');
    const vals = cpuLine[1].trim().split(/\s+/).map(Number);
    const idle = vals[3] + (vals[4] || 0);
    const steal = vals[6] || 0;
    const total = vals.reduce((a, b) => a + b, 0);
    let cpu = 0;
    if (this.prev) {
      const dt = total - this.prev.total;
      const di = idle + steal - (this.prev.idle + this.prev.steal);
      if (dt > 0) cpu = Math.max(0, Math.min(100, ((dt - di) / dt) * 100));
    }
    this.prev = { total, idle, steal };

    // 内存
    const mt = /MemTotal:\s+(\d+) kB/.exec(out);
    const ma = /MemAvailable:\s+(\d+) kB/.exec(out);
    const memTotal = mt ? Number(mt[1]) * 1024 : 0;
    const memAvail = ma ? Number(ma[1]) * 1024 : 0;
    const memUsed = memTotal - memAvail;

    // 网络
    let rx = 0, tx = 0;
    const netPart = sec('##FS-NET');
    for (const line of netPart.split('\n')) {
      const m = /^\s*(\S+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/.exec(line);
      if (!m || m[1] === 'lo') continue;
      rx += Number(m[2]);
      tx += Number(m[3]);
    }
    let rxRate = 0, txRate = 0;
    if (this.prevNet) {
      const dt = STATS_INTERVAL / 1000;
      rxRate = Math.max(0, (rx - this.prevNet.rx) / dt);
      txRate = Math.max(0, (tx - this.prevNet.tx) / dt);
    }
    this.prevNet = { rx, tx };

    // 负载 / 磁盘 / 运行时长
    const load = (sec('##FS-LOAD').trim().split(/\s+/)[0]) || '0';
    const dfLine = sec('##FS-DF').split('\n').filter((l) => /\s\/\s/.test(' ' + l + ' ') && /^\S+\s+\d+/.test(l.trim()))[0]
      || sec('##FS-DF').trim().split('\n').pop() || '';
    const dfCols = dfLine.trim().split(/\s+/);
    const diskTotal = Number(dfCols[1]) * 1024 || 0;
    const diskUsed = Number(dfCols[2]) * 1024 || 0;
    const diskPct = Number(dfCols[4]) || 0;
    const up = Number(sec('##FS-UP').trim().split(/\s+/)[0]) || 0;

    return {
      host, cpu, memTotal, memUsed, rxRate, txRate,
      diskTotal, diskUsed, diskPct, load, uptime: up,
    };
  }

  // ---------- SFTP（惰性建立通道） ----------
  async sftpList(dirPath) {
    const sftp = await this.ensureSftp();
    if (!sftp) return this.emit_('sftp-error', { message: 'SFTP 不可用（连接未就绪）' });
    const p = dirPath || '.';
    sftp.realpath(p, (err, abs) => {
      const cwd = err ? p : abs;
      sftp.readdir(cwd, (e2, list) => {
        if (e2) return this.emit_('sftp-error', { message: String(e2.message || e2), cwd });
        const entries = list.map((it) => ({
          name: it.filename,
          isDir: it.attrs.isDirectory(),
          size: it.attrs.size,
          mtime: it.attrs.mtime * 1000,
          mode: it.attrs.mode,
        })).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
        this.emit_('sftp-list', { cwd, entries });
      });
    });
  }

  async sftpMkdir(dirPath, name) {
    const sftp = await this.ensureSftp();
    if (!sftp) return;
    sftp.mkdir(dirPath + '/' + name, (err) => {
      if (err) return this.emit_('sftp-error', { message: String(err.message || err) });
      this.sftpList(dirPath);
    });
  }

  async sftpDelete(dirPath, entry) {
    const sftp = await this.ensureSftp();
    if (!sftp) return;
    const target = dirPath + '/' + entry.name;
    if (entry.isDir) this.rmdir(sftp, target, (err) => {
      if (err) this.emit_('sftp-error', { message: String(err.message || err) });
      this.sftpList(dirPath);
    });
    else sftp.unlink(target, (err) => {
      if (err) this.emit_('sftp-error', { message: String(err.message || err) });
      this.sftpList(dirPath);
    });
  }

  rmdir(sftp, dir, cb) {
    sftp.readdir(dir, (err, list) => {
      if (err) return sftp.rmdir(dir, cb);
      let pending = list.length;
      if (!pending) return sftp.rmdir(dir, cb);
      let failed = false;
      for (const it of list) {
        const t = dir + '/' + it.filename;
        const done = (e) => {
          if (e && !failed) { failed = true; cb(e); }
          if (--pending === 0 && !failed) sftp.rmdir(dir, cb);
        };
        if (it.attrs.isDirectory()) this.rmdir(sftp, t, done);
        else sftp.unlink(t, done);
      }
    });
  }

  async sftpRename(dirPath, oldName, newName) {
    const sftp = await this.ensureSftp();
    if (!sftp) return;
    sftp.rename(dirPath + '/' + oldName, dirPath + '/' + newName, (err) => {
      if (err) return this.emit_('sftp-error', { message: String(err.message || err) });
      this.sftpList(dirPath);
    });
  }

  // 递归下载目录 / 文件到本地；this._active 统计未完成任务数，归零即完成
  async download(remotePath, localPath, isDir) {
    const sftp = await this.ensureSftp();
    if (!sftp) return this.emit_('transfer-error', { message: 'SFTP 不可用' });
    const path = require('path');
    this._active = (this._active || 0) + 1;
    const settle = () => {
      if (--this._active === 0) this.emit_('transfer-done', {});
    };
    if (!isDir) {
      return this.getWithProgress(sftp, remotePath, localPath, path.basename(remotePath), settle);
    }
    sftp.readdir(remotePath, (err, list) => {
      if (err) {
        this.emit_('transfer-error', { message: String(err.message || err) });
        return settle();
      }
      fs.mkdir(localPath, { recursive: true }, () => {
        if (!list.length) return settle();
        for (const it of list) {
          const rp = remotePath + '/' + it.filename;
          const lp = path.join(localPath, it.filename);
          if (it.attrs.isDirectory()) this.download(rp, lp, true);
          else {
            this._active++;
            this.getWithProgress(sftp, rp, lp, it.filename, () => {
              if (--this._active === 0) this.emit_('transfer-done', {});
            });
          }
        }
        settle();
      });
    });
  }

  getWithProgress(sftp, remote, local, label, cb) {
    sftp.stat(remote, (err, st) => {
      const total = err ? 0 : st.size;
      let last = 0;
      sftp.fastGet(remote, local, { step: (t) => {
        const now = Date.now();
        if (now - last > 200) {
          last = now;
          this.emit_('transfer-progress', { percent: total ? (t / total) * 100 : 0, label: label || require('path').basename(remote) });
        }
      } }, (e) => {
        if (e) this.emit_('transfer-error', { message: String(e.message || e) });
        if (cb) cb();
      });
    });
  }

  async upload(localPaths, remoteDir) {
    const sftp = await this.ensureSftp();
    if (!sftp) return this.emit_('transfer-error', { message: 'SFTP 不可用' });
    const path = require('path');
    let i = 0;
    const next = () => {
      if (i >= localPaths.length) return this.emit_('transfer-done', {});
      const lp = localPaths[i++];
      const name = path.basename(lp);
      let last = 0;
      sftp.fastPut(lp, remoteDir + '/' + name, { step: (t, chunk, total) => {
        const now = Date.now();
        if (now - last > 200) {
          last = now;
          this.emit_('transfer-progress', { percent: total ? (t / total) * 100 : 0, label: name });
        }
      } }, (err) => {
        if (err) this.emit_('transfer-error', { message: String(err.message || err) });
        next();
      });
    };
    next();
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    if (this.statsTimer) clearInterval(this.statsTimer);
    for (const server of this.forwards.values()) {
      try { server.close(); } catch (_) {}
    }
    this.forwards.clear();
    for (const s of this.shells.values()) {
      try { s.end(); } catch (_) {}
    }
    this.shells.clear();
    try { this.sftp && this.sftp.end(); } catch (_) {}
    try { this.client && this.client.end(); } catch (_) {}
    this.cleanupHops();
    this.emit_('status', { state: 'closed', message: reason || '' });
  }
}

module.exports = { SSHSession };
