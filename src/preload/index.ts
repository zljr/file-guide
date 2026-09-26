import { contextBridge, ipcRenderer } from 'electron'
import type {
  ApiResult,
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
  /** 校验并规范化手动输入的目录路径（路径栏编辑跳转） */
  resolveDir(dirPath: string): Promise<ApiResult<{ path: string }>>
  /** 取父目录（根目录返回 null）——「返回上一层」 */
  parentDir(dirPath: string): Promise<ApiResult<{ path: string } | null>>
  pickSourceFile(): Promise<ApiResult<{ path: string; name: string } | null>>
  commit(payload: CommitPayload): Promise<ApiResult<CreateResult>>
  suggest(payload: SuggestPayload): Promise<ApiResult<SuggestResult>>
  /** 逐层查找：单层搜索（文件夹或文件） */
  searchStep(payload: SearchPayload): Promise<ApiResult<SearchStepResult>>
  /** 在资源管理器中显示目标（查找的结果动作） */
  reveal(targetPath: string): Promise<ApiResult<null>>
  /** 用系统默认方式打开目标（文件夹→资源管理器，文件→默认程序） */
  open(targetPath: string): Promise<ApiResult<null>>
}

const api: FileGuideApi = {
  getConfig: () => ipcRenderer.invoke('app:getConfig'),
  setApiKey: (key) => ipcRenderer.invoke('app:setApiKey', key),
  getDrives: () => ipcRenderer.invoke('fs:getDrives'),
  listFolders: (dirPath) => ipcRenderer.invoke('fs:listFolders', dirPath),
  listEntries: (dirPath) => ipcRenderer.invoke('fs:listEntries', dirPath),
  resolveDir: (dirPath) => ipcRenderer.invoke('fs:resolveDir', dirPath),
  parentDir: (dirPath) => ipcRenderer.invoke('fs:parentDir', dirPath),
  pickSourceFile: () => ipcRenderer.invoke('fs:pickSourceFile'),
  commit: (payload) => ipcRenderer.invoke('fs:commit', payload),
  suggest: (payload) => ipcRenderer.invoke('typesafe:suggest', payload),
  searchStep: (payload) => ipcRenderer.invoke('typesafe:searchStep', payload),
  reveal: (targetPath) => ipcRenderer.invoke('fs:reveal', targetPath),
  open: (targetPath) => ipcRenderer.invoke('fs:open', targetPath)
}

contextBridge.exposeInMainWorld('api', api)
