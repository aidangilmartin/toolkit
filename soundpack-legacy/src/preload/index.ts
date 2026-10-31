import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type Api } from '../shared/ipc'

const api: Api = {
  listTemplates: () => ipcRenderer.invoke(IPC.listTemplates),
  importAwcFiles: (paths) => ipcRenderer.invoke(IPC.importAwcFiles, paths),
  importCodeWalkerFolders: (paths) => ipcRenderer.invoke(IPC.importCodeWalkerFolders, paths),
  readTemplate: (pack, file) => ipcRenderer.invoke(IPC.readTemplate, pack, file),
  removeTemplate: (pack, file) => ipcRenderer.invoke(IPC.removeTemplate, pack, file),
  setTemplatePack: (pack, file, newPack) => ipcRenderer.invoke(IPC.setTemplatePack, pack, file, newPack),
  getLabels: () => ipcRenderer.invoke(IPC.getLabels),
  setLabel: (key, label) => ipcRenderer.invoke(IPC.setLabel, key, label),
  pickAudioFiles: () => ipcRenderer.invoke(IPC.pickAudioFiles),
  readFiles: (paths) => ipcRenderer.invoke(IPC.readFiles, paths),
  pathForFile: (file) => webUtils.getPathForFile(file),
  saveProject: (json, sources, path) => ipcRenderer.invoke(IPC.saveProject, json, sources, path),
  openProject: () => ipcRenderer.invoke(IPC.openProject),
  getGameSettings: () => ipcRenderer.invoke(IPC.getGameSettings),
  setGtaPath: (path) => ipcRenderer.invoke(IPC.setGtaPath, path),
  getVanillaStatus: () => ipcRenderer.invoke(IPC.getVanillaStatus),
  importVanillaPack: (from, path) => ipcRenderer.invoke(IPC.importVanillaPack, from, path),
  makeVanillaPack: () => ipcRenderer.invoke(IPC.makeVanillaPack),
  saveVanillaZip: () => ipcRenderer.invoke(IPC.saveVanillaZip),
  loadVanillaPack: () => ipcRenderer.invoke(IPC.loadVanillaPack),
  getWeaponIndex: () => ipcRenderer.invoke(IPC.getWeaponIndex),
  getSoundMap: () => ipcRenderer.invoke(IPC.getSoundMap),
  loadGameBanks: (banks) => ipcRenderer.invoke(IPC.loadGameBanks, banks),
  onGameProgress: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, message: string): void => listener(message)
    ipcRenderer.on(IPC.gameProgress, handler)
    return () => ipcRenderer.removeListener(IPC.gameProgress, handler)
  },
  exportArchives: (name, banks) => ipcRenderer.invoke(IPC.exportArchives, name, banks),
  exportIdPack: (name, banks) => ipcRenderer.invoke(IPC.exportIdPack, name, banks),
  showInFolder: (path) => ipcRenderer.invoke(IPC.showInFolder, path),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url)
}

contextBridge.exposeInMainWorld('api', api)
