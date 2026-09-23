/**
 * 文件名 / 文件夹名校验规则（渲染进程实时提示 + 主进程落盘前二次校验）
 * 规则参考 Windows 文件系统限制：
 * - 非法字符 <>:"/\|?* 及控制字符
 * - 保留设备名 CON、PRN、AUX、NUL、COM1-9、LPT1-9（带不带后缀都保留）
 * - 不能以点号或空格结尾，不能只由点号组成
 * - 长度上限 255
 */
import type { EntryKind, ExtMode } from './types'
import { PRESET_EXTENSIONS } from './types'

const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001F]/

const RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)
])

export const MAX_NAME_LENGTH = 255

export interface NameCheckResult {
  valid: boolean
  /** 不合法时的中文原因 */
  reason?: string
  /** 去除首尾空格后的基本名 */
  base: string
  /** 最终落盘名（基本名 + 后缀） */
  finalName: string
}

/** 拆分文件名的基本名与后缀（".md" / "a.b.c" → base "a", ext ".b.c"；隐藏文件 ".gitignore" 视为无后缀） */
export function splitNameExtension(fileName: string): { base: string; ext: string } {
  const idx = fileName.lastIndexOf('.')
  if (idx <= 0 || idx === fileName.length - 1) {
    return { base: fileName, ext: '' }
  }
  return { base: fileName.slice(0, idx), ext: fileName.slice(idx) }
}

/** 校验基本名（不含后缀），返回错误原因或 null */
export function checkBaseName(rawBase: string): { base: string; reason?: string } {
  const base = rawBase.trim()
  if (!base) {
    return { base, reason: '名称不能为空' }
  }
  if (INVALID_CHARS.test(base)) {
    return { base, reason: '名称包含 Windows 非法字符（<>:"/\\|?* 或控制字符）' }
  }
  if (/^\.+$/.test(base)) {
    return { base, reason: '名称不能只由点号组成' }
  }
  if (base.endsWith('.') || base.endsWith(' ')) {
    return { base, reason: '名称不能以点号或空格结尾' }
  }
  if (RESERVED_NAMES.has(base.toUpperCase())) {
    return { base, reason: `"${base}" 是 Windows 保留设备名，不能使用` }
  }
  return { base }
}

/** 校验自定义后缀，返回带前导点的规范后缀或错误原因 */
export function checkCustomExtension(rawExt: string): { ext: string; reason?: string } {
  let ext = rawExt.trim()
  if (!ext) {
    return { ext: '', reason: '自定义后缀不能为空' }
  }
  if (ext.startsWith('.')) {
    ext = ext.slice(1)
  }
  if (!ext) {
    return { ext: '', reason: '自定义后缀不能只是点号' }
  }
  if (INVALID_CHARS.test(ext) || /\s/.test(ext)) {
    return { ext, reason: '后缀包含非法字符或空格' }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(ext)) {
    return { ext, reason: '后缀需以字母或数字开头，仅含字母/数字/下划线/连字符，长度 1–16' }
  }
  return { ext: `.${ext}` }
}

/**
 * 校验新建文件名
 * @param rawBase 基本名输入
 * @param extMode 后缀模式
 * @param presetExt 预设后缀（extMode === 'preset' 时使用）
 * @param customExt 自定义后缀输入（extMode === 'custom' 时使用）
 */
export function validateFileName(
  rawBase: string,
  extMode: ExtMode,
  presetExt: string,
  customExt: string
): NameCheckResult {
  const { base, reason } = checkBaseName(rawBase)
  if (reason) {
    return { valid: false, reason, base: rawBase.trim(), finalName: rawBase.trim() }
  }

  let ext = ''
  if (extMode === 'preset') {
    if (!presetExt) {
      return { valid: false, reason: '请选择一个预设后缀', base, finalName: base }
    }
    ext = presetExt
  } else if (extMode === 'custom') {
    const checked = checkCustomExtension(customExt)
    if (checked.reason) {
      return { valid: false, reason: checked.reason, base, finalName: base }
    }
    ext = checked.ext
  }
  // extMode === 'none' → ext 保持空串

  const finalName = base + ext
  if (finalName.length > MAX_NAME_LENGTH) {
    return { valid: false, reason: `名称过长（含后缀最多 ${MAX_NAME_LENGTH} 个字符）`, base, finalName }
  }
  return { valid: true, base, finalName }
}

/** 校验新建文件夹名（文件夹无后缀概念，其余规则相同） */
export function validateFolderName(rawBase: string): NameCheckResult {
  const { base, reason } = checkBaseName(rawBase)
  if (reason) {
    return { valid: false, reason, base: rawBase.trim(), finalName: rawBase.trim() }
  }
  if (base.length > MAX_NAME_LENGTH) {
    return { valid: false, reason: `名称过长（最多 ${MAX_NAME_LENGTH} 个字符）`, base, finalName: base }
  }
  return { valid: true, base, finalName: base }
}

/** 按条目类型分发校验 */
export function validateName(
  kind: EntryKind,
  rawBase: string,
  extMode: ExtMode = 'none',
  presetExt = '',
  customExt = ''
): NameCheckResult {
  return kind === 'folder'
    ? validateFolderName(rawBase)
    : validateFileName(rawBase, extMode, presetExt, customExt)
}

/** 上传文件时根据原始文件名推断后缀模式与取值 */
export function inferExtModeFromSource(
  sourceName: string
): { base: string; extMode: ExtMode; presetExt: string; customExt: string } {
  const { base, ext } = splitNameExtension(sourceName)
  const presetList: readonly string[] = PRESET_EXTENSIONS
  if (!ext) {
    return { base, extMode: 'none', presetExt: '', customExt: '' }
  }
  if (presetList.includes(ext.toLowerCase())) {
    return { base, extMode: 'preset', presetExt: ext.toLowerCase(), customExt: '' }
  }
  return { base, extMode: 'custom', presetExt: '', customExt: ext }
}
