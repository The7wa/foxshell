'use strict';
/* global Terminal, FitAddon, SearchAddon */

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
        c.jumpPasswordEnc = u.jumpPasswordEnc;
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
  F('useJump').checked = !!(conn && conn.useJump);
  F('jumpHost').value = conn ? conn.jumpHost || '' : '';
  F('jumpPort').value = conn ? conn.jumpPort || 22 : 22;
  F('jumpUser').value = conn ? conn.jumpUsername || '' : '';
  F('jumpPassword').value = '';
  F('jumpPassword').placeholder = conn && !clone ? '留空则保持原密码' : '';
  $('rowJump').style.display = F('useJump').checked ? '' : 'none';
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
    const useJump = F('useJump').checked;
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
      useJump,
      jumpHost: useJump ? F('jumpHost').value.trim() : '',
      jumpPort: useJump ? Number(F('jumpPort').value) || 22 : 22,
      jumpUsername: useJump ? F('jumpUser').value.trim() : '',
      jumpPasswordEnc: old ? old.jumpPasswordEnc || '' : '',
      forwards: old ? old.forwards || [] : [],
    };
    if (!rec.keyPath && rec.authType === 'key') {
      toast('请选择私钥文件', true);
      return;
    }
    if (useJump && !rec.jumpHost) {
      toast('请填写跳板机地址', true);
      return;
    }
    if (group && !allGroupNames().includes(group)) extraGroups = [...extraGroups, group];
    const secrets = {
      [id]: {
        password: F('password').value,
        passphrase: F('passphrase').value,
        jumpPassword: F('jumpPassword').value,
      },
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
          c.jumpPasswordEnc = u.jumpPasswordEnc;
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
  // xterm 需要挂载到独立内容层，避免与悬浮工具栏互相干扰
  const inner = document.createElement('div');
  inner.style.cssText = 'position:absolute;inset:4px 0 0 8px;';
  el.appendChild(inner);
  term.open(inner);

  const pane = { id: paneId, el, inner, term, fit, search };
  const at = index < 0 || index > tab.panes.length ? tab.panes.length : index;
  tab.panes.splice(at, 0, pane);

  // 插入 DOM（按顺序重建 splitter）
  relayoutPanes(tab);

  term.onData((d) => window.api.input(tab.id, paneId, d));
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
  if (tab.state === 'connected') window.api.openPane(tab.id, paneId);
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
  $('termDialog').close();
  toast('终端外观已更新');
}

// ---------------- 主进程事件 ----------------
function handleEvent(evt) {
  const tab = tabs.get(evt.tabId);
  if (!tab) return;
  const { type, payload } = evt;
  if (type === 'pane-data') {
    const pane = tab.panes.find((p) => p.id === payload.paneId);
    if (pane) pane.term.write(b64ToBytes(payload.data));
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
      else window.api.openPane(tab.id, tab.panes[0].id);
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
  });

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
    const r = await window.api.exportConns(conns);
    if (r.ok) toast('已导出到：' + r.path);
  });
  $('btnImportConns').addEventListener('click', async () => {
    const r = await window.api.importConns();
    if (!r.ok) {
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

// 全局错误兜底：任何未捕获异常都以浮层提示，避免静默失败
window.addEventListener('unhandledrejection', (e) => {
  toast('出错了：' + (e.reason && e.reason.message ? e.reason.message : e.reason), true);
});
window.addEventListener('error', (e) => {
  toast('出错了：' + e.message, true);
});
