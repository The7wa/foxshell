'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadConns: () => ipcRenderer.invoke('conns:load'),
  saveConns: (data) => ipcRenderer.invoke('conns:save', data),
  pickKeyFile: () => ipcRenderer.invoke('app:pickKeyFile'),

  connect: (tabId, conn) => ipcRenderer.invoke('ssh:connect', { tabId, conn }),
  input: (tabId, data) => ipcRenderer.send('ssh:input', { tabId, data }),
  resize: (tabId, cols, rows) => ipcRenderer.send('ssh:resize', { tabId, cols, rows }),
  close: (tabId) => ipcRenderer.send('ssh:close', { tabId }),

  sftpList: (tabId, dirPath) => ipcRenderer.send('sftp:list', { tabId, dirPath }),
  sftpMkdir: (tabId, dirPath, name) => ipcRenderer.send('sftp:mkdir', { tabId, dirPath, name }),
  sftpDelete: (tabId, dirPath, entry) => ipcRenderer.send('sftp:delete', { tabId, dirPath, entry }),
  sftpRename: (tabId, dirPath, oldName, newName) => ipcRenderer.send('sftp:rename', { tabId, dirPath, oldName, newName }),
  sftpUpload: (tabId, dirPath) => ipcRenderer.invoke('sftp:upload', { tabId, dirPath }),
  sftpDownload: (tabId, dirPath, entry) => ipcRenderer.invoke('sftp:download', { tabId, dirPath, entry }),

  onEvent: (cb) => {
    ipcRenderer.on('ssh-event', (e, evt) => cb(evt));
  },
});
