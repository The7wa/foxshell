'use strict';
/* global Terminal, FitAddon */

// ---------------- 状态 ----------------
let conns = [];
let tabs = new Map();
let activeTabId = null;
let sftpVisible = false;
let cmdVisible = false;
let editingConnId = null;
let pickedKeyPath = null;

const $ = (id) => document.getElementById(id);
const uid = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
};

// 折叠的分组、空的分组、快捷命令都存 localStorage
let collapsedGroups = store.get('foxshell.collapsed', []);
let extraGroups = store.get('foxshell.groups', []);

const DEFAULT_CMDS = [
  { name: '磁盘占用', cmd: 'df -h' },
  { name: '内存使用', cmd: 'free -h' },
  { name: '系统负载', cmd: 'uptime' },
  { name: '端口监听', cmd: 'ss -tulnp' },
  { name: '进程 TOP15 (按CPU)', cmd: 'ps aux --sort=-%cpu | head -16' },
  { name: '登录记录', cmd: 'last -20' },
  { name: '失败登录', cmd: 'lastb -20 2>/dev/null | head -20' },
  { name: '系统日志 50 行', cmd: 'journalctl -n 50 --no-pager' },
];
let cmdList = store.get('foxshell.cmds', null) || DEFAULT_CMDS.map((c) => ({ ...c }));

// ---------------- 工具 ----------------
function b64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function humanSize(n) {
  if (n == null) return '--';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i];
}
function humanUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}天${h}时` : h > 0 ? `${h}时${m}分` : `${m}分`;
}
function fmtTime(ms) {
  if (!ms) return '--';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function parentPath(p) {
  if (!p || p === '/') return '/';
  const q = p.replace(/\/+$/, '');
  const idx = q.lastIndexOf('/');
  return idx <= 0 ? '/' : q.slice(0, idx);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function toast(msg, bad) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = `position:fixed;top:14px;left:50%;transform:translateX(-50%);
    background:${bad ? '#5b2422' : '#24422b'};color:#eee;padding:8px 18px;border-radius:8px;
    font-size:13px;z-index:99;box-shadow:0 4px 16px rgba(0,0,0,.4);transition:opacity .4s;max-width:70%;`;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; }, 2200);
  setTimeout(() => t.remove(), 2700);
}
function allGroupNames() {
  return [...new Set([...extraGroups, ...conns.map((c) => c.group || '')])].filter((g) => g !== '');
}

// ---------------- 初始化 ----------------
async function init() {
  const data = await window.api.loadConns();
  conns = data.connections || [];
  extraGroups = [...new Set([...extraGroups, ...(data.groups || [])])];
  window.api.onEvent(handleEvent);
  bindUI();
  restorePanelWidths();
  renderConnList();
  renderCmdList();
}

async function persist() {
  const updated = await window.api.saveConns({
    connections: conns,
    groups: allGroupNames(),
    secrets: {},
  });
  if (updated && updated.connections) conns = updated.connections;
}

// ---------------- 连接列表（文件夹分组 + 拖拽归组） ----------------
function renderConnList() {
  const filter = $('searchBox').value.trim().toLowerCase();
  const list = $('connList');
  list.innerHTML = '';

  if (!conns.length && !extraGroups.length) {
    list.innerHTML = '<div class="empty-list">还没有服务器连接<br>点击下方「新建连接」添加</div>';
    return;
  }
  const shown = conns.filter((c) =>
    !filter || c.name.toLowerCase().includes(filter) || c.host.toLowerCase().includes(filter));
  if (!shown.length && filter) {
    list.innerHTML = '<div class="empty-list">没有匹配的主机</div>';
    return;
  }

  // 分组：命名分组在前（按名称），未分组最后
  const gmap = new Map();
  for (const g of allGroupNames().sort((a, b) => a.localeCompare(b))) gmap.set(g, []);
  for (const c of shown) {
    const g = c.group || '';
    if (!gmap.has(g)) gmap.set(g, []);
    gmap.get(g).push(c);
  }
  if (gmap.has('')) {
    const un = gmap.get('');
    gmap.delete('');
    gmap.set('', un); // 未分组放最后
  }

  for (const [g, items] of gmap) {
    if (g === '' && !items.length) continue; // 空的未分组不显示
    list.appendChild(groupHeaderEl(g, items.length));
    if (!collapsedGroups.includes(g)) {
      for (const c of items) list.appendChild(connItemEl(c));
    }
  }
}

function groupHeaderEl(g, count) {
  const isCollapsed = collapsedGroups.includes(g);
  const el = document.createElement('div');
  el.className = 'conn-group' + (isCollapsed ? ' collapsed' : '');
  el.dataset.group = g;
  el.innerHTML = `
    <span class="caret">${isCollapsed ? '▸' : '▾'}</span>
    <span>${isCollapsed ? '📁' : '📂'}</span>
    <span class="gname">${escapeHtml(g || '未分组')}</span>
    <span class="gcount">${count}</span>
    <span class="gactions">${g ? '<button data-act="gren" title="重命名分组">✎</button><button data-act="gdel" title="删除分组（连接移到未分组）">🗑</button>' : ''}</span>`;
  el.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    collapsedGroups = isCollapsed
      ? collapsedGroups.filter((x) => x !== g)
      : [...collapsedGroups, g];
    store.set('foxshell.collapsed', collapsedGroups);
    renderConnList();
  });
  // 拖拽归组
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('dragover'); });
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('dragover');
    const id = e.dataTransfer.getData('text/plain');
    const c = conns.find((x) => x.id === id);
    if (!c) return;
    if ((c.group || '') === g) return;
    c.group = g;
    await persist();
    renderConnList();
    toast(`已把「${c.name}」移到「${g || '未分组'}」`);
  });
  const ren = el.querySelector('[data-act=gren]');
  if (ren) ren.addEventListener('click', async (e) => {
    e.stopPropagation();
    askText('重命名分组', g, async (name) => {
      if (!name || name === g) return;
      for (const c of conns) if ((c.group || '') === g) c.group = name;
      extraGroups = extraGroups.map((x) => (x === g ? name : x));
      collapsedGroups = collapsedGroups.map((x) => (x === g ? name : x));
      store.set('foxshell.groups', extraGroups);
      store.set('foxshell.collapsed', collapsedGroups);
      await persist();
      renderConnList();
    });
  });
  const del = el.querySelector('[data-act=gdel]');
  if (del) del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`删除分组「${g}」？组内 ${count} 个连接将移到「未分组」。`)) return;
    for (const c of conns) if ((c.group || '') === g) c.group = '';
    extraGroups = extraGroups.filter((x) => x !== g);
    collapsedGroups = collapsedGroups.filter((x) => x !== g);
    store.set('foxshell.groups', extraGroups);
    store.set('foxshell.collapsed', collapsedGroups);
    await persist();
    renderConnList();
  });
  return el;
}

function connItemEl(c) {
  const tabOf = [...tabs.values()].find((t) => t.connId === c.id);
  const st = tabOf ? tabOf.state : null;
  const el = document.createElement('div');
  el.className = 'conn-item';
  el.title = `${c.username}@${c.host}:${c.port}`;
  el.draggable = true;
  const dotCls = st === 'connected' ? 'on' : st === 'connecting' ? 'busy'
    : (st === 'closed' || st === 'failed') ? 'off' : '';
  el.innerHTML = `
    <span class="dot ${dotCls}"></span>
    <span class="cname">${escapeHtml(c.name)}</span>
    <span class="actions">
      <button data-act="clone" title="克隆连接">⧉</button>
      <button data-act="edit" title="编辑">✎</button>
      <button data-act="del" title="删除">🗑</button>
    </span>`;
  el.addEventListener('dblclick', () => connectConn(c));
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', c.id);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.querySelector('[data-act=clone]').addEventListener('click', (e) => { e.stopPropagation(); openConnDialog(c, true); });
  el.querySelector('[data-act=edit]').addEventListener('click', (e) => { e.stopPropagation(); openConnDialog(c); });
  el.querySelector('[data-act=del]').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`删除连接「${c.name}」？`)) return;
    conns = conns.filter((x) => x.id !== c.id);
    await persist();
    renderConnList();
  });
  return el;
}

// ---------------- 连接对话框 ----------------
function openConnDialog(conn, clone) {
  editingConnId = conn && !clone ? conn.id : null;
  pickedKeyPath = conn ? conn.keyPath || null : null;
  $('connDialogTitle').textContent = clone ? '克隆连接' : conn ? '编辑连接' : '新建连接';
  const f = $('connForm');
  const F = (n) => f.elements[n];
  F('name').value = conn ? (clone ? conn.name + ' 副本' : conn.name) : '';
  F('host').value = conn ? conn.host : '';
  F('port').value = conn ? conn.port || 22 : 22;
  F('username').value = conn ? conn.username : 'root';
  F('group').value = conn ? conn.group || '' : '';
  F('authType').value = conn ? conn.authType || 'password' : 'password';
  F('password').value = '';
  F('passphrase').value = '';
  F('password').placeholder = conn && !clone ? '留空则保持原密码' : '';
  $('keyPathText').value = pickedKeyPath || '';
  $('groupSuggestions').innerHTML = allGroupNames().map((g) => `<option value="${escapeHtml(g)}">`).join('');
  toggleAuthRows();
  $('connDialog').showModal();
}

function toggleAuthRows() {
  const isKey = $('authTypeSel').value === 'key';
  $('rowPassword').style.display = isKey ? 'none' : '';
  $('rowKey').style.display = isKey ? '' : 'none';
}

async function saveConnForm(e) {
  e.preventDefault();
  try {
    const f = $('connForm');
    const F = (n) => f.elements[n];
    const id = editingConnId || uid().replace('t', 'c');
    const old = conns.find((c) => c.id === id);
    const group = F('group').value.trim();
    const rec = {
      id,
      name: F('name').value.trim() || F('host').value.trim(),
      host: F('host').value.trim(),
      port: Number(F('port').value) || 22,
      username: F('username').value.trim() || 'root',
      group,
      authType: F('authType').value,
      passwordEnc: old ? old.passwordEnc : '',
      keyPath: F('authType').value === 'key' ? pickedKeyPath : '',
      passphraseEnc: old ? old.passphraseEnc : '',
    };
    if (!rec.keyPath && rec.authType === 'key') {
      toast('请选择私钥文件', true);
      return;
    }
    if (group && !allGroupNames().includes(group)) extraGroups = [...extraGroups, group];
    const secrets = { [id]: { password: F('password').value, passphrase: F('passphrase').value } };
    if (old) conns = conns.map((c) => (c.id === id ? rec : c));
    else conns.push(rec);
    store.set('foxshell.groups', extraGroups);
    const updated = await window.api.saveConns({ connections: conns, groups: allGroupNames(), secrets });
    if (updated && updated.connections) conns = updated.connections;
    $('connDialog').close();
    renderConnList();
    toast('连接配置已保存');
  } catch (err) {
    toast('保存失败：' + (err.message || err), true);
  }
}

// ---------------- 标签页 / 终端 ----------------
function connectConn(conn) {
  const existing = [...tabs.values()].find((t) => t.connId === conn.id && t.state !== 'closed');
  if (existing) return activateTab(existing.id);
  createTab(conn);
}

function createTab(conn) {
  const id = uid();
  const wrap = document.createElement('div');
  wrap.className = 'term-wrap hidden';
  $('termStack').appendChild(wrap);

  const term = new Terminal({
    fontSize: store.get('foxshell.font', 13),
    fontFamily: 'Consolas, "Courier New", monospace',
    cursorBlink: true,
    scrollback: 5000,
    theme: {
      background: '#101418',
      foreground: '#d6dce2',
      cursor: '#3d9a50',
      selectionBackground: '#2f81f766',
      black: '#101418', red: '#e5534b', green: '#57ab5a', yellow: '#c69026',
      blue: '#539bf5', magenta: '#b083f0', cyan: '#39c5cf', white: '#d6dce2',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(wrap);
  term.onData((d) => window.api.input(id, d));
  term.onResize(({ cols, rows }) => window.api.resize(id, cols, rows));
  term.writeln(`正在连接 ${conn.username}@${conn.host}:${conn.port} ...`);

  const tab = {
    id,
    connId: conn.id,
    conn,
    title: conn.name || conn.host,
    state: 'connecting',
    term,
    wrap,
    fit,
    stats: null,
    sftp: { started: false, cwd: null, entries: [], selected: null },
  };
  tabs.set(id, tab);
  renderTabs();
  activateTab(id);
  window.api.connect(id, conn);
}

function activateTab(id) {
  activeTabId = id;
  for (const [tid, tab] of tabs) tab.wrap.classList.toggle('hidden', tid !== id);
  renderTabs();
  const tab = tabs.get(id);
  if (tab) {
    try { tab.fit.fit(); tab.term.focus(); } catch (_) {}
  }
  renderMonitor();
  refreshSftpPanel();
  updateDisconnectBtn();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  window.api.close(id);
  tab.term.dispose();
  tab.wrap.remove();
  tabs.delete(id);
  if (activeTabId === id) {
    const rest = [...tabs.keys()];
    if (rest.length) activateTab(rest[rest.length - 1]);
    else {
      activeTabId = null;
      $('welcome').classList.remove('hidden');
      renderTabs();
      renderMonitor();
      refreshSftpPanel();
      updateDisconnectBtn();
    }
  } else renderTabs();
}

function renderTabs() {
  const box = $('tabs');
  box.innerHTML = '';
  for (const [id, tab] of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (id === activeTabId ? ' active' : '');
    const dotCls = tab.state === 'connected' ? 'on' : tab.state === 'connecting' ? 'busy' : 'off';
    el.innerHTML = `<span class="tdot ${dotCls}"></span>
      <span class="tname">${escapeHtml(tab.title)}</span>
      <button class="tclose" title="关闭">✕</button>`;
    el.addEventListener('click', () => activateTab(id));
    el.querySelector('.tclose').addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
    box.appendChild(el);
  }
  $('welcome').classList.toggle('hidden', tabs.size > 0);
}

function updateDisconnectBtn() {
  const tab = tabs.get(activeTabId);
  const b = $('btnDisconnect');
  if (tab && tab.state === 'closed') {
    b.textContent = '↻ 重连';
    b.classList.add('active');
  } else {
    b.textContent = '⏻ 断开';
    b.classList.remove('active');
  }
}

function disconnectOrReconnect() {
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  if (tab.state === 'closed') {
    const conn = tab.conn;
    closeTab(tab.id);
    connectConn(conn);
  } else {
    window.api.close(tab.id);
    tab.term.writeln('\r\n\x1b[33m--- 已手动断开，点击右上角「重连」重新连接 ---\x1b[0m');
    tab.state = 'closed';
    renderTabs();
    renderMonitor();
    updateDisconnectBtn();
  }
}

// ---------------- 主进程事件 ----------------
function handleEvent(evt) {
  const tab = tabs.get(evt.tabId);
  if (!tab) return;
  const { type, payload } = evt;
  if (type === 'data') {
    tab.term.write(b64ToBytes(payload));
  } else if (type === 'status') {
    tab.state = payload.state;
    if (payload.state === 'connected') {
      tab.term.writeln('\x1b[32m连接成功。\x1b[0m');
      if (tab.id === activeTabId) { try { tab.fit.fit(); tab.term.focus(); } catch (_) {} }
    } else if (payload.state === 'failed') {
      tab.term.writeln(`\r\n\x1b[31m连接失败：${payload.message || '未知错误'}\x1b[0m`);
    } else if (payload.state === 'closed' && payload.message) {
      tab.term.writeln(`\r\n\x1b[33m${payload.message}\x1b[0m`);
    }
    renderTabs();
    renderConnList();
    if (tab.id === activeTabId) { renderMonitor(); updateDisconnectBtn(); }
  } else if (type === 'stats') {
    tab.stats = payload;
    if (tab.id === activeTabId) renderMonitor();
  } else if (type === 'sftp-ready') {
    tab.sftp.started = true;
    refreshSftpPanel();
  } else if (type === 'sftp-list') {
    tab.sftp.cwd = payload.cwd;
    tab.sftp.entries = payload.entries;
    tab.sftp.selected = null;
    if (tab.id === activeTabId) renderSftpList();
  } else if (type === 'sftp-error') {
    toast('SFTP: ' + payload.message, true);
  } else if (type === 'transfer-progress') {
    $('transferBar').classList.remove('hidden');
    $('transferLabel').textContent = payload.label || '传输中';
    $('transferFill').style.width = payload.percent.toFixed(1) + '%';
  } else if (type === 'transfer-done') {
    $('transferFill').style.width = '100%';
    setTimeout(() => {
      $('transferBar').classList.add('hidden');
      $('transferFill').style.width = '0%';
      const t = tabs.get(activeTabId);
      if (t) window.api.sftpList(activeTabId, t.sftp.cwd);
    }, 600);
  } else if (type === 'transfer-error') {
    toast('传输失败：' + payload.message, true);
  }
}

// ---------------- 监控栏 ----------------
function renderMonitor() {
  const status = $('monStatus');
  const tab = tabs.get(activeTabId);
  const setBar = (el, pct) => {
    const fill = el.querySelector('.bar-fill');
    fill.style.width = Math.min(100, pct) + '%';
    fill.className = 'bar-fill' + (pct >= 85 ? ' hot' : pct >= 60 ? ' warn' : '');
  };
  if (!tab) { status.textContent = '未连接'; status.className = ''; return; }
  if (tab.state !== 'connected') {
    status.textContent = tab.state === 'connecting' ? '连接中...' :
      tab.state === 'failed' ? '连接失败' : '已断开';
    status.className = tab.state === 'failed' ? 'err' : '';
    setBar($('monCpu'), 0); setBar($('monMem'), 0);
    $('monNet').textContent = '↓ -- ↑ --';
    $('monDisk').textContent = '--';
    $('monLoad').textContent = '--';
    $('monUptime').textContent = '--';
    return;
  }
  const s = tab.stats;
  status.textContent = `${tab.conn.username}@${tab.conn.host}`;
  status.className = 'ok';
  if (!s || !s.supported) {
    $('monDisk').textContent = '监控不可用';
    return;
  }
  const cpuPct = s.cpu, memPct = s.memTotal ? (s.memUsed / s.memTotal) * 100 : 0;
  setBar($('monCpu'), cpuPct);
  setBar($('monMem'), memPct);
  $('monCpu').querySelector('.mon-val').textContent = cpuPct.toFixed(1) + '%';
  $('monMem').querySelector('.mon-val').textContent = `${humanSize(s.memUsed)} / ${humanSize(s.memTotal)}`;
  $('monNet').textContent = `↓ ${humanSize(s.rxRate)}/s ↑ ${humanSize(s.txRate)}/s`;
  $('monDisk').textContent = `${s.diskPct}% (${humanSize(s.diskUsed)}/${humanSize(s.diskTotal)})`;
  $('monLoad').textContent = s.load;
  $('monUptime').textContent = humanUptime(s.uptime);
}

// ---------------- 面板显示/隐藏 与 宽度拖拽 ----------------
function refreshSftpPanel() {
  $('sftpPanel').classList.toggle('hidden', !sftpVisible);
  $('sftpSplitter').classList.toggle('hidden', !sftpVisible);
  $('btnToggleSftp').classList.toggle('active', sftpVisible);
  if (!sftpVisible) return;
  const tab = tabs.get(activeTabId);
  if (!tab || !tab.sftp.started) {
    $('sftpList').innerHTML = '<div id="sftpEmpty">未连接服务器，<br>无法使用文件管理</div>';
    $('sftpPath').value = '';
    return;
  }
  if (tab.sftp.cwd == null) window.api.sftpList(activeTabId, null);
  else renderSftpList();
}

function refreshCmdPanel() {
  $('cmdPanel').classList.toggle('hidden', !cmdVisible);
  $('cmdSplitter').classList.toggle('hidden', !cmdVisible);
  $('btnToggleCmd').classList.toggle('active', cmdVisible);
}

function makeVResizable(handle, panel, { dir, min, max, key }) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    const onMove = (ev) => {
      let w = dir === 'left' ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX);
      w = Math.max(min, Math.min(max, w));
      panel.style.width = w + 'px';
      panel.style.minWidth = w + 'px';
      panel.style.maxWidth = w + 'px';
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      store.set(key, panel.getBoundingClientRect().width);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function applyWidth(panel, w, min, max) {
  if (!w) return;
  w = Math.max(min, Math.min(max, Number(w) || 0));
  panel.style.width = w + 'px';
  panel.style.minWidth = w + 'px';
  panel.style.maxWidth = w + 'px';
}

function restorePanelWidths() {
  applyWidth($('sidebar'), store.get('foxshell.w.side'), 160, 480);
  applyWidth($('sftpPanel'), store.get('foxshell.w.sftp'), 220, 640);
  applyWidth($('cmdPanel'), store.get('foxshell.w.cmd'), 170, 480);
  makeVResizable($('sideSplitter'), $('sidebar'), { dir: 'left', min: 160, max: 480, key: 'foxshell.w.side' });
  makeVResizable($('sftpSplitter'), $('sftpPanel'), { dir: 'right', min: 220, max: 640, key: 'foxshell.w.sftp' });
  makeVResizable($('cmdSplitter'), $('cmdPanel'), { dir: 'right', min: 170, max: 480, key: 'foxshell.w.cmd' });
}

// ---------------- 快捷命令面板 ----------------
function renderCmdList() {
  const box = $('cmdList');
  box.innerHTML = '';
  for (const [i, c] of cmdList.entries()) {
    const el = document.createElement('div');
    el.className = 'cmd-block';
    el.title = c.cmd + '\n点击在当前终端执行';
    el.innerHTML = `
      <div class="cmd-name">${escapeHtml(c.name)}</div>
      <div class="cmd-text">${escapeHtml(c.cmd)}</div>
      <button class="cmd-del" title="删除命令">✕</button>`;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.cmd-del')) return;
      runCommand(c);
    });
    el.querySelector('.cmd-del').addEventListener('click', () => {
      cmdList.splice(i, 1);
      store.set('foxshell.cmds', cmdList);
      renderCmdList();
    });
    box.appendChild(el);
  }
}

function runCommand(c) {
  const tab = tabs.get(activeTabId);
  if (!tab || tab.state !== 'connected') {
    toast('请先连接服务器', true);
    return;
  }
  window.api.input(tab.id, c.cmd + '\r');
  toast(`已执行：${c.name}`);
  tab.term.focus();
}

// ---------------- SFTP 面板 ----------------
function renderSftpList() {
  const tab = tabs.get(activeTabId);
  if (!tab || tab.sftp.cwd == null) return;
  $('sftpPath').value = tab.sftp.cwd;
  const list = $('sftpList');
  list.innerHTML = '';
  if (!tab.sftp.entries.length) {
    list.innerHTML = '<div id="sftpEmpty">目录为空</div>';
    return;
  }
  for (const ent of tab.sftp.entries) {
    const row = document.createElement('div');
    row.className = 'sftp-row' + (tab.sftp.selected === ent.name ? ' selected' : '');
    row.innerHTML = `
      <span class="sftp-name ${ent.isDir ? 'dir' : ''}">${ent.isDir ? '📁' : '📄'} ${escapeHtml(ent.name)}</span>
      <span class="sftp-size">${ent.isDir ? '-' : humanSize(ent.size)}</span>
      <span class="sftp-time">${fmtTime(ent.mtime)}</span>`;
    row.addEventListener('click', () => {
      tab.sftp.selected = ent.name;
      list.querySelectorAll('.selected').forEach((x) => x.classList.remove('selected'));
      row.classList.add('selected');
    });
    row.addEventListener('dblclick', () => {
      if (ent.isDir) window.api.sftpList(tab.id, tab.sftp.cwd + '/' + ent.name);
      else doDownload(ent);
    });
    list.appendChild(row);
  }
}

function selectedEntry() {
  const tab = tabs.get(activeTabId);
  if (!tab) return null;
  return tab.sftp.entries.find((e) => e.name === tab.sftp.selected) || null;
}

function needActive() {
  const tab = tabs.get(activeTabId);
  if (!tab || tab.state !== 'connected') { toast('请先连接服务器', true); return null; }
  return tab;
}

function doDownload(ent) {
  const tab = needActive();
  if (!tab || !ent) return;
  window.api.sftpDownload(tab.id, tab.sftp.cwd, ent);
}

// ---------------- 通用输入对话框 ----------------
let promptCb = null;
function askText(title, def, cb) {
  $('promptTitle').textContent = title;
  $('promptInput').value = def || '';
  promptCb = cb;
  $('promptDialog').showModal();
  setTimeout(() => { $('promptInput').select(); }, 50);
}

// ---------------- 事件绑定 ----------------
function bindUI() {
  $('btnAddConn').addEventListener('click', () => openConnDialog(null));
  $('btnAddGroup').addEventListener('click', () => {
    askText('新建分组名称', '', async (name) => {
      if (!name) return;
      if (allGroupNames().includes(name)) { toast('分组已存在', true); return; }
      extraGroups = [...extraGroups, name];
      store.set('foxshell.groups', extraGroups);
      renderConnList();
    });
  });
  $('authTypeSel').addEventListener('change', toggleAuthRows);
  $('btnPickKey').addEventListener('click', async () => {
    const p = await window.api.pickKeyFile();
    if (p) { pickedKeyPath = p; $('keyPathText').value = p; }
  });
  $('connForm').addEventListener('submit', saveConnForm);
  $('btnConnCancel').addEventListener('click', () => $('connDialog').close());

  $('btnPromptCancel').addEventListener('click', () => $('promptDialog').close());
  $('promptForm').addEventListener('submit', (e) => {
    e.preventDefault();
    $('promptDialog').close();
    if (promptCb) promptCb($('promptInput').value.trim());
    promptCb = null;
  });

  $('searchBox').addEventListener('input', renderConnList);

  $('btnDisconnect').addEventListener('click', disconnectOrReconnect);
  $('btnToggleSftp').addEventListener('click', () => {
    sftpVisible = !sftpVisible;
    refreshSftpPanel();
  });
  $('btnToggleCmd').addEventListener('click', () => {
    cmdVisible = !cmdVisible;
    refreshCmdPanel();
  });

  // 终端自适应
  const ro = new ResizeObserver(() => {
    const tab = tabs.get(activeTabId);
    if (tab && tab.wrap && !tab.wrap.classList.contains('hidden')) {
      try { tab.fit.fit(); } catch (_) {}
    }
  });
  ro.observe($('termStack'));

  // Ctrl + 滚轮调整终端字体大小
  $('termStack').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const tab = tabs.get(activeTabId);
    if (!tab) return;
    const cur = tab.term.options.fontSize;
    const n = Math.max(8, Math.min(28, cur + (e.deltaY < 0 ? 1 : -1)));
    for (const t of tabs.values()) t.term.options.fontSize = n;
    store.set('foxshell.font', n);
    try { tab.fit.fit(); } catch (_) {}
  }, { passive: false });

  // SFTP 工具栏
  const goPath = () => {
    const tab = needActive();
    if (!tab) return;
    window.api.sftpList(tab.id, $('sftpPath').value.trim() || null);
  };
  $('btnSftpGo').addEventListener('click', goPath);
  $('sftpPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') goPath(); });
  $('btnSftpUp').addEventListener('click', () => {
    const tab = needActive();
    if (tab && tab.sftp.cwd) window.api.sftpList(tab.id, parentPath(tab.sftp.cwd));
  });
  $('btnSftpRefresh').addEventListener('click', () => {
    const tab = needActive();
    if (tab && tab.sftp.cwd) window.api.sftpList(tab.id, tab.sftp.cwd);
  });
  $('btnSftpMkdir').addEventListener('click', () => {
    const tab = needActive();
    if (!tab || !tab.sftp.cwd) return;
    askText('新建文件夹名称', '', (name) => {
      if (name) window.api.sftpMkdir(tab.id, tab.sftp.cwd, name);
    });
  });
  $('btnSftpUpload').addEventListener('click', () => {
    const tab = needActive();
    if (!tab || !tab.sftp.cwd) return;
    window.api.sftpUpload(tab.id, tab.sftp.cwd);
  });
  $('btnSftpDelete').addEventListener('click', () => {
    const tab = needActive();
    const ent = tab && selectedEntry();
    if (!ent) { toast('请先选中文件或文件夹', true); return; }
    if (confirm(`确认删除「${ent.name}」？${ent.isDir ? '（文件夹将被递归删除）' : ''}`)) {
      window.api.sftpDelete(tab.id, tab.sftp.cwd, ent);
    }
  });
  $('btnSftpRename').addEventListener('click', () => {
    const tab = needActive();
    const ent = tab && selectedEntry();
    if (!ent) { toast('请先选中文件或文件夹', true); return; }
    askText('重命名', ent.name, (name) => {
      if (name && name !== ent.name) window.api.sftpRename(tab.id, tab.sftp.cwd, ent.name, name);
    });
  });

  // 快捷命令
  $('btnCmdAdd').addEventListener('click', () => {
    askText('命令名称（如：查看磁盘）', '', (name) => {
      if (!name) return;
      askText('要执行的命令', '', (cmd) => {
        if (!cmd) return;
        cmdList.push({ name, cmd });
        store.set('foxshell.cmds', cmdList);
        renderCmdList();
      });
    });
  });
}

init();

// 全局错误兜底：任何未捕获异常都以浮层提示，避免静默失败
window.addEventListener('unhandledrejection', (e) => {
  toast('出错了：' + (e.reason && e.reason.message ? e.reason.message : e.reason), true);
});
window.addEventListener('error', (e) => {
  toast('出错了：' + e.message, true);
});
