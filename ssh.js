'use strict';
const { Client } = require('ssh2');
const { EventEmitter } = require('events');
const fs = require('fs');

const RAW_STATS_CMD =
  "cat /proc/stat;echo '##FS-MEM';cat /proc/meminfo;echo '##FS-NET';cat /proc/net/dev;echo '##FS-LOAD';cat /proc/loadavg;echo '##FS-DF';df -kP /;echo '##FS-UP';cat /proc/uptime;echo '##FS-END'";

const STATS_INTERVAL = 2000;

// 把路径安全地包进单引号，用于远端 shell
function q(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

class SSHSession extends EventEmitter {
  constructor(tabId, send) {
    super();
    this.tabId = tabId;
    this.send = send; // (type, payload) => webContents.send('ssh-event', {tabId, type, payload})
    this.client = null;
    this.sftp = null;
    this.stream = null;
    this.statsTimer = null;
    this.prev = null; // 上一帧 cpu/net 采样
    this.closed = false;
  }

  emit_(type, payload) {
    this.send(type, payload);
  }

  connect(cfg) {
    const c = new Client();
    this.client = c;
    const opts = {
      host: cfg.host,
      port: Number(cfg.port) || 22,
      username: cfg.username,
      readyTimeout: 15000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
    };
    if (cfg.authType === 'key') {
      opts.privateKey = cfg.keyData; // Buffer
      if (cfg.passphrase) opts.passphrase = cfg.passphrase;
    } else {
      opts.password = cfg.password;
    }

    c.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
      finish([cfg.password || '']);
    });

    c.on('ready', () => {
      this.emit_('status', { state: 'connected' });
      c.shell({ term: 'xterm-256color' }, (err, stream) => {
        if (err) return this.emit_('status', { state: 'failed', message: String(err.message || err) });
        this.stream = stream;
        stream.on('data', (d) => this.emit_('data', d.toString('base64')));
        stream.on('close', () => this.close('会话已关闭'));
      });
      c.sftp((err, sftp) => {
        if (err) return;
        this.sftp = sftp;
        this.emit_('sftp-ready', {});
        this.startStats(cfg);
      });
    });

    c.on('error', (err) => {
      if (!this.closed) this.emit_('status', { state: 'failed', message: String(err.message || err) });
    });
    c.on('close', () => {
      if (!this.closed) this.close('连接已断开');
    });

    this.emit_('status', { state: 'connecting' });
    c.connect(opts);
  }

  write(data) {
    if (this.stream) this.stream.write(data);
  }

  resize(cols, rows) {
    if (this.stream) {
      try { this.stream.setWindow(rows, cols, 0, 0); } catch (_) {}
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
    const statText = sec('##FS-END') && out.indexOf('cpu ') === 0 || true; // /proc/stat 是第一段
    const cpuLine = /^cpu\s+([\d\s]+)/m.exec(out);
    const vals = cpuLine[1].trim().split(/\s+/).map(Number);
    const user = vals[0], nice = vals[1], sys = vals[2], idle = vals[3] + (vals[4] || 0);
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

  // ---------- SFTP ----------
  sftpList(dirPath) {
    if (!this.sftp) return this.emit_('sftp-error', { message: 'SFTP 未就绪' });
    const p = dirPath || '.';
    this.sftp.realpath(p, (err, abs) => {
      const cwd = err ? p : abs;
      this.sftp.readdir(cwd, (e2, list) => {
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

  sftpMkdir(dirPath, name) {
    if (!this.sftp) return;
    this.sftp.mkdir(dirPath + '/' + name, (err) => {
      if (err) return this.emit_('sftp-error', { message: String(err.message || err) });
      this.sftpList(dirPath);
    });
  }

  sftpDelete(dirPath, entry) {
    if (!this.sftp) return;
    const target = dirPath + '/' + entry.name;
    if (entry.isDir) this.rmdir(target, (err) => {
      if (err) this.emit_('sftp-error', { message: String(err.message || err) });
      this.sftpList(dirPath);
    });
    else this.sftp.unlink(target, (err) => {
      if (err) this.emit_('sftp-error', { message: String(err.message || err) });
      this.sftpList(dirPath);
    });
  }

  rmdir(dir, cb) {
    this.sftp.readdir(dir, (err, list) => {
      if (err) return this.sftp.rmdir(dir, cb);
      let pending = list.length;
      if (!pending) return this.sftp.rmdir(dir, cb);
      let failed = false;
      for (const it of list) {
        const t = dir + '/' + it.filename;
        const done = (e) => {
          if (e && !failed) { failed = true; cb(e); }
          if (--pending === 0 && !failed) this.sftp.rmdir(dir, cb);
        };
        if (it.attrs.isDirectory()) this.rmdir(t, done);
        else this.sftp.unlink(t, done);
      }
    });
  }

  sftpRename(dirPath, oldName, newName) {
    if (!this.sftp) return;
    this.sftp.rename(dirPath + '/' + oldName, dirPath + '/' + newName, (err) => {
      if (err) return this.emit_('sftp-error', { message: String(err.message || err) });
      this.sftpList(dirPath);
    });
  }

  // 递归下载目录 / 文件到本地；this._active 统计未完成任务数，归零即完成
  download(remotePath, localPath, isDir) {
    if (!this.sftp) return;
    const path = require('path');
    this._active = (this._active || 0) + 1;
    const settle = () => {
      if (--this._active === 0) this.emit_('transfer-done', {});
    };
    if (!isDir) {
      return this.getWithProgress(remotePath, localPath, path.basename(remotePath), settle);
    }
    this.sftp.readdir(remotePath, (err, list) => {
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
            this.getWithProgress(rp, lp, it.filename, () => {
              if (--this._active === 0) this.emit_('transfer-done', {});
            });
          }
        }
        settle();
      });
    });
  }

  getWithProgress(remote, local, label, cb) {
    this.sftp.stat(remote, (err, st) => {
      const total = err ? 0 : st.size;
      let last = 0;
      this.sftp.fastGet(remote, local, { step: (t, chunk) => {
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

  upload(localPaths, remoteDir) {
    if (!this.sftp) return;
    const path = require('path');
    let i = 0;
    const next = () => {
      if (i >= localPaths.length) return this.emit_('transfer-done', {});
      const lp = localPaths[i++];
      const name = path.basename(lp);
      let last = 0;
      this.sftp.fastPut(lp, remoteDir + '/' + name, { step: (t, chunk, total) => {
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
    try { this.stream && this.stream.end(); } catch (_) {}
    try { this.sftp && this.sftp.end(); } catch (_) {}
    try { this.client && this.client.end(); } catch (_) {}
    this.emit_('status', { state: 'closed', message: reason || '' });
  }
}

module.exports = { SSHSession, q };
