# FoxShell  SSH 客户端

基于 Electron + xterm.js + ssh2 的 SSH 连接管理工具，包含 FinalShell 核心功能：

- **连接管理器**：左侧主机列表，支持分组、搜索；密码 / 私钥两种认证方式；口令本地 AES 加密存储
- **多标签页终端**：xterm-256color 全屏色彩支持，窗口自适应，选中自动复制
- **资源监控面板**：终端下方实时显示 CPU、内存、网络上下行速率、磁盘占用、负载、运行时长（每 2 秒刷新，读取 /proc，支持 Linux 服务器）
- **SFTP 文件管理**：右侧文件面板，支持目录浏览、上传、下载（含递归文件夹下载）、新建文件夹、重命名、删除，带传输进度条

## 运行

```bash
npm install        # 已装好可跳过；Electron 二进制下载慢可先设置 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm start
```

## 使用

1. 点左下角「＋ 新建连接」，填写主机 / 端口 / 用户名，选择密码或私钥登录
2. 双击左侧主机建立连接，可同时开多个标签页连不同服务器
3. 顶部「📂 文件」按钮开关 SFTP 面板；「⏻ 断开」断开当前会话，断开后变为「↻ 重连」

## 打包 exe

```bash
npm i -D electron-builder
npm run dist      # 输出到 dist/ 目录（NSIS 安装包 + 便携版）
```

## 说明

- 连接配置保存在 `%APPDATA%/foxshell/connections.json`，口令字段经 AES-256-CBC 加密（与 FinalShell 类似的本地混淆级别，非绝对安全，请勿在受控终端之外的机器保存敏感口令）
- 资源监控依赖 Linux 的 /proc 文件系统；连接 Windows / macOS 服务器时监控栏会提示不可用，终端与 SFTP 不受影响
