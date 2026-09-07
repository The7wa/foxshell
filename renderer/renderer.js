'use strict';
/* global Terminal, FitAddon, SearchAddon, WebglAddon */

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

// 折叠的分组、空的分组、快捷命令、终端外观都存 localStorage
let collapsedGroups = store.get('foxshell.collapsed', []);
let extraGroups = store.get('foxshell.groups', []);

let termCfg = Object.assign({
  bg: '#101418',
  fg: '#d6dce2',
  font: 'Consolas, "Courier New", monospace',
  size: 13,
  cursor: 'block',
  blink: true,
}, store.get('foxshell.termCfg', {}));

const HL_DEFAULT_RULES = [
  { word: 'ERROR', color: '#e5534b' },
  { word: 'FAIL', color: '#e5534b' },
  { word: 'WARN', color: '#c69026' },
  { word: 'SUCCESS', color: '#57ab5a' },
];
let hlCfg = Object.assign(
  { enabled: true, rules: HL_DEFAULT_RULES.map((r) => ({ ...r })) },
  store.get('foxshell.hl', {})
);
hlCfg.inputEnabled = true;
hlCfg.rules = Array.isArray(hlCfg.rules) && hlCfg.rules.length ? hlCfg.rules : HL_DEFAULT_RULES.map((r) => ({ ...r }));

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

// 批量执行：选中的广播目标 tabId
let broadcastTargets = new Set();

// 主题预设
const TERM_PRESETS = [
  { name: '经典黑', bg: '#101418', fg: '#d6dce2' },
  { name: '深灰', bg: '#2d2d2d', fg: '#cccccc' },
  { name: '深蓝', bg: '#0d2a4a', fg: '#cfe3ff' },
  { name: 'Solarized', bg: '#002b36', fg: '#93a1a1' },
  { name: 'Matrix', bg: '#001100', fg: '#33ff33' },
  { name: '浅色', bg: '#ffffff', fg: '#333333' },
];

// ---------------- 工具 ----------------
function b64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function evtBytes(d) {
  if (typeof d === 'string') return b64ToBytes(d);
  return d instanceof Uint8Array ? d : new Uint8Array(d);
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
function xtermTheme() {
  return {
    background: termCfg.bg,
    foreground: termCfg.fg,
    cursor: '#3d9a50',
    selectionBackground: '#2f81f766',
    black: '#101418', red: '#e5534b', green: '#57ab5a', yellow: '#c69026',
    blue: '#539bf5', magenta: '#b083f0', cyan: '#39c5cf', white: '#d6dce2',
  };
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
  // 只回填加密字段，保持 conns 内对象引用不变（tab.conn 依赖同一引用）
  if (updated && updated.connections) {
    for (const u of updated.connections) {
      const c = conns.find((x) => x.id === u.id);
      if (c) {
        c.passwordEnc = u.passwordEnc;
        c.passphraseEnc = u.passphraseEnc;
        c.jumps = Array.isArray(u.jumps) ? u.jumps.map((j) => ({ ...j })) : [];
      }
    }
  }
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
    gmap.set('', un);
  }

  for (const [g, items] of gmap) {
    if (g === '' && !items.length) continue;
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
  // 跳板机链：编辑时展开为可增删的列表
  jumpDraft = (conn && Array.isArray(conn.jumps) ? conn.jumps : []).map((j) => ({
    host: j.host || '',
    port: j.port || 22,
    username: j.username || '',
    passwordEnc: j.passwordEnc || '',
    password: '',
  }));
  $('useJumpChk').checked = !!(conn && conn.jumps && conn.jumps.length);
  $('rowJump').style.display = $('useJumpChk').checked ? '' : 'none';
  renderJumpList(conn && !clone);
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

// ---------- 跳板机链（数量不限） ----------
let jumpDraft = []; // 编辑中的跳板机草稿 [{host,port,username,passwordEnc,password}]

function addJumpRow() {
  jumpDraft.push({ host: '', port: 22, username: '', passwordEnc: '', password: '' });
  renderJumpList(true);
}

function renderJumpList(keepPw) {
  const box = $('jumpList');
  box.innerHTML = '';
  jumpDraft.forEach((j, i) => {
    const row = document.createElement('div');
    row.className = 'jump-row';
    row.innerHTML = `
      <div class="jump-head">
        <span class="jn">跳板机 ${i + 1}</span>
        ${i > 0 ? `<button type="button" data-a="up" title="上移">↑</button>` : ''}
        ${i < jumpDraft.length - 1 ? `<button type="button" data-a="down" title="下移">↓</button>` : ''}
        <button type="button" data-a="del" title="删除此跳板机">🗑</button>
      </div>
      <div class="row2">
        <label>地址 <input data-f="host" type="text" placeholder="如 10.0.0.1" value="${escapeHtml(j.host)}" /></label>
        <label>端口 <input data-f="port" type="number" min="1" max="65535" value="${j.port || 22}" /></label>
      </div>
      <div class="row2">
        <label>用户名 <input data-f="username" type="text" placeholder="默认同目标用户名" value="${escapeHtml(j.username)}" /></label>
        <label>密码 <input data-f="password" type="password" placeholder="${keepPw && j.passwordEnc ? '留空则保持原密码' : '无则留空'}" value="" /></label>
      </div>`;
    row.querySelectorAll('[data-f]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const f = inp.dataset.f;
        if (f === 'port') jumpDraft[i].port = Number(inp.value) || 22;
        else jumpDraft[i][f] = inp.value;
      });
    });
    const pwInput = row.querySelector('[data-f=password]');
    if (pwInput) pwInput.value = String(j.password || '');
    row.querySelector('[data-a=del]').addEventListener('click', () => {
      jumpDraft.splice(i, 1);
      renderJumpList(keepPw);
    });
    const up = row.querySelector('[data-a=up]');
    if (up) up.addEventListener('click', () => {
      [jumpDraft[i - 1], jumpDraft[i]] = [jumpDraft[i], jumpDraft[i - 1]];
      renderJumpList(keepPw);
    });
    const down = row.querySelector('[data-a=down]');
    if (down) down.addEventListener('click', () => {
      [jumpDraft[i + 1], jumpDraft[i]] = [jumpDraft[i], jumpDraft[i + 1]];
      renderJumpList(keepPw);
    });
    box.appendChild(row);
  });
}

async function saveConnForm(e) {
  e.preventDefault();
  try {
    const f = $('connForm');
    const F = (n) => f.elements[n];
    const id = editingConnId || uid().replace('t', 'c');
    const old = conns.find((c) => c.id === id);
    const group = F('group').value.trim();
    const useJump = $('useJumpChk').checked;
    const jumpRows = useJump ? jumpDraft.filter((j) => j.host.trim()) : [];
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
      jumps: jumpRows.map((j) => ({
        host: j.host.trim(),
        port: Number(j.port) || 22,
        username: j.username.trim(),
        // 密码：新输入的用明文经 secrets 提交加密；没输入的保留原密文
        passwordEnc: (old && old.jumps && old.jumps.some((x) => x.host === j.host.trim()) && !j.password)
          ? (old.jumps.find((x) => x.host === j.host.trim()) || {}).passwordEnc || '' : '',
      })),
      forwards: old ? old.forwards || [] : [],
    };
    if (!rec.keyPath && rec.authType === 'key') {
      toast('请选择私钥文件', true);
      return;
    }
    if (useJump && !jumpRows.length) {
      toast('请至少添加一台跳板机地址', true);
      return;
    }
    if (group && !allGroupNames().includes(group)) extraGroups = [...extraGroups, group];
    const secrets = {
      [id]: {
        password: F('password').value,
        passphrase: F('passphrase').value,
      },
      jumps: { [id]: jumpRows.map((j) => j.password || '') },
    };
    if (old) Object.assign(old, rec); // 原地更新，保持引用（tab.conn 同步）
    else conns.push(rec);
    store.set('foxshell.groups', extraGroups);
    const updated = await window.api.saveConns({ connections: conns, groups: allGroupNames(), secrets });
    if (updated && updated.connections) {
      for (const u of updated.connections) {
        const c = conns.find((x) => x.id === u.id);
        if (c) {
          c.passwordEnc = u.passwordEnc;
          c.passphraseEnc = u.passphraseEnc;
          c.jumps = Array.isArray(u.jumps) ? u.jumps.map((j) => ({ ...j })) : [];
        }
      }
    }
    $('connDialog').close();
    renderConnList();
    toast('连接配置已保存');
  } catch (err) {
    toast('保存失败：' + (err.message || err), true);
  }
}

// ---------------- 标签页 / 终端（支持分屏多面板） ----------------
function connectConn(conn) {
  const existing = [...tabs.values()].find((t) => t.connId === conn.id && t.state !== 'closed');
  if (existing) return activateTab(existing.id);
  createTab(conn);
}

function createTab(conn) {
  const id = uid();
  const wrap = document.createElement('div');
  wrap.className = 'term-wrap hidden';
  wrap.style.background = termCfg.bg;
  const layout = document.createElement('div');
  layout.className = 'term-layout';
  wrap.appendChild(layout);
  $('termStack').appendChild(wrap);

  const tab = {
    id,
    connId: conn.id,
    conn,
    title: conn.name || conn.host,
    state: 'connecting',
    wrap,
    layout,
    direction: 'row',
    panes: [],
    activePane: null,
    stats: null,
    sftp: { started: false, cwd: null, entries: [], selected: null },
  };
  tabs.set(id, tab);
  renderTabs();
  activateTab(id);
  addPane(tab, -1); // 第一个终端面板
  if (cmdVisible) renderBroadcast();
  window.api.connect(id, conn);
}

function termOptions() {
  return {
    fontSize: termCfg.size,
    fontFamily: termCfg.font,
    cursorBlink: termCfg.blink,
    cursorStyle: termCfg.cursor,
    scrollback: 5000,
    theme: xtermTheme(),
    allowProposedApi: true,
  };
}

function addPane(tab, index, direction) {
  const paneId = uid();
  if (direction && direction !== tab.direction) {
    tab.direction = direction;
    tab.layout.style.flexDirection = direction === 'row' ? 'row' : 'column';
  }
  const el = document.createElement('div');
  el.className = 'term-pane';
  el.style.background = termCfg.bg;
  el.innerHTML = `
    <div class="pane-tools">
      <button data-a="splitH" title="复制终端（左右分屏，同一连接新开终端）">⧉ 复制</button>
      <button data-a="splitV" title="上下分屏">⬓ 上下</button>
      <button data-a="log" title="导出此终端缓冲区为日志文件">📜 日志</button>
      <button data-a="close" class="pclose" title="关闭此终端">✕</button>
    </div>`;

  const term = new Terminal(termOptions());
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => { try { webgl.dispose(); } catch (_) {} });
    term.loadAddon(webgl);
  } catch (_) {}
  // xterm 需要挂载到独立内容层，避免与悬浮工具栏互相干扰
  const inner = document.createElement('div');
  inner.style.cssText = 'position:absolute;inset:4px 0 0 8px;';
  el.appendChild(inner);
  term.open(inner);
  term.onResize(({ cols, rows }) => window.api.resize(tab.id, paneId, cols, rows));

  const pane = { id: paneId, el, inner, term, fit, search, tab, hlDecorations: [], _hlMarker: null, _hlTimer: null, _cmdDecs: [], _cmdTimer: null, _cmdMarkerLine: null };
  const at = index < 0 || index > tab.panes.length ? tab.panes.length : index;
  tab.panes.splice(at, 0, pane);

  // 插入 DOM（按顺序重建 splitter）
  relayoutPanes(tab);

  term.onData((d) => {
    window.api.input(tab.id, paneId, d);
    if (!d.startsWith('\x1b') && d !== '\t') scheduleCmdHighlight(pane);
  });
  el.addEventListener('click', () => setActivePane(tab, pane));
  el.querySelector('[data-a=splitH]').addEventListener('click', (e) => {
    e.stopPropagation();
    addPane(tab, tab.panes.indexOf(pane) + 1, 'row');
  });
  el.querySelector('[data-a=splitV]').addEventListener('click', (e) => {
    e.stopPropagation();
    addPane(tab, tab.panes.indexOf(pane) + 1, 'column');
  });
  el.querySelector('[data-a=log]').addEventListener('click', (e) => {
    e.stopPropagation();
    exportPaneLog(tab, pane);
  });
  el.querySelector('[data-a=close]').addEventListener('click', (e) => {
    e.stopPropagation();
    closePane(tab, pane);
  });

  setActivePane(tab, pane);
  if (tab.state === 'connected') window.api.openPane(tab.id, paneId, term.cols, term.rows);
  fitAllPanes(tab);
  return pane;
}

// 依据 panes 顺序与方向重建布局（splitter 夹在相邻面板之间）
function relayoutPanes(tab) {
  tab.layout.style.flexDirection = tab.direction === 'row' ? 'row' : 'column';
  for (const el of [...tab.layout.querySelectorAll('.pane-splitter-h, .pane-splitter-v')]) el.remove();
  tab.panes.forEach((p, i) => {
    tab.layout.appendChild(p.el);
    if (i < tab.panes.length - 1) {
      const sp = document.createElement('div');
      sp.className = tab.direction === 'row' ? 'pane-splitter-h' : 'pane-splitter-v';
      makePaneResizable(tab, sp, p, tab.panes[i + 1]);
      tab.layout.appendChild(sp);
    }
  });
}

// 拖动 splitter 调整相邻两个面板的 flex-grow
function makePaneResizable(tab, sp, p1, p2) {
  const isRow = () => tab.direction === 'row';
  sp.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sizeKey = isRow() ? 'clientWidth' : 'clientHeight';
    const start = isRow() ? e.clientX : e.clientY;
    const g1 = parseFloat(p1.el.style.flexGrow) || 1;
    const g2 = parseFloat(p2.el.style.flexGrow) || 1;
    const container = tab.layout[sizeKey];
    const perPx = (g1 + g2) / Math.max(1, container);
    const onMove = (ev) => {
      const d = (isRow() ? ev.clientX : ev.clientY) - start;
      const n1 = Math.max(0.15, g1 + d * perPx);
      const n2 = Math.max(0.15, g1 + g2 - n1);
      p1.el.style.flexGrow = n1;
      p2.el.style.flexGrow = n2;
      fitAllPanes(tab);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = isRow() ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  });
}

function setActivePane(tab, pane) {
  tab.activePane = pane.id;
  for (const p of tab.panes) p.el.classList.toggle('active', p.id === pane.id);
  try { pane.term.focus(); } catch (_) {}
}

function fitAllPanes(tab) {
  if (!tab || tab.wrap.classList.contains('hidden')) return;
  for (const p of tab.panes) {
    try { p.fit.fit(); } catch (_) {}
  }
}

function closePane(tab, pane) {
  window.api.closePane(tab.id, pane.id);
  clearPaneHighlights(pane);
  clearCmdDecorations(pane);
  try { pane.term.dispose(); } catch (_) {}
  pane.el.remove();
  tab.panes = tab.panes.filter((p) => p !== pane);
  if (!tab.panes.length) return closeTab(tab.id);
  relayoutPanes(tab);
  if (tab.activePane === pane.id) setActivePane(tab, tab.panes[0]);
  fitAllPanes(tab);
}

// 导出终端缓冲区为日志文件
function exportPaneLog(tab, pane) {
  const buf = pane.term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i).translateToString(true));
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const name = `${tab.conn.host}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
  window.api.saveText(lines.join('\r\n'), name).then((r) => {
    if (r.ok) toast('日志已保存：' + r.path);
  });
}

// ---------- 终端内搜索（Ctrl+F，作用于当前活动面板） ----------
function activeSearch() {
  const tab = tabs.get(activeTabId);
  if (!tab) return null;
  const pane = tab.panes.find((p) => p.id === tab.activePane) || tab.panes[0];
  return pane ? pane.search : null;
}
function openSearch() {
  if (!tabs.get(activeTabId)) return;
  $('searchBar').classList.remove('hidden');
  $('searchInput').focus();
  $('searchInput').select();
}
function closeSearch() {
  $('searchBar').classList.add('hidden');
  const s = activeSearch();
  if (s) { try { s.clearDecorations(); } catch (_) {} }
  const tab = tabs.get(activeTabId);
  if (tab && tab.activePane) {
    const p = tab.panes.find((x) => x.id === tab.activePane);
    if (p) try { p.term.focus(); } catch (_) {}
  }
}

function activateTab(id) {
  activeTabId = id;
  for (const [tid, tab] of tabs) tab.wrap.classList.toggle('hidden', tid !== id);
  renderTabs();
  const tab = tabs.get(id);
  if (tab) {
    fitAllPanes(tab);
    if (tab.activePane) {
      const p = tab.panes.find((x) => x.id === tab.activePane);
      if (p) try { p.term.focus(); } catch (_) {}
    }
  }
  renderMonitor();
  refreshSftpPanel();
  updateDisconnectBtn();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  window.api.close(id);
  for (const p of tab.panes) {
    try { p.term.dispose(); } catch (_) {}
  }
  tab.wrap.remove();
  tabs.delete(id);
  broadcastTargets.delete(id);
  if (cmdVisible) renderBroadcast();
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
    for (const p of tab.panes) p.term.writeln('\r\n\x1b[33m--- 已手动断开，点击右上角「重连」重新连接 ---\x1b[0m');
    tab.state = 'closed';
    renderTabs();
    renderMonitor();
    updateDisconnectBtn();
  }
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hlRegex() {
  if (!hlCfg.enabled) return null;
  const words = (hlCfg.rules || []).map((r) => String(r.word || '').trim()).filter(Boolean);
  if (!words.length) return null;
  const alt = words.map((w) => (/\w$/.test(w) ? '\\b' : '') + escapeRe(w) + (/\w$/.test(w) ? '\\b' : ''));
  return new RegExp('(?:' + alt.join('|') + ')', 'gi');
}

function hlColorFor(text) {
  const t = text.toLowerCase();
  const rules = hlCfg.rules || [];
  const exact = rules.find((r) => String(r.word || '').trim().toLowerCase() === t);
  if (exact) return exact.color;
  const sub = rules.find((r) => {
    const w = String(r.word || '').trim().toLowerCase();
    return w && t.includes(w);
  });
  return sub ? sub.color : null;
}

function hlLineText(line) {
  let text = '';
  const col = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (cell.getWidth() <= 0) continue;
    const chars = cell.getChars() || ' ';
    for (const ch of chars) col.push(x);
    text += chars;
  }
  return { text, col };
}

function schedulePaneHighlight(pane) {
  if (!pane || pane._hlTimer) return;
  pane._hlTimer = setTimeout(() => {
    pane._hlTimer = null;
    if (document.hidden) return schedulePaneHighlight(pane);
    try { hlScanPane(pane); } catch (_) {}
  }, 200);
}

function hlScanPane(pane) {
  const re = hlRegex();
  if (!re) return;
  const term = pane.term;
  const buf = term.buffer.active;
  if (!buf || !buf.length) return;
  const startY = pane._hlMarker && !pane._hlMarker.isDisposed ? Math.max(0, pane._hlMarker.line) : 0;
  pane.hlDecorations = pane.hlDecorations.filter(({ dec, y }) => {
    if (y >= startY) { try { dec.dispose(); } catch (_) {} return false; }
    return true;
  });
  const end = buf.length;
  const smart = hlCfg.enabled !== false;
  for (let y = startY; y < end; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const quick = line.translateToString(false);
    re.lastIndex = 0;
    const kwHit = re.test(quick);
    if (!kwHit && !(smart && SMART_QUICK.test(quick))) continue;
    const { text, col } = hlLineText(line);
    const used = [];
    const overlaps = (a, b) => used.some(([u0, u1]) => a < u1 && b > u0);
    if (smart) hlSmartLine(pane, buf, y, line, text, col, used, overlaps);
    if (kwHit) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        if (!m[0]) { re.lastIndex++; continue; }
        const color = hlColorFor(m[0]);
        const a = m.index;
        const b = a + m[0].length;
        if (!color || overlaps(a, b)) continue;
        used.push([a, b]);
        const x = col[a];
        const x2 = col[b - 1];
        if (x == null || x2 == null || x2 < x) continue;
        try {
          const marker = term.registerMarker(y - (buf.baseY + buf.cursorY));
          pane.hlDecorations.push({
            y,
            dec: term.registerDecoration({
              marker,
              x,
              width: x2 - x + 1,
              backgroundColor: color,
              layer: 'bottom',
            }),
          });
        } catch (_) {}
      }
    }
  }
  try {
    if (pane._hlMarker && !pane._hlMarker.isDisposed) pane._hlMarker.dispose();
  } catch (_) {}
  pane._hlMarker = null;
  try { pane._hlMarker = term.registerMarker((end - 1) - (buf.baseY + buf.cursorY)); } catch (_) {}
}

function clearPaneHighlights(pane) {
  if (pane._hlTimer) { clearTimeout(pane._hlTimer); pane._hlTimer = null; }
  for (const { dec } of pane.hlDecorations || []) { try { dec.dispose(); } catch (_) {} }
  pane.hlDecorations = [];
  try { if (pane._hlMarker && !pane._hlMarker.isDisposed) pane._hlMarker.dispose(); } catch (_) {}
  pane._hlMarker = null;
}

function refreshAllHighlights() {
  for (const tab of tabs.values()) {
    for (const p of tab.panes) {
      clearPaneHighlights(p);
      clearCmdDecorations(p);
      if (hlCfg.enabled) {
        schedulePaneHighlight(p);
        try { hlScanCmdBuffer(p); } catch (_) {}
        scheduleCmdHighlight(p);
      }
    }
  }
}

const CMD_FALLBACK = new Set(('bash sh zsh sudo su exit logout clear echo printf read cd pwd ls ll la l dir cp mv rm mkdir rmdir touch ln cat tac head tail less more nano vim vi emacs grep egrep fgrep sed awk cut sort uniq wc tr find xargs which whereis whoami id groups hostname uname date cal uptime free df du ps top htop btop kill pkill pgrep jobs bg fg nohup nice chmod chown chgrp umount mount tar gzip gunzip zip unzip bzip2 xz curl wget ping ssh scp sftp rsync git svn docker podman kubectl systemctl service journalctl dmesg iptables netstat ss ip ifconfig route traceroute mtr apt apt-get apt-cache yum dnf zypper pacman brew make cmake gcc g++ python python3 pip pip3 node npm npx java javac go rustc cargo ruby perl php lua sqlite3 mysql psql mongo mongod redis-cli redis-server screen tmux watch crontab at alias unalias export unset env source history man info type file stat tree md5sum sha256sum tee xxd base64 openssl lsof strace ltrace ldd reboot shutdown poweroff halt sleep yes true false test').split(' '));

const CMD_COLORS = {
  cmd: '#6cb2ff',
  bad: '#e5534b',
  opt: '#39c5cf',
  str: '#e3b341',
  var: '#b083f0',
  op: '#8b949e',
};

const CMD_PROMPT_RES = [
  /[\w.@~-]+@[\w.-]+:[^\s]*[$#]\s/,
  /^\[[^\]]*\][$#]\s/,
  /^bash[\d.-]*[$#]\s/,
  /^(mysql|MariaDB|redis|mongodb|mongo|psql|pgsql|ftp|sftp|docker|python|node|irb)[^>]*>\s/i,
  /^>{2,3}\s/,
  /^➜\s/,
  /^\s*[$#%>]\s/,
];

function cmdPromptEnd(text) {
  for (const re of CMD_PROMPT_RES) {
    const m = re.exec(text);
    if (m && m.index <= 30) return m.index + m[0].length;
  }
  return -1;
}

function cmdTokenize(s) {
  const toks = [];
  let i = 0;
  let expectCmd = true;
  const isEnd = (c) => c === ' ' || c === '\t' || ';&|<>"\''.includes(c) || c === '(' || c === ')';
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (';&|<>'.includes(ch)) {
      let j = i + 1;
      if (j < s.length && s[j] === ch) j++;
      toks.push({ start: i, end: j, kind: 'op' });
      expectCmd = true;
      i = j;
      continue;
    }
    if (ch === '(' || ch === ')') {
      toks.push({ start: i, end: i + 1, kind: 'op' });
      expectCmd = ch === '(';
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== ch) { if (s[j] === '\\') j++; j++; }
      const end = Math.min(j + 1, s.length);
      toks.push({ start: i, end, kind: 'str' });
      i = end;
      continue;
    }
    if (ch === '\\' && i + 1 < s.length) { i += 2; continue; }
    let j = i + 1;
    while (j < s.length && !isEnd(s[j])) { if (s[j] === '\\') j++; j++; }
    const word = s.slice(i, j);
    let kind = 'arg';
    if (/^-{1,2}[A-Za-z][\w-]*$/.test(word)) kind = 'opt';
    else if (/^[A-Za-z_]\w*=/.test(word)) kind = 'var';
    else if (expectCmd) kind = 'cmd';
    toks.push({ start: i, end: j, kind });
    if (kind === 'cmd') expectCmd = false;
    i = j;
  }
  return toks;
}

function scheduleCmdHighlight(pane) {
  if (!pane || hlCfg.enabled === false || !hlCfg.inputEnabled || pane._cmdTimer) return;
  pane._cmdTimer = setTimeout(() => {
    pane._cmdTimer = null;
    if (document.hidden) return;
    try { hlCommandLine(pane); } catch (_) {}
  }, 40);
}

function clearCmdDecorations(pane) {
  if (pane._cmdTimer) { clearTimeout(pane._cmdTimer); pane._cmdTimer = null; }
  for (const { dec } of pane._cmdDecs || []) { try { dec.dispose(); } catch (_) {} }
  pane._cmdDecs = [];
  pane._cmdMarkerLine = null;
}

function hlCommandLine(pane) {
  const term = pane.term;
  const buf = term.buffer.active;
  if (!buf || buf.type === 'alternate') return;
  const y = buf.baseY + buf.cursorY;
  const line = buf.getLine(y);
  if (!line) return;
  pane._cmdDecs = (pane._cmdDecs || []).filter(({ dec, y: ey }) => {
    if (ey === y) { try { dec.dispose(); } catch (_) {} return false; }
    return true;
  });
  const { text, col } = hlLineText(line);
  const start = cmdPromptEnd(text);
  if (start < 0 || !text.slice(start).trim()) return;
  const cmds = pane.tab && pane.tab.commands;
  const marker = term.registerMarker(0);
  for (const t of cmdTokenize(text.slice(start))) {
    let color = CMD_COLORS[t.kind];
    if (t.kind === 'cmd') {
      const w = text.slice(start + t.start, start + t.end).toLowerCase();
      const known = (cmds && cmds.has(w)) || CMD_FALLBACK.has(w) || w.includes('/');
      color = known ? CMD_COLORS.cmd : CMD_COLORS.bad;
    }
    if (!color) continue;
    const x = col[start + t.start];
    const x2 = col[start + t.end - 1];
    if (x == null || x2 == null || x2 < x) continue;
    try {
      pane._cmdDecs.push({
        y,
        dec: term.registerDecoration({
          marker,
          x,
          width: x2 - x + 1,
          foregroundColor: color,
          layer: 'bottom',
        }),
      });
    } catch (_) {}
  }
}

function hlScanCmdBuffer(pane) {
  const term = pane.term;
  const buf = term.buffer.active;
  if (!buf || buf.type === 'alternate') return;
  for (const { dec } of pane._cmdDecs || []) { try { dec.dispose(); } catch (_) {} }
  pane._cmdDecs = [];
  const cmds = pane.tab && pane.tab.commands;
  const end = buf.length;
  const cursorAbs = buf.baseY + buf.cursorY;
  for (let y = 0; y < end; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const quick = line.translateToString(false);
    const start = cmdPromptEnd(quick);
    if (start < 0 || !quick.slice(start).trim()) continue;
    const { text, col } = hlLineText(line);
    const s2 = cmdPromptEnd(text);
    if (s2 < 0) continue;
    const marker = term.registerMarker(y - cursorAbs);
    for (const t of cmdTokenize(text.slice(s2))) {
      let color = CMD_COLORS[t.kind];
      if (t.kind === 'cmd') {
        const w = text.slice(s2 + t.start, s2 + t.end).toLowerCase();
        const known = (cmds && cmds.has(w)) || CMD_FALLBACK.has(w) || w.includes('/');
        color = known ? CMD_COLORS.cmd : CMD_COLORS.bad;
      }
      if (!color) continue;
      const x = col[s2 + t.start];
      const x2 = col[s2 + t.end - 1];
      if (x == null || x2 == null || x2 < x) continue;
      try {
        pane._cmdDecs.push({
          y,
          dec: term.registerDecoration({
            marker,
            x,
            width: x2 - x + 1,
            foregroundColor: color,
            layer: 'bottom',
          }),
        });
      } catch (_) {}
    }
  }
  pane._cmdMarkerLine = cursorAbs;
}

const SMART_QUICK = /(?:ERROR|FATAL|CRIT|WARN|INFO|NOTICE|DEBUG|SUCCESS|DONE|FAILED|\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|\/[\w.-]+\/)/i;
const SMART_PATTERNS = [
  { re: /\b(?:ERROR|ERRORS|FATAL|CRITICAL|CRIT|SEVERE|PANIC|FAILED|FAILURE)\b/gi, color: '#ff7b72' },
  { re: /\b(?:WARN|WARNING)\b/gi, color: '#e3b341' },
  { re: /\b(?:INFO|NOTICE)\b/gi, color: '#4ec9b0' },
  { re: /\bDEBUG\b/gi, color: '#8b949e' },
  { re: /\b(?:SUCCESS(?:FUL|FULLY)?|DONE|COMPLETED)\b/gi, color: '#7ee787' },
  { re: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, color: '#8fb7d9' },
  { re: /\b\d{2}:\d{2}:\d{2}\b/g, color: '#8fb7d9' },
  { re: /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, color: '#d2a8ff' },
  { re: /(?<=^|[\s:="'(\[])(?:[\w.@+-]+\/)+[\w.@+-]+/g, color: '#ce9178' },
  { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, color: '#9aa4ad' },
];

const HLJS_COLORS = {
  keyword: '#ff7b72', built_in: '#d2a8ff', type: '#ffa657', title: '#d2a8ff',
  string: '#a5d6ff', number: '#79c0ff', literal: '#79c0ff', comment: '#8b949e',
  attr: '#7ee787', attribute: '#7ee787', variable: '#ffa657', meta: '#8b949e',
  section: '#7ee787', tag: '#7ee787', name: '#79c0ff', symbol: '#d2a8ff',
  operator: '#8b949e', property: '#79c0ff', selector: '#d2a8ff',
};

function hlRangeFgDefault(line, col, a, b) {
  const x0 = col[a];
  const x1 = col[b - 1];
  if (x0 == null || x1 == null) return false;
  for (let x = x0; x <= x1; x++) {
    let cell;
    try { cell = line.getCell(x); } catch (_) { return false; }
    if (cell && !cell.isFgDefault()) return false;
  }
  return true;
}

function hlSmartLine(pane, buf, y, line, text, col, used, overlaps) {
  const term = pane.term;
  const addDec = (a, b, color) => {
    const x = col[a];
    const x2 = col[b - 1];
    if (x == null || x2 == null || x2 < x) return;
    if (!hlRangeFgDefault(line, col, a, b)) return;
    try {
      const marker = term.registerMarker(y - (buf.baseY + buf.cursorY));
      pane.hlDecorations.push({
        y,
        dec: term.registerDecoration({
          marker,
          x,
          width: x2 - x + 1,
          foregroundColor: color,
          layer: 'bottom',
        }),
      });
    } catch (_) {}
  };
  for (const p of SMART_PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text))) {
      if (!m[0]) { p.re.lastIndex++; continue; }
      const a = m.index;
      const b = a + m[0].length;
      if (overlaps(a, b)) continue;
      used.push([a, b]);
      addDec(a, b, p.color);
    }
  }
}

// ---------------- 终端外观设置 ----------------
function applyTermCfg() {
  for (const tab of tabs.values()) {
    tab.wrap.style.background = termCfg.bg;
    for (const p of tab.panes) {
      p.el.style.background = termCfg.bg;
      p.term.options.theme = xtermTheme();
      p.term.options.fontFamily = termCfg.font;
      p.term.options.fontSize = termCfg.size;
      p.term.options.cursorStyle = termCfg.cursor;
      p.term.options.cursorBlink = termCfg.blink;
    }
    fitAllPanes(tab);
  }
  store.set('foxshell.termCfg', termCfg);
}

function openTermDialog() {
  const f = $('termForm');
  const F = (n) => f.elements[n];
  F('bg').value = termCfg.bg;
  F('fg').value = termCfg.fg;
  F('font').value = termCfg.font;
  F('size').value = termCfg.size;
  F('cursor').value = termCfg.cursor;
  F('blink').checked = termCfg.blink;
  const row = $('presetRow');
  row.innerHTML = '';
  for (const p of TERM_PRESETS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'preset-chip';
    chip.innerHTML = `<span class="preset-dot" style="background:${p.bg}"></span>${escapeHtml(p.name)}`;
    chip.addEventListener('click', () => {
      F('bg').value = p.bg;
      F('fg').value = p.fg;
    });
    row.appendChild(chip);
  }
  $('hlEnabled').checked = hlCfg.enabled !== false;
  $('termDialog').showModal();
}

function saveTermForm(e) {
  e.preventDefault();
  const f = $('termForm');
  const F = (n) => f.elements[n];
  termCfg = {
    bg: F('bg').value,
    fg: F('fg').value,
    font: F('font').value,
    size: Math.max(8, Math.min(28, Number(F('size').value) || 13)),
    cursor: F('cursor').value,
    blink: F('blink').checked,
  };
  applyTermCfg();
  hlCfg.enabled = $('hlEnabled').checked;
  hlCfg.inputEnabled = true;
  store.set('foxshell.hl', hlCfg);
  refreshAllHighlights();
  $('termDialog').close();
  toast('终端设置已更新');
}

// ---------------- 主进程事件 ----------------
function handleEvent(evt) {
  const tab = tabs.get(evt.tabId);
  if (!tab) return;
  const { type, payload } = evt;
  if (type === 'pane-data') {
    const pane = tab.panes.find((p) => p.id === payload.paneId);
    if (pane) pane.term.write(evtBytes(payload.data), () => {
      schedulePaneHighlight(pane);
      scheduleCmdHighlight(pane);
    });
  } else if (type === 'commands') {
    tab.commands = new Set((payload.list || []).map((s) => String(s).toLowerCase()));
  } else if (type === 'pane-ready') {
    const pane = tab.panes.find((p) => p.id === payload.paneId);
    if (pane && tab.panes.length === 1) pane.term.writeln('\x1b[32m连接成功。\x1b[0m');
    if (pane && tab.state !== 'connected') { /* 分屏新终端不额外提示 */ }
  } else if (type === 'pane-error') {
    const pane = tab.panes.find((p) => p.id === payload.paneId);
    if (pane) pane.term.writeln(`\x1b[31m打开终端失败：${payload.message}\x1b[0m`);
  } else if (type === 'pane-closed') {
    // 远端 shell 关闭（如连接断开）；面板由 status=closed 统一处理
  } else if (type === 'status') {
    tab.state = payload.state;
    tab.statusMsg = payload.message || '';
    if (payload.state === 'connected') {
      if (!tab.panes.length) addPane(tab, -1);
      else {
        const p0 = tab.panes[0];
        window.api.openPane(tab.id, p0.id, p0.term.cols, p0.term.rows);
      }
      fitAllPanes(tab);
    } else if (payload.state === 'failed') {
      const p = tab.panes[0];
      if (p) p.term.writeln(`\r\n\x1b[31m连接失败：${payload.message || '未知错误'}\x1b[0m`);
    } else if (payload.state === 'closed' && payload.message) {
      for (const p of tab.panes) p.term.writeln(`\r\n\x1b[33m${payload.message}\x1b[0m`);
    }
    renderTabs();
    renderConnList();
    if (cmdVisible) renderBroadcast();
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
  } else if (type === 'forward-state') {
    fwdState.set(payload.id, payload.active);
    if (!$('fwdDialog').classList.contains('hidden') || $('fwdDialog').open) renderFwdList();
  } else if (type === 'forward-error') {
    fwdState.set(payload.id, false);
    toast('端口转发失败：' + payload.message, true);
    if ($('fwdDialog').open) renderFwdList();
  }
}

// ---------- 端口转发对话框 ----------
const fwdState = new Map(); // rule.id -> 是否已启动（运行时状态）

function currentConn() {
  const tab = tabs.get(activeTabId);
  if (!tab) return null;
  // 优先从 conns 里取，避免 tab.conn 与列表对象脱钩
  return conns.find((c) => c.id === tab.connId) || tab.conn;
}

function openFwdDialog() {
  const conn = currentConn();
  if (!conn) { toast('请先选中一个已连接的服务器标签', true); return; }
  if (!Array.isArray(conn.forwards)) conn.forwards = [];
  renderFwdList();
  $('fwdDialog').showModal();
}

function renderFwdList() {
  const conn = currentConn();
  const box = $('fwdList');
  if (!conn) return;
  box.innerHTML = '';
  if (!conn.forwards.length) {
    box.innerHTML = '<div class="empty-list">还没有转发规则<br>在下方添加：本地端口 → 目标主机:目标端口</div>';
    return;
  }
  for (const r of conn.forwards) {
    const on = fwdState.get(r.id);
    const row = document.createElement('div');
    row.className = 'fwd-row';
    row.innerHTML = `
      <span class="fwd-state ${on ? 'on' : ''}" title="${on ? '转发中' : '未启动'}"></span>
      <span class="fwd-text">127.0.0.1:${r.localPort} → ${escapeHtml(r.dstHost)}:${r.dstPort}</span>
      <button class="mini-btn" data-a="toggle">${on ? '停止' : '启动'}</button>
      <button class="mini-btn" data-a="del">🗑</button>`;
    row.querySelector('[data-a=toggle]').addEventListener('click', () => {
      const tab = tabs.get(activeTabId);
      if (!tab || tab.state !== 'connected') { toast('连接已断开，无法转发', true); return; }
      if (on) window.api.fwdStop(tab.id, r.id);
      else window.api.fwdStart(tab.id, { id: r.id, localPort: r.localPort, dstHost: r.dstHost, dstPort: r.dstPort });
    });
    row.querySelector('[data-a=del]').addEventListener('click', async () => {
      if (on) window.api.fwdStop(activeTabId, r.id);
      conn.forwards = conn.forwards.filter((x) => x.id !== r.id);
      fwdState.delete(r.id);
      await persist();
      renderFwdList();
    });
    box.appendChild(row);
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
    status.textContent = tab.state === 'connecting'
      ? ('连接中...' + (tab.statusMsg ? ' ' + tab.statusMsg : ''))
      : tab.state === 'failed' ? '连接失败' : '已断开';
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
  if (cmdVisible) renderBroadcast();
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
  renderBroadcast();
  for (const [i, c] of cmdList.entries()) {
    const el = document.createElement('div');
    el.className = 'cmd-block';
    el.title = c.cmd + '\n点击执行';
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

// 广播目标：列出所有已连接的标签
function renderBroadcast() {
  const box = $('broadcastList');
  box.innerHTML = '';
  const connected = [...tabs.values()].filter((t) => t.state === 'connected');
  if (!connected.length) {
    box.innerHTML = '<span class="none">暂无已连接的服务器</span>';
    return;
  }
  for (const t of connected) {
    const chip = document.createElement('span');
    const on = broadcastTargets.has(t.id);
    chip.className = 'bcast-chip' + (on ? ' on' : '');
    chip.textContent = (on ? '✓ ' : '') + t.title;
    chip.title = t.conn.username + '@' + t.conn.host;
    chip.addEventListener('click', () => {
      if (broadcastTargets.has(t.id)) broadcastTargets.delete(t.id);
      else broadcastTargets.add(t.id);
      renderBroadcast();
    });
    box.appendChild(chip);
  }
}

function runCommand(c) {
  // 选中了广播目标 → 同步发到所有选中终端；否则只发当前终端
  const targets = [...broadcastTargets]
    .map((id) => tabs.get(id))
    .filter((t) => t && t.state === 'connected');
  if (targets.length) {
    for (const tab of targets) {
      const pane = tab.panes.find((p) => p.id === tab.activePane) || tab.panes[0];
      if (pane) window.api.input(tab.id, pane.id, c.cmd + '\r');
    }
    toast(`已同步执行到 ${targets.length} 台服务器：${c.name}`);
    return;
  }
  const tab = tabs.get(activeTabId);
  if (!tab || tab.state !== 'connected') {
    toast('请先连接服务器', true);
    return;
  }
  const pane = tab.panes.find((p) => p.id === tab.activePane) || tab.panes[0];
  if (!pane) { toast('没有终端面板', true); return; }
  window.api.input(tab.id, pane.id, c.cmd + '\r');
  toast(`已执行：${c.name}`);
  try { pane.term.focus(); } catch (_) {}
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
let secretCb = null;
function askText(title, def, cb) {
  $('promptTitle').textContent = title;
  $('promptInput').value = def || '';
  promptCb = cb;
  $('promptDialog').showModal();
  setTimeout(() => { $('promptInput').select(); }, 50);
}
function askSecret(title, desc, cb) {
  $('secretTitle').textContent = title;
  $('secretDesc').textContent = desc;
  $('secretInput').value = '';
  secretCb = cb;
  $('secretDialog').showModal();
  setTimeout(() => { $('secretInput').select(); }, 50);
}
function askSecretAsync(title, desc) {
  return new Promise((resolve) => askSecret(title, desc, resolve));
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
  $('btnSecretCancel').addEventListener('click', () => {
    $('secretDialog').close();
    if (secretCb) secretCb(null);
    secretCb = null;
  });
  $('secretForm').addEventListener('submit', (e) => {
    e.preventDefault();
    $('secretDialog').close();
    if (secretCb) secretCb($('secretInput').value);
    secretCb = null;
  });
  $('secretDialog').addEventListener('cancel', () => {
    if (secretCb) secretCb(null);
    secretCb = null;
  });

  // 添加命令（居中对话框：第一栏名称，第二栏命令）
  $('btnCmdAdd').addEventListener('click', () => {
    $('cmdForm').elements['cmdName'].value = '';
    $('cmdForm').elements['cmdText'].value = '';
    $('cmdDialog').showModal();
  });
  $('btnCmdCancel').addEventListener('click', () => $('cmdDialog').close());
  $('cmdForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('cmdForm').elements['cmdName'].value.trim();
    const cmd = $('cmdForm').elements['cmdText'].value.trim();
    if (!name || !cmd) return;
    cmdList.push({ name, cmd });
    store.set('foxshell.cmds', cmdList);
    renderCmdList();
    $('cmdDialog').close();
    toast('命令已添加');
  });

  // 终端外观设置
  $('btnTermSettings').addEventListener('click', openTermDialog);
  $('btnTermCancel').addEventListener('click', () => $('termDialog').close());
  $('termForm').addEventListener('submit', saveTermForm);

  // 跳板机开关
  $('useJumpChk').addEventListener('change', () => {
    $('rowJump').style.display = $('useJumpChk').checked ? '' : 'none';
    if ($('useJumpChk').checked && !jumpDraft.length) addJumpRow();
  });
  $('btnJumpAdd').addEventListener('click', addJumpRow);

  // 端口转发
  $('btnForward').addEventListener('click', openFwdDialog);
  $('btnFwdClose').addEventListener('click', () => $('fwdDialog').close());
  $('fwdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const conn = currentConn();
    if (!conn) return;
    const FF = (n) => $('fwdForm').elements[n];
    const localPort = Number(FF('localPort').value);
    const dstHost = FF('dstHost').value.trim();
    const dstPort = Number(FF('dstPort').value);
    if (!localPort || !dstHost || !dstPort) { toast('请填写完整：本地端口 / 目标主机 / 目标端口', true); return; }
    if (!Array.isArray(conn.forwards)) conn.forwards = [];
    if (conn.forwards.some((r) => r.localPort === localPort)) {
      toast('本地端口已存在', true);
      return;
    }
    conn.forwards.push({
      id: uid(), localPort, dstHost, dstPort,
    });
    await persist();
    renderFwdList();
    toast('规则已添加，点「启动」开始转发');
    $('fwdForm').elements['localPort'].value = '';
  });

  // 连接配置导入 / 导出
  $('btnExportConns').addEventListener('click', async () => {
    if (!conns.length) { toast('还没有可导出的连接', true); return; }
    const p1 = await askSecretAsync('设置导出口令', '导出文件将加密保存，不包含明文口令。请务必记住此口令。');
    if (p1 == null) return;
    if (!p1) { toast('导出口令不能为空', true); return; }
    const p2 = await askSecretAsync('确认导出口令', '再次输入刚才设置的导出口令。');
    if (p2 == null) return;
    if (p1 !== p2) { toast('两次输入的口令不一致', true); return; }
    const r = await window.api.exportConns(conns, p1);
    if (r.ok) toast('已加密导出到：' + r.path);
    else if (r.error) toast('导出失败：' + r.error, true);
  });
  $('btnImportConns').addEventListener('click', async () => {
    const r = await window.api.importConns();
    if (!r.ok) {
      if (r.needsPassword) {
        const password = await askSecretAsync('输入导出口令', '此导出文件已加密，需要输入导出时设置的口令。');
        if (password == null) return;
        const r2 = await window.api.importConns(password, r.path);
        if (!r2.ok) {
          toast('导入失败：' + (r2.error || '未知错误'), true);
          return;
        }
        conns = conns.concat(r2.connections);
        const updated = await window.api.saveConns({ connections: conns, groups: allGroupNames(), secrets: {} });
        if (updated && updated.connections) conns = updated.connections;
        renderConnList();
        toast(`已导入 ${r2.count} 个连接`);
        return;
      }
      if (r.error) toast('导入失败：' + r.error, true);
      return;
    }
    conns = conns.concat(r.connections);
    const updated = await window.api.saveConns({ connections: conns, groups: allGroupNames(), secrets: {} });
    if (updated && updated.connections) conns = updated.connections;
    renderConnList();
    toast(`已导入 ${r.count} 个连接`);
  });

  // 终端搜索
  $('btnSearchClose').addEventListener('click', closeSearch);
  $('btnSearchNext').addEventListener('click', () => {
    const s = activeSearch();
    if (s) { try { s.findNext($('searchInput').value); } catch (_) {} }
  });
  $('btnSearchPrev').addEventListener('click', () => {
    const s = activeSearch();
    if (s) { try { s.findPrevious($('searchInput').value); } catch (_) {} }
  });
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const s = activeSearch();
      if (s) { try { (e.shiftKey ? s.findPrevious : s.findNext).call(s, $('searchInput').value); } catch (_) {} }
    }
    if (e.key === 'Escape') closeSearch();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && tabs.get(activeTabId)) {
      e.preventDefault();
      openSearch();
    }
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
    if (tab) fitAllPanes(tab);
  });
  ro.observe($('termStack'));

  // Ctrl + 滚轮调整终端字体大小
  $('termStack').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (!tabs.get(activeTabId)) return;
    termCfg.size = Math.max(8, Math.min(28, termCfg.size + (e.deltaY < 0 ? 1 : -1)));
    applyTermCfg();
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
}

init();

window.__hlDebug = function () {
  const tab = tabs.get(activeTabId);
  if (!tab) return console.warn('[hlDebug] 没有打开的标签页，请先连接服务器');
  const pane = tab.panes.find((p) => p.id === tab.activePane) || tab.panes[0];
  if (!pane) return console.warn('[hlDebug] 没有终端面板');
  const buf = pane.term.buffer.active;
  const line = buf.getLine(buf.baseY + buf.cursorY);
  const text = line ? line.translateToString(false) : '';
  const info = {
    光标行内容: JSON.stringify(text.trimEnd()),
    提示符截止位置: cmdPromptEnd(text),
    服务器命令数: tab.commands ? tab.commands.size : '未加载',
    缓冲类型: buf.type,
    待处理定时器: !!pane._cmdTimer,
    当前命令装饰数: pane._cmdDecs.length,
    webgl可用: (() => { try { return new WebglAddon.WebglAddon() instanceof Object; } catch (_) { return false; } })(),
  };
  console.table([info]);
  try {
    hlCommandLine(pane);
    console.log('[hlDebug] 手动着色完成，装饰数 =', pane._cmdDecs.length, '（若 >0 但屏幕无颜色，则是渲染层问题；若 =0，把上面表格内容发出来）');
  } catch (e) {
    console.error('[hlDebug] 着色异常:', e);
  }
  return info;
};

// 全局错误兜底：任何未捕获异常都以浮层提示，避免静默失败
window.addEventListener('unhandledrejection', (e) => {
  toast('出错了：' + (e.reason && e.reason.message ? e.reason.message : e.reason), true);
});
window.addEventListener('error', (e) => {
  toast('出错了：' + e.message, true);
});
