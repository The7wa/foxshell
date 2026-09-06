'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { SSHSession } = require('./ssh');

let win = null;
const sessions = new Map(); // tabId -> SSHSession
const uid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- 本地连接数据持久化（AES 加密口令字段） ----------
const SECRET = crypto.createHash('sha256').update('foxshell-local-v1').digest();
function enc(t) {
  if (t === undefined || t === null || t === '') return '';
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', SECRET, iv);
  const out = Buffer.concat([c.update(String(t), 'utf8'), c.final()]);
  return iv.toString('base64') + ':' + out.toString('base64');
}
function dec(t) {
  if (!t) return '';
  try {
    const [iv, data] = t.split(':');
    const d = crypto.createDecipheriv('aes-256-cbc', SECRET, Buffer.from(iv, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch (_) {
    return '';
  }
}

function connFile() {
  return path.join(app.getPath('userData'), 'connections.json');
}
function loadConns() {
  try {
    return JSON.parse(fs.readFileSync(connFile(), 'utf8'));
  } catch (_) {
    return { connections: [] };
  }
}
function saveConns(data) {
  fs.mkdirSync(path.dirname(connFile()), { recursive: true });
  fs.writeFileSync(connFile(), JSON.stringify(data, null, 2), 'utf8');
}

function readKeyFile(p) {
  return new Promise((resolve, reject) => {
    fs.readFile(p, (err, buf) => (err ? reject(err) : resolve(buf)));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#1b1f24',
    title: 'FoxShell - SSH 终端',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

function toRenderer(type, tabId, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('ssh-event', { tabId, type, payload });
}

app.whenReady().then(() => {
  // ---------- 连接配置 ----------
  ipcMain.handle('conns:load', () => loadConns());
  ipcMain.handle('conns:save', (e, data) => {
    const list = data.connections || [];
    const groups = data.groups || [];
    const secrets = data.secrets || {};
    for (const c of list) {
      const s = secrets[c.id];
      if (s) {
        if (s.password) c.passwordEnc = enc(s.password);
        if (s.passphrase) c.passphraseEnc = enc(s.passphrase);
        if (s.jumpPassword) c.jumpPasswordEnc = enc(s.jumpPassword);
      }
    }
    saveConns({ connections: list, groups });
    return { connections: list, groups };
  });

  ipcMain.handle('app:pickKeyFile', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择私钥文件',
      properties: ['openFile'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // ---------- SSH 终端（一个连接可开多个终端面板） ----------
  ipcMain.handle('ssh:connect', async (e, { tabId, conn }) => {
    try {
      const cfg = {
        host: conn.host,
        port: conn.port || 22,
        username: conn.username || 'root',
        authType: conn.authType || 'password',
        password: dec(conn.passwordEnc),
        passphrase: dec(conn.passphraseEnc),
        jumpHost: conn.useJump ? conn.jumpHost || '' : '',
        jumpPort: conn.useJump ? conn.jumpPort || 22 : 22,
        jumpUsername: conn.useJump ? conn.jumpUsername || conn.username || 'root' : '',
        jumpPassword: conn.useJump ? dec(conn.jumpPasswordEnc) : '',
      };
      if (cfg.authType === 'key') {
        if (!conn.keyPath) throw new Error('未配置私钥文件');
        cfg.keyData = await readKeyFile(conn.keyPath);
      }
      const s = new SSHSession(tabId, (type, payload) => toRenderer(type, tabId, payload));
      sessions.set(tabId, s);
      s.connect(cfg);
      return { ok: true };
    } catch (err) {
      toRenderer('status', tabId, { state: 'failed', message: String(err.message || err) });
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.on('ssh:openPane', (e, { tabId, paneId }) => {
    const s = sessions.get(tabId);
    if (s) s.openShell(paneId);
  });
  ipcMain.on('ssh:input', (e, { tabId, paneId, data }) => {
    const s = sessions.get(tabId);
    if (s) s.write(paneId, data);
  });
  ipcMain.on('ssh:resize', (e, { tabId, paneId, cols, rows }) => {
    const s = sessions.get(tabId);
    if (s) s.resize(paneId, cols, rows);
  });
  ipcMain.on('ssh:closePane', (e, { tabId, paneId }) => {
    const s = sessions.get(tabId);
    if (s) s.closePane(paneId);
  });
  ipcMain.on('ssh:close', (e, { tabId }) => {
    const s = sessions.get(tabId);
    if (s) { s.close('用户断开连接'); sessions.delete(tabId); }
  });

  // ---------- 端口转发 ----------
  ipcMain.on('fwd:start', (e, { tabId, rule }) => {
    const s = sessions.get(tabId);
    if (s) s.startForward(rule);
  });
  ipcMain.on('fwd:stop', (e, { tabId, ruleId }) => {
    const s = sessions.get(tabId);
    if (s) s.stopForward(ruleId);
  });

  // ---------- 连接配置导入 / 导出 ----------
  ipcMain.handle('conns:export', async (e, { connections }) => {
    const r = await dialog.showSaveDialog(win, {
      title: '导出连接配置',
      defaultPath: 'foxshell-connections.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    const plain = connections.map((c) => ({
      ...c,
      password: dec(c.passwordEnc),
      passphrase: dec(c.passphraseEnc),
      jumpPassword: dec(c.jumpPasswordEnc),
    }));
    fs.writeFileSync(r.filePath, JSON.stringify({ type: 'foxshell-export', connections: plain }, null, 2), 'utf8');
    return { ok: true, path: r.filePath };
  });

  ipcMain.handle('conns:import', async (e, { existingIds }) => {
    const r = await dialog.showOpenDialog(win, {
      title: '导入连接配置',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    let data;
    try {
      data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    } catch (err) {
      return { ok: false, error: '文件不是有效的 JSON' };
    }
    const list = data.connections || data || [];
    if (!Array.isArray(list)) return { ok: false, error: '文件格式不正确' };
    const imported = list.filter((c) => c && c.host).map((c) => ({
      id: uid(),
      name: c.name || c.host,
      host: c.host,
      port: c.port || 22,
      username: c.username || 'root',
      group: c.group || '',
      authType: c.authType === 'key' ? 'key' : 'password',
      passwordEnc: enc(c.password),
      keyPath: c.keyPath || '',
      passphraseEnc: enc(c.passphrase),
      useJump: !!c.useJump,
      jumpHost: c.jumpHost || '',
      jumpPort: c.jumpPort || 22,
      jumpUsername: c.jumpUsername || '',
      jumpPasswordEnc: enc(c.jumpPassword),
      forwards: Array.isArray(c.forwards) ? c.forwards : [],
    }));
    return { ok: true, connections: imported, count: imported.length };
  });

  // ---------- 终端日志导出 ----------
  ipcMain.handle('app:saveText', async (e, { content, defaultName }) => {
    const r = await dialog.showSaveDialog(win, {
      title: '导出终端日志',
      defaultPath: defaultName || 'terminal.log',
    });
    if (r.canceled || !r.filePath) return { ok: false };
    fs.writeFileSync(r.filePath, content, 'utf8');
    return { ok: true, path: r.filePath };
  });

  // ---------- SFTP ----------
  const need = (tabId) => sessions.get(tabId);
  ipcMain.on('sftp:list', (e, { tabId, dirPath }) => {
    const s = need(tabId); if (s) s.sftpList(dirPath);
  });
  ipcMain.on('sftp:mkdir', (e, { tabId, dirPath, name }) => {
    const s = need(tabId); if (s) s.sftpMkdir(dirPath, name);
  });
  ipcMain.on('sftp:delete', (e, { tabId, dirPath, entry }) => {
    const s = need(tabId); if (s) s.sftpDelete(dirPath, entry);
  });
  ipcMain.on('sftp:rename', (e, { tabId, dirPath, oldName, newName }) => {
    const s = need(tabId); if (s) s.sftpRename(dirPath, oldName, newName);
  });

  ipcMain.handle('sftp:upload', async (e, { tabId, dirPath }) => {
    const s = need(tabId);
    if (!s) return { ok: false };
    const r = await dialog.showOpenDialog(win, {
      title: '选择要上传的文件',
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    s.upload(r.filePaths, dirPath);
    return { ok: true };
  });

  ipcMain.handle('sftp:download', async (e, { tabId, dirPath, entry }) => {
    const s = need(tabId);
    if (!s) return { ok: false };
    const r = await dialog.showSaveDialog(win, {
      title: '保存到',
      defaultPath: entry.name,
    });
    if (r.canceled || !r.filePath) return { ok: false };
    s.download(dirPath + '/' + entry.name, r.filePath, entry.isDir);
    return { ok: true };
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const s of sessions.values()) s.close();
  app.quit();
});
