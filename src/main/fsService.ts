/**
 * 文件系统服务：盘符检测、目录浏览、创建文件/文件夹、复制上传文件。
 * 全部运行在主进程，IPC 层负责统一错误包装。
 */
import { promises as fsp } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import type { CreateResult, DriveInfo, FsNode } from '@shared/types'

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
/** 检测不到任何盘符时的回退列表 */
const FALLBACK_LETTERS = ['C', 'D', 'E', 'F']

export async function getDrives(): Promise<DriveInfo[]> {
  const found: DriveInfo[] = []
  for (const letter of DRIVE_LETTERS) {
    const root = `${letter}:\\`
    try {
      const stat = await fsp.stat(root)
      if (stat.isDirectory()) {
        found.push({ letter, root })
      }
    } catch {
      // 盘符不存在或不可访问，跳过
    }
  }
  if (found.length > 0) {
    return found
  }
  return FALLBACK_LETTERS.map((letter) => ({ letter, root: `${letter}:\\` }))
}

/** 列出目录下的子文件夹（按中文本地化排序）——TypeSafe 推荐仍只使用文件夹 */
export async function listFolders(dirPath: string): Promise<FsNode[]> {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true })
  const folders = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: join(dirPath, e.name), isDirectory: true }))
  folders.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  return folders
}

/** 列出目录下的全部条目（文件夹在前、文件在后，各自按中文本地化排序）——供目录树展示 */
export async function listEntries(dirPath: string): Promise<FsNode[]> {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true })
  const nodes: FsNode[] = entries.map((e) => ({
    name: e.name,
    path: join(dirPath, e.name),
    isDirectory: e.isDirectory()
  }))
  nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1
    }
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
  return nodes
}

export class FsOpError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** 校验并规范化用户手动输入的目录路径（路径栏「编辑」跳转用） */
export async function resolveDir(input: string): Promise<{ path: string }> {
  let trimmed = input.trim()
  if (!trimmed) {
    throw new FsOpError('EMPTY_PATH', '路径不能为空')
  }
  // "D:" 视为 "D:\"
  if (/^[A-Za-z]:$/.test(trimmed)) {
    trimmed += '\\'
  }
  if (!isAbsolute(trimmed)) {
    throw new FsOpError('INVALID_PATH', '请输入完整路径，如 D:\\分盘软件')
  }
  const normalized = resolve(trimmed)
  try {
    const stat = await fsp.stat(normalized)
    if (!stat.isDirectory()) {
      throw new FsOpError('NOT_A_DIR', `“${normalized}” 不是文件夹`)
    }
  } catch (err) {
    if (err instanceof FsOpError) throw err
    throw new FsOpError('NOT_FOUND', `找不到文件夹：“${normalized}”`)
  }
  return { path: normalized }
}

/** 取目录的父目录（根目录如 C:\ 返回 null）——「返回上一层」用 */
export function parentDir(dirPath: string): { path: string } | null {
  const normalized = resolve(dirPath)
  const parent = dirname(normalized)
  if (parent === normalized) {
    return null
  }
  return { path: parent }
}

/** 把底层错误翻译成用户可读的提示 */
function translateFsError(err: unknown, target: string): FsOpError {
  const e = err as NodeJS.ErrnoException
  if (e?.code === 'EEXIST') {
    return new FsOpError('ALREADY_EXISTS', `“${target}” 已存在`)
  }
  if (e?.code === 'EACCES' || e?.code === 'EPERM') {
    return new FsOpError('NO_PERMISSION', `没有权限写入 “${target}”`)
  }
  if (e?.code === 'ENOENT') {
    return new FsOpError('NOT_FOUND', `路径不存在（目标目录可能已被移动或删除）`)
  }
  if (e?.code === 'EBUSY' || e?.code === 'EISDIR' || e?.code === 'ENOTEMPTY') {
    return new FsOpError('FS_BUSY', `“${target}” 正被占用或操作不受支持`)
  }
  return new FsOpError('FS_ERROR', `操作失败：${e?.message ?? String(err)}`)
}

/** 在 dirPath 下新建空文件（已存在时报错） */
export async function createFile(dirPath: string, finalName: string): Promise<CreateResult> {
  const target = join(dirPath, finalName)
  try {
    const handle = await fsp.open(target, 'wx')
    await handle.close()
    return { path: target }
  } catch (err) {
    throw translateFsError(err, finalName)
  }
}

/** 在 dirPath 下新建文件夹（已存在时报错） */
export async function createFolder(dirPath: string, finalName: string): Promise<CreateResult> {
  const target = join(dirPath, finalName)
  try {
    await fsp.mkdir(target) // 不递归：已存在即抛 EEXIST
    return { path: target }
  } catch (err) {
    throw translateFsError(err, finalName)
  }
}

/** 把上传选择的源文件复制到 dirPath 下并命名为 finalName */
export async function copyFileIn(
  sourcePath: string,
  dirPath: string,
  finalName: string
): Promise<CreateResult> {
  try {
    await fsp.copyFile(sourcePath, join(dirPath, finalName), fsp.constants.COPYFILE_EXCL)
    return { path: join(dirPath, finalName) }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e?.code === 'ENOENT') {
      throw new FsOpError('SOURCE_NOT_FOUND', '源文件不存在，请重新选择')
    }
    throw translateFsError(err, finalName)
  }
}
