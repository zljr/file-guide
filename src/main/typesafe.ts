/**
 * TypeSafe（Jev / System One）客户端：把"当前输入的名称最可能属于哪个子文件夹"
 * 表达为一个 Choice 问题，候选 criteria 就是当前目录下的子文件夹。
 * 文档：https://docs.typesafe.ai/primitives/choice
 */
import type {
  FsNode,
  SuggestPayload,
  SuggestOption,
  SuggestResult
} from '@shared/types'
import { listFolders, FsOpError } from './fsService'

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const MODEL = 'jev-latest'
/** 固定附带的 "uncertain" 选项 key：模型不确定 / 都不相关时选择它，与子文件夹名冲突时会给文件夹加前缀 */
const UNCERTAIN_KEY = 'uncertain'
/** Choice 单题最多 255 个选项，留余量 */
const MAX_OPTIONS = 250
const REQUEST_TIMEOUT_MS = 30_000

export class NoApiKeyError extends Error {
  constructor() {
    super('尚未设置 TypeSafe API Key，请点击右上角设置图标填入')
  }
}

export interface ChoiceAnswer {
  type: string
  choice?: string
  confidence?: number
  probabilities?: Record<string, number>
  score?: number
  noul?: number
  legend?: Record<string, string>
}

export interface SystemOneResponse {
  model?: string
  answers?: Record<string, ChoiceAnswer>
  usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * 发起一次 System One 请求：统一处理鉴权、超时、HTTP 错误与 JSON 解析。
 * 供"新建推荐"与"查找"共用。
 */
export async function systemOneRequest(
  body: Record<string, unknown>,
  apiKey: string
): Promise<SystemOneResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
  } catch (err) {
    if (controller.signal.aborted) {
      throw new FsOpError('API_TIMEOUT', 'TypeSafe 请求超时，请稍后重试')
    }
    throw new FsOpError('NETWORK_ERROR', `无法连接 TypeSafe 服务：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    let detail = ''
    try {
      const errBody = (await response.json()) as { message?: string; error?: { message?: string } }
      detail = errBody?.message ?? errBody?.error?.message ?? ''
    } catch {
      /* 响应体不是 JSON，忽略 */
    }
    if (response.status === 401 || response.status === 403) {
      throw new FsOpError('API_KEY_INVALID', 'TypeSafe API Key 无效或没有权限，请检查设置')
    }
    throw new FsOpError(
      'API_ERROR',
      `TypeSafe 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`
    )
  }

  return (await response.json()) as SystemOneResponse
}

/** 构造发送给模型的 state 文本 */
function buildState(payload: SuggestPayload, ext: string): string {
  const kindText = payload.kind === 'folder' ? '文件夹' : '文件'
  const finalName = payload.base + (payload.kind === 'file' ? ext : '')
  const lines = [
    `用户当前浏览的目录：“${payload.dirPath}”。`,
    `用户想在这个目录下新建一个${kindText}，拟用名称：“${finalName}”。`
  ]
  if (payload.sourceName) {
    lines.push(`（该文件来自用户上传，原始文件名：“${payload.sourceName}”）`)
  }
  lines.push(
    '请判断这个拟用名称与当前目录下哪个子文件夹的内容主题最相关、最应该被放进去。'
  )
  return lines.join('\n')
}

interface QuestionBody {
  type: 'choice'
  instructions: string
  criteria: Record<string, string>
}

/** 构造 Choice 问题体，返回问题体和 key → 文件夹 的映射 */
function buildQuestion(folders: FsNode[]): { question: QuestionBody; keyToFolder: Map<string, FsNode> } {
  const criteria: Record<string, string> = {}
  const keyToFolder = new Map<string, FsNode>()
  for (const folder of folders) {
    // 极小概率：子文件夹名恰好叫 uncertain，加前缀避开
    const key = folder.name === UNCERTAIN_KEY ? `folder_${folder.name}` : folder.name
    criteria[key] = `子文件夹 “${folder.name}”`
    keyToFolder.set(key, folder)
  }
  criteria[UNCERTAIN_KEY] =
    '不确定：无法确定该名称最属于以上哪个子文件夹，或它与这一层目录的所有子文件夹都不相关'
  return {
    question: {
      type: 'choice',
      instructions:
        '新文件的名称最应该放入下面哪个子文件夹？如果无法确定或都不匹配，请选择 uncertain。',
      criteria
    },
    keyToFolder
  }
}

export async function suggestFolder(payload: SuggestPayload, apiKey: string): Promise<SuggestResult> {
  const key = apiKey.trim()
  if (!key) {
    throw new NoApiKeyError()
  }

  const folders = await listFolders(payload.dirPath)
  if (folders.length === 0) {
    return {
      options: [],
      best: null,
      confidence: 0,
      uncertain: true,
      uncertainProbability: 0,
      message: '当前目录下没有任何子文件夹，无法给出推荐。可以直接在当前目录创建，或选择其他目录。'
    }
  }

  let truncated: string | undefined
  let candidates = folders
  if (folders.length > MAX_OPTIONS) {
    candidates = folders.slice(0, MAX_OPTIONS)
    truncated = `该目录下子文件夹超过 ${MAX_OPTIONS} 个，仅将前 ${MAX_OPTIONS} 个发送给模型判断。`
  }

  const { question, keyToFolder } = buildQuestion(candidates)
  const data = await systemOneRequest(
    {
      state: buildState(payload, payload.ext ?? ''),
      model: MODEL,
      questions: { best_folder: question }
    },
    key
  )

  const answer = data.answers?.best_folder
  if (!answer || answer.type !== 'choice') {
    throw new FsOpError('API_BAD_RESPONSE', 'TypeSafe 返回了无法解析的结果，请稍后重试')
  }

  const uncertain = answer.choice === UNCERTAIN_KEY
  const bestKey = uncertain ? null : (answer.choice ?? null)
  const bestFolder = bestKey ? keyToFolder.get(bestKey) : undefined

  // 组装按概率降序的候选列表；uncertain 单独记录其概率并在界面展示
  const options: SuggestOption[] = []
  let uncertainProbability = 0
  for (const [optionKey, probability] of Object.entries(answer.probabilities ?? {})) {
    if (optionKey === UNCERTAIN_KEY) {
      uncertainProbability = probability
      continue
    }
    const folder = keyToFolder.get(optionKey)
    if (folder) {
      options.push({ folder: folder.name, path: folder.path, probability })
    }
  }
  options.sort((a, b) => b.probability - a.probability)

  return {
    options,
    best: bestFolder ? bestFolder.path : null,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : 0,
    uncertain,
    uncertainProbability,
    message: truncated
  }
}
