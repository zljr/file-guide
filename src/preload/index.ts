import { contextBridge, ipcRenderer } from 'electron'
import type {
  ApiResult,
  AutoSearchPayload,
  AutoSearchProgress,
  AutoSearchResult,
  CommitPayload,
  ConfigInfo,
  CreateResult,
  DriveInfo,
  FsNode,
  SearchPayload,
  SearchStepResult,
  SuggestPayload,
  SuggestResult
} from '@shared/types'

export interface FileGuideApi {
  getConfig(): Promise<ApiResult<ConfigInfo>>
  setApiKey(key: string): Promise<ApiResult<ConfigInfo>>
  getDrives(): Promise<ApiResult<DriveInfo[]>>
  listFolders(dirPath: string): Promise<ApiResult<FsNode[]>>
  /** 列出目录下全部条目（含文件，供目录树展示） */
  listEntries(dirPath: string): Promise<ApiResult<FsNode[]>>
  pickSourceFile(): Promise<ApiResult<{ path: string; name: string } | null>>
  commit(payload: CommitPayload): Promise<ApiResult<CreateResult>>
  suggest(payload: SuggestPayload): Promise<ApiResult<SuggestResult>>
  /** 逐层查找：单层搜索（文件夹或文件） */
  searchStep(payload: SearchPayload): Promise<ApiResult<SearchStepResult>>
  /**
   * 一键查找：全自动下钻，返回全局 Top10。
   * onProgress 可选，接收查找过程中的进度回报（search:autoProgress 事件）。
   */
  autoSearch(
    payload: AutoSearchPayload,
    onProgress?: (progress: AutoSearchProgress) => void
  ): Promise<ApiResult<AutoSearchResult>>
  /** 在资源管理器中显示目标（查找的结果动作） */
  reveal(targetPath: string): Promise<ApiResult<null>>
}

const api: FileGuideApi = {
  getConfig: () => ipcRenderer.invoke('app:getConfig'),
  setApiKey: (key) => ipcRenderer.invoke('app:setApiKey', key),
  getDrives: () => ipcRenderer.invoke('fs:getDrives'),
  listFolders: (dirPath) => ipcRenderer.invoke('fs:listFolders', dirPath),
  listEntries: (dirPath) => ipcRenderer.invoke('fs:listEntries', dirPath),
  pickSourceFile: () => ipcRenderer.invoke('fs:pickSourceFile'),
  commit: (payload) => ipcRenderer.invoke('fs:commit', payload),
  suggest: (payload) => ipcRenderer.invoke('typesafe:suggest', payload),
  searchStep: (payload) => ipcRenderer.invoke('typesafe:searchStep', payload),
  autoSearch: (payload, onProgress) => {
    const channel = 'search:autoProgress'
    const listener = (_event: Electron.IpcRendererEvent, progress: AutoSearchProgress): void => {
      onProgress?.(progress)
    }
    if (onProgress) {
      ipcRenderer.on(channel, listener)
    }
    return ipcRenderer.invoke('search:auto', payload).finally(() => {
      if (onProgress) {
        ipcRenderer.removeListener(channel, listener)
      }
    })
  },
  reveal: (targetPath) => ipcRenderer.invoke('fs:reveal', targetPath)
}

contextBridge.exposeInMainWorld('api', api)
