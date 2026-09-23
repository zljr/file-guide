/**
 * 应用配置持久化：TypeSafe API Key 存储在 userData/config.json。
 * Key 只在主进程读取使用，渲染进程仅拿到掩码。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ApiResult, ConfigInfo } from '@shared/types'

interface AppConfig {
  typesafeApiKey?: string
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function loadConfig(): AppConfig {
  try {
    const file = configPath()
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as AppConfig
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

export function getApiKey(): string {
  return (loadConfig().typesafeApiKey ?? '').trim()
}

export function getConfigInfo(): ConfigInfo {
  const key = getApiKey()
  if (!key) {
    return { hasApiKey: false, apiKeyMasked: '' }
  }
  const tail = key.length > 4 ? key.slice(-4) : ''
  const head = key.length > 8 ? key.slice(0, 3) : ''
  return {
    hasApiKey: true,
    apiKeyMasked: tail ? `${head}****${tail}` : '****'
  }
}

export function saveApiKey(rawKey: string): ApiResult<ConfigInfo> {
  const key = rawKey.trim()
  if (!key) {
    return { ok: false, code: 'EMPTY_KEY', message: 'API Key 不能为空' }
  }
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    writeFileSync(configPath(), JSON.stringify({ typesafeApiKey: key } satisfies AppConfig, null, 2), 'utf-8')
    return { ok: true, data: getConfigInfo() }
  } catch (err) {
    return {
      ok: false,
      code: 'CONFIG_WRITE_FAILED',
      message: `保存配置失败：${err instanceof Error ? err.message : String(err)}`
    }
  }
}
