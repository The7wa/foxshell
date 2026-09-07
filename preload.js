'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadConns: () => ipcRenderer.invoke('conns:load'),
  saveConns: (data) => ipcRenderer.invoke('conns:save', data),
  pickKeyFile: () => ipcRenderer.invoke('app:pickKeyFile'),

  connect: (tabId, conn) => ipcRenderer.invoke('ssh:connect', { tabId, conn }),
  openPane: (tabId, paneId) => ipcRenderer.send('ssh:openPane', { tabId, paneId }),
  input: (tabId, paneId, data) => ipcRenderer.send('ssh:input', { tabId, paneId, data }),
  resize: (tabId, paneId, cols, rows) => ipcRenderer.send('ssh:resize', { tabId, paneId, cols, rows }),
  closePane: (tabId, paneId) => ipcRenderer.send('ssh:closePane', { tabId, paneId }),
  close: (tabId) => ipcRenderer.send('ssh:close', { tabId }),

  sftpList: (tabId, dirPath) => ipcRenderer.send('sftp:list', { tabId, dirPath }),
  sftpMkdir: (tabId, dirPath, name) => ipcRenderer.send('sftp:mkdir', { tabId, dirPath, name }),
  sftpDelete: (tabId, dirPath, entry) => ipcRenderer.send('sftp:delete', { tabId, dirPath, entry }),
  sftpRename: (tabId, dirPath, oldName, newName) => ipcRenderer.send('sftp:rename', { tabId, dirPath, oldName, newName }),
  sftpUpload: (tabId, dirPath) => ipcRenderer.invoke('sftp:upload', { tabId, dirPath }),
  sftpDownload: (tabId, dirPath, entry) => ipcRenderer.invoke('sftp:download', { tabId, dirPath, entry }),

  fwdStart: (tabId, rule) => ipcRenderer.send('fwd:start', { tabId, rule }),
  fwdStop: (tabId, ruleId) => ipcRenderer.send('fwd:stop', { tabId, ruleId }),
  exportConns: (connections, password) => ipcRenderer.invoke('conns:export', { connections, password }),
  importConns: (password, filePath) => ipcRenderer.invoke('conns:import', { password, filePath }),
  saveText: (content, defaultName) => ipcRenderer.invoke('app:saveText', { content, defaultName }),

  onEvent: (cb) => {
    ipcRenderer.on('ssh-event', (e, evt) => cb(evt));
  },
});
