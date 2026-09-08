'use strict';
const { app, BrowserWindow, ipcMain, dialog, safeStorage, session, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { SSHSession } = require('./ssh');

let win = null;
const sessions = new Map(); // tabId -> SSHSession
const uid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- 本地加密：随机主密钥（首启生成）+ 系统 DPAPI 保护 + AES-256-GCM ----------
// 主密钥为 32 字节随机数，本身用 safeStorage(Windows DPAPI，绑定当前系统用户)加密后存 foxshell.key。
// connections.json 与密钥文件分离：只偷走其中一个都无法解出密码。
let masterKey = null;

function keyFile() {
  return path.join(app.getPath('userData'), 'foxshell.key');
}

function loadMasterKey() {
  const file = keyFile();
  if (fs.existsSync(file)) {
    try {
      const b64 = safeStorage.decryptString(Buffer.from(fs.readFileSync(file, 'utf8'), 'base64'));
      const k = Buffer.from(b64, 'base64');
      if (k.length === 32) { masterKey = k; return; }
      throw new Error('密钥文件长度不正确');
    } catch (err) {
      throw new Error('无法解密本地密钥文件。FoxShell 不会自动覆盖该文件，请检查系统账户或凭据保护后重试。' + (err.message || err));
    }
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统不可用安全存储。为保证口令不以明文落盘，FoxShell 已拒绝启动。');
  }
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  masterKey = crypto.randomBytes(32);
  fs.writeFileSync(file, safeStorage.encryptString(masterKey.toString('base64')).toString('base64'), { encoding: 'utf8', mode: 0o600 });
}

function enc(t) {
  if (t === undefined || t === null || t === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([c.update(String(t), 'utf8'), c.final()]);
  return 'v2:' + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + ct.toString('base64');
}

function dec(t) {
  if (!t || !String(t).startsWith('v2:')) return '';
  try {
    const [, iv, tag, ct] = String(t).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', masterKey, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch (_) {
    return '';
  }
}

// 导入/导出文件单独加密：不把明文口令写盘，口令本身不保存
function deriveExportKey(password, salt) {
  return crypto.scryptSync(String(password || ''), Buffer.from(salt, 'base64'), 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

function encryptExportFile(obj, password) {
  if (!password) throw new Error('导出文件必须设置口令');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveExportKey(password, salt);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return {
    type: 'foxshell-export',
    format: 'encrypted',
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptExportFile(file, password) {
  if (!file || file.format !== 'encrypted' || !file.salt || !file.iv || !file.tag || !file.data) return null;
  try {
    const key = deriveExportKey(password, file.salt);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
    d.setAuthTag(Buffer.from(file.tag, 'base64'));
    const raw = Buffer.concat([d.update(Buffer.from(file.data, 'base64')), d.final()]);
    const obj = JSON.parse(raw.toString('utf8'));
    return Array.isArray(obj.connections) ? obj : null;
  } catch (_) {
    return null;
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

// 本地 known_hosts：记录用户首次确认过的服务器 SHA256 指纹，不包含口令
function knownHostsFile() {
  return path.join(app.getPath('userData'), 'known_hosts.json');
}

function readKnownHosts() {
  try {
    const data = JSON.parse(fs.readFileSync(knownHostsFile(), 'utf8'));
    return (data && data.hosts) || {};
  } catch (_) {
    return {};
  }
}

function writeKnownHosts(hosts) {
  fs.mkdirSync(path.dirname(knownHostsFile()), { recursive: true });
  fs.writeFileSync(knownHostsFile(), JSON.stringify({ version: 1, hosts }, null, 2), 'utf8');
}

function humanFingerprint(fp) {
  const hex = String(fp || '').toLowerCase();
  return hex.match(/.{1,2}/g) ? 'SHA256 ' + hex.match(/.{1,2}/g).join(':') : '';
}

function hostVerifierFor(host, port) {
  return (fingerprint, done) => {
    const fp = String(fingerprint || '').toLowerCase();
    const id = `${host}:${port || 22}`;
    const known = readKnownHosts();
    if (known[id] === fp) return done(true);
    if (known[id]) {
      console.warn(`FoxShell 已阻止主机指纹变化：${id}`);
      dialog.showMessageBox(win, {
        type: 'warning',
        title: '主机指纹已变化',
        message: `已阻止连接 ${id}`,
        detail: `之前信任的 SHA256 指纹与服务器当前返回不一致。\n这可能是服务器重装或中间人攻击。\n\n如需信任新指纹，请删除 ${knownHostsFile()} 中对应项后重试。`,
        buttons: ['确定'],
        defaultId: 0,
        noLink: true,
      }).catch(() => {});
      return done(false);
    }
    dialog.showMessageBox(win, {
      type: 'question',
      title: '首次连接确认',
      message: `是否信任 ${id} 的主机指纹？`,
      detail: `服务器指纹（SHA256）：\n${humanFingerprint(fp)}\n\n请仅在确认这是目标服务器后信任。指纹只保存在本机。`,
      buttons: ['信任并连接', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    }).then((r) => {
      if (r.response !== 0) return done(false);
      const hosts = readKnownHosts();
      hosts[id] = fp;
      writeKnownHosts(hosts);
      done(true);
    }).catch(() => done(false));
  };
}

// 结构迁移：旧单跳板机字段 → jumps 数组。口令只接受当前 v2 随机密钥格式。
function migrateConns() {
  const data = loadConns();
  let dirty = false;
  for (const c of data.connections || []) {
    if (c.useJump && c.jumpHost && !Array.isArray(c.jumps)) {
      c.jumps = [{
        host: c.jumpHost,
        port: c.jumpPort || 22,
        username: c.jumpUsername || c.username || 'root',
        passwordEnc: String(c.jumpPasswordEnc || '').startsWith('v2:') ? c.jumpPasswordEnc : '',
      }];
      dirty = true;
    }
    delete c.useJump; delete c.jumpHost; delete c.jumpPort;
    delete c.jumpUsername; delete c.jumpPasswordEnc;
    for (const hop of c.jumps || []) {
      if (hop.passwordEnc && !String(hop.passwordEnc).startsWith('v2:')) {
        hop.passwordEnc = '';
        dirty = true;
      }
    }
  }
  if (dirty) saveConns(data);
  return data;
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
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

function hardenWindowContents(contents) {
  // 渲染进程只允许加载程序自身的本地页面，禁止页面自行跳转或打开新窗口。
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function enableLocalOnlyRendererNetwork() {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest((details, callback) => {
    const local = details.url.startsWith('file:') || details.url.startsWith('data:') || details.url.startsWith('devtools:');
    callback({ cancel: !local });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

function verifySecretStorage(err) {
  dialog.showErrorBox('FoxShell 安全保护不可用', String(err && err.message ? err.message : err));
  app.quit();
}

function toRenderer(type, tabId, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('ssh-event', { tabId, type, payload });
}

app.whenReady().then(() => {
  try {
    loadMasterKey();
  } catch (err) {
    verifySecretStorage(err);
    return;
  }
  enableLocalOnlyRendererNetwork();
  app.on('web-contents-created', (_event, contents) => hardenWindowContents(contents));

  // ---------- 连接配置 ----------
  ipcMain.handle('conns:load', () => migrateConns());
  ipcMain.handle('conns:save', (e, data) => {
    const list = data.connections || [];
    const groups = data.groups || [];
    const secrets = data.secrets || {};
    for (const c of list) {
      const s = secrets[c.id];
      if (s) {
        if (s.password) c.passwordEnc = enc(s.password);
        if (s.passphrase) c.passphraseEnc = enc(s.passphrase);
      }
      // 跳板机链：每个跳板机自己的密码
      (secrets.jumps || {})[c.id]?.forEach((pw, i) => {
        if (pw && c.jumps && c.jumps[i]) c.jumps[i].passwordEnc = enc(pw);
      });
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
        hostHash: 'sha256',
        hostVerifier: hostVerifierFor(conn.host, conn.port || 22),
        jumps: [],
      };
      for (const j of conn.jumps || []) {
        const saved = j.sourceConnectionId
          ? (loadConns().connections || []).find((c) => c.id === j.sourceConnectionId)
          : null;
        if (j.sourceConnectionId && !saved) {
          throw new Error(`跳板机引用的已保存主机不存在：${j.sourceConnectionId}`);
        }
        const source = saved || j;
        const authType = source.authType || 'password';
        const hop = {
          host: source.host,
          port: source.port || 22,
          username: source.username || conn.username || 'root',
          authType,
          password: dec(source.passwordEnc),
          passphrase: dec(source.passphraseEnc),
          hostHash: 'sha256',
          hostVerifier: hostVerifierFor(source.host, source.port || 22),
        };
        if (authType === 'key') {
          if (!source.keyPath) throw new Error(`跳板机 ${source.name || source.host} 未配置私钥文件`);
          hop.keyData = await readKeyFile(source.keyPath);
        }
        cfg.jumps.push(hop);
      }
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

  ipcMain.on('ssh:openPane', (e, { tabId, paneId, cols, rows }) => {
    const s = sessions.get(tabId);
    if (s) s.openShell(paneId, cols, rows);
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
  ipcMain.handle('conns:export', async (e, { connections, password }) => {
    const r = await dialog.showSaveDialog(win, {
      title: '导出连接配置',
      defaultPath: 'foxshell-connections.foxshell',
      filters: [{ name: 'FoxShell', extensions: ['foxshell', 'json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    try {
      const plain = connections.map((c) => ({
        name: c.name,
        host: c.host,
        port: c.port || 22,
        username: c.username || 'root',
        group: c.group || '',
        authType: c.authType || 'password',
        password: dec(c.passwordEnc),
        keyPath: c.keyPath || '',
        passphrase: dec(c.passphraseEnc),
        jumps: (c.jumps || []).map((j) => {
          // 导出时把“引用已保存主机”展开，避免导入后因连接 ID 改变而失效。
          const source = j.sourceConnectionId
            ? connections.find((x) => x.id === j.sourceConnectionId)
            : null;
          const hop = source || j;
          return {
            host: hop.host,
            port: hop.port || 22,
            username: hop.username || '',
            authType: hop.authType || 'password',
            password: dec(hop.passwordEnc),
            keyPath: hop.keyPath || '',
            passphrase: dec(hop.passphraseEnc),
          };
        }),
        forwards: Array.isArray(c.forwards) ? c.forwards : [],
      }));
      const payload = encryptExportFile({ version: 1, connections: plain }, password);
      fs.writeFileSync(r.filePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
    return { ok: true, path: r.filePath };
  });

  ipcMain.handle('conns:import', async (e, { existingIds, password, filePath }) => {
    let importPath = filePath;
    if (!importPath) {
      const r = await dialog.showOpenDialog(win, {
        title: '导入连接配置',
        filters: [{ name: 'FoxShell', extensions: ['foxshell', 'json'] }],
        properties: ['openFile'],
      });
      if (r.canceled || !r.filePaths.length) return { ok: false };
      importPath = r.filePaths[0];
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(importPath, 'utf8'));
    } catch (err) {
      return { ok: false, error: '文件不是有效的 JSON' };
    }
    let list;
    if (data && data.format === 'encrypted') {
      if (!password) return { ok: false, error: '需要输入导出口令', needsPassword: true, path: importPath };
      const decrypted = decryptExportFile(data, password);
      if (!decrypted) return { ok: false, error: '导出口令错误或文件已损坏' };
      list = decrypted.connections;
    } else {
      list = data && Array.isArray(data.connections) ? data.connections : Array.isArray(data) ? data : [];
    }
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
      jumps: (Array.isArray(c.jumps)
        ? c.jumps
        : (c.useJump && c.jumpHost
          ? [{ host: c.jumpHost, port: c.jumpPort || 22, username: c.jumpUsername || c.username || 'root', password: c.jumpPassword || '' }]
          : [])
      ).filter((j) => j && j.host).map((j) => ({
        host: j.host,
        port: j.port || 22,
        username: j.username || c.username || 'root',
        passwordEnc: enc(j.password),
        authType: j.authType === 'key' ? 'key' : 'password',
        keyPath: j.keyPath || '',
        passphraseEnc: enc(j.passphrase),
      })),
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

  ipcMain.handle('sftp:uploadPaths', (e, { tabId, dirPath, paths }) => {
    const s = need(tabId);
    if (!s) return { ok: false, error: '连接未建立' };
    const list = (Array.isArray(paths) ? paths : [])
      .filter((p) => typeof p === 'string' && p.length && fs.existsSync(p));
    if (!list.length) return { ok: false, error: '没有可上传的有效文件' };
    s.upload(list, dirPath || null);
    return { ok: true };
  });

  ipcMain.handle('clip:copy', (e, text) => {
    if (typeof text === 'string' && text) clipboard.writeText(text);
    return { ok: true };
  });

  ipcMain.handle('clip:paste', () => clipboard.readText());

  ipcMain.on('sftp:home', (e, { tabId }) => {
    const s = need(tabId);
    if (s) s.sftpHome();
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
