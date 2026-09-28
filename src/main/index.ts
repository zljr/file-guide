/**
 * 主进程入口：窗口创建 + 全部 IPC 处理器。
 * 所有文件系统 / 网络 / 对话框操作都在这里完成，渲染进程通过 preload 暴露的类型化 api 调用。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'path'
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
import { validateFileName, validateFolderName } from '@shared/validate'
import { autoSearch } from './autoSearch'
import { getApiKey, getConfigInfo, saveApiKey } from './config'
import { searchStep } from './search'
import {
  copyFileIn,
  createFile,
  createFolder,
  FsOpError,
  getDrives,
  listEntries,
  listFolders
} from './fsService'
import { NoApiKeyError, suggestFolder } from './typesafe'

app.setName('file-guide')

// 开发模式开启 CDP 调试端口，便于自动化检查渲染进程；打包后不生效
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'File Guide — 智能归档助手',
    icon: join(app.getAppPath(), 'build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // 外部链接交给系统浏览器，不在应用内打开
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** 把任意异常包成 ApiResult 错误结构 */
function toApiError(err: unknown): ApiResult<never> {
  if (err instanceof FsOpError) {
    return { ok: false, code: err.code, message: err.message }
  }
  if (err instanceof NoApiKeyError) {
    return { ok: false, code: 'NO_API_KEY', message: err.message }
  }
  return {
    ok: false,
    code: 'UNKNOWN',
    message: `发生未知错误：${err instanceof Error ? err.message : String(err)}`
  }
}

/** 把 IPC 处理函数统一包成 ApiResult，渲染进程不需要 try/catch */
function handle<I, T>(channel: string, fn: (payload: I) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, payload: I): Promise<ApiResult<T>> => {
    try {
      return { ok: true, data: await fn(payload) }
    } catch (err) {
      return toApiError(err)
    }
  })
}

function registerIpc(): void {
  handle('app:getConfig', (): ConfigInfo => getConfigInfo())

  handle('app:setApiKey', (key: string): ApiResult<ConfigInfo> => saveApiKey(key))

  handle('fs:getDrives', (): Promise<DriveInfo[]> => getDrives())

  handle('fs:listFolders', (dirPath: string): Promise<FsNode[]> => listFolders(dirPath))

  handle('fs:listEntries', (dirPath: string): Promise<FsNode[]> => listEntries(dirPath))

  handle('fs:pickSourceFile', async (): Promise<{ path: string; name: string } | null> => {
    const win = BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: '选择要上传的文件',
      properties: ['openFile'],
      buttonLabel: '选择文件'
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    const filePath = result.filePaths[0]
    return { path: filePath, name: filePath.split(/[\\/]/).pop() ?? filePath }
  })

  handle('fs:commit', (payload: CommitPayload): Promise<CreateResult> => {
    const { mode, targetDir, base } = payload
    // 主进程二次校验（与渲染进程同一套规则）
    const check =
      mode === 'folder'
        ? validateFolderName(base)
        : validateFileName(base, payload.extMode, payload.presetExt ?? '', payload.customExt ?? '')
    if (!check.valid) {
      throw new FsOpError('INVALID_NAME', check.reason ?? '名称不合法')
    }
    if (mode === 'upload') {
      if (!payload.sourcePath) {
        throw new FsOpError('NO_SOURCE', '尚未选择要上传的源文件')
      }
      return copyFileIn(payload.sourcePath, targetDir, check.finalName)
    }
    if (mode === 'folder') {
      return createFolder(targetDir, check.finalName)
    }
    return createFile(targetDir, check.finalName)
  })

  handle('typesafe:suggest', (payload: SuggestPayload): Promise<SuggestResult> =>
    suggestFolder(payload, getApiKey())
  )

  handle('typesafe:searchStep', (payload: SearchPayload): Promise<SearchStepResult> =>
    searchStep(payload, getApiKey())
  )

  // 一键查找：全程自动下钻，通过 search:autoProgress 事件流回报进度
  ipcMain.handle(
    'search:auto',
    async (event, payload: AutoSearchPayload): Promise<ApiResult<AutoSearchResult>> => {
      try {
        const data = await autoSearch(payload, getApiKey(), (progress: AutoSearchProgress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('search:autoProgress', progress)
          }
        })
        return { ok: true, data }
      } catch (err) {
        return toApiError(err)
      }
    }
  )

  handle('fs:reveal', (targetPath: string): null => {
    shell.showItemInFolder(targetPath)
    return null
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
