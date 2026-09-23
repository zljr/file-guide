/**
 * 逐层查找：把"从千万文件中找目标"分解为"每层一次 Choice"。
 * - 每层：Choice（哪个子项最相关，>250 分批并行多题）+ Noul（目标是否可能在这一层）
 * - 有名称关键词时先本地预筛，缩短短名单、省 token
 * 架构参考：https://docs.typesafe.ai/cookbooks/hierarchical_classification
 */
import type {
  FsNode,
  SearchOption,
  SearchPayload,
  SearchStepResult
} from '@shared/types'
import { listEntries, listFolders, FsOpError } from './fsService'
import { MODEL, NoApiKeyError, systemOneRequest, type ChoiceAnswer } from './typesafe'

/** 固定附带的 "uncertain" 选项 key */
const UNCERTAIN_KEY = 'uncertain'
/** Choice 单题最多 255 个选项，留余量 */
const MAX_PER_BATCH = 250
/** 单次搜索最多分批数（250 × 4 = 1000 个候选上限） */
const MAX_BATCHES = 4
/** 文件模式下无关键词时的候选数上限：超出则要求用户补关键词 */
const FILE_NO_KEYWORD_LIMIT = 300

interface Batch {
  key: string
  keyToChild: Map<string, FsNode>
}

/** 名称关键词本地预筛：子串匹配（不区分大小写） */
function prefilter(children: FsNode[], keyword: string): FsNode[] {
  const kw = keyword.toLowerCase()
  return children.filter((c) => c.name.toLowerCase().includes(kw))
}

function buildStateText(payload: SearchPayload, modeText: string, keyword: string, description: string): string {
  const lines: string[] = []
  lines.push(`用户正在查找一个${modeText}。`)
  if (keyword) {
    lines.push(`名称关键词：“${keyword}”（可能只是名称的一部分，也可能拼写不完全准确）。`)
  }
  if (description) {
    lines.push(`特征描述：“${description}”。`)
  }
  if (payload.trail.length > 0) {
    lines.push(`已经逐层下钻经过：${payload.trail.join(' > ')}。`)
  }
  lines.push(`当前正在查看的目录：“${payload.dirPath}”。`)
  lines.push(
    payload.mode === 'folder'
      ? '请判断用户要找的文件夹最可能是下列哪个子文件夹。'
      : '请判断用户要找的文件最可能是下列哪个文件。'
  )
  return lines.join('\n')
}

export async function searchStep(payload: SearchPayload, apiKey: string): Promise<SearchStepResult> {
  if (!apiKey.trim()) {
    throw new NoApiKeyError()
  }
  const keyword = payload.keyword.trim()
  const description = payload.description.trim()
  if (!keyword && !description) {
    throw new FsOpError('EMPTY_QUERY', '请至少填写名称关键词或特征描述之一')
  }

  const modeText = payload.mode === 'folder' ? '文件夹' : '文件'

  // 1. 取当前层候选
  let children: FsNode[]
  if (payload.mode === 'folder') {
    children = await listFolders(payload.dirPath)
  } else {
    children = (await listEntries(payload.dirPath)).filter((e) => !e.isDirectory)
  }
  const totalChildren = children.length
  if (totalChildren === 0) {
    return {
      options: [],
      best: null,
      confidence: 0,
      uncertain: true,
      uncertainProbability: 0,
      targetHere: 0,
      totalChildren: 0,
      sentChildren: 0,
      batchCount: 0,
      filteredByKeyword: false,
      message: `当前目录下没有${payload.mode === 'folder' ? '子文件夹' : '文件'}。请回上一层或更换目录。`
    }
  }

  // 2. 本地预筛
  let candidates = children
  let filteredByKeyword = false
  if (keyword) {
    const hits = prefilter(children, keyword)
    if (hits.length > 0) {
      candidates = hits
      filteredByKeyword = true
    }
  }

  const messages: string[] = []
  if (filteredByKeyword) {
    messages.push(`已按关键词本地预筛：${totalChildren} → ${candidates.length} 个候选。`)
  }

  // 3. 上限控制
  if (candidates.length > MAX_PER_BATCH * MAX_BATCHES) {
    return {
      options: [],
      best: null,
      confidence: 0,
      uncertain: true,
      uncertainProbability: 0,
      targetHere: null,
      totalChildren,
      sentChildren: 0,
      batchCount: 0,
      filteredByKeyword,
      message: `候选${modeText}多达 ${candidates.length} 个，超过单次搜索上限（${MAX_PER_BATCH * MAX_BATCHES}）。请补充更具体的名称关键词缩小范围。`
    }
  }
  if (payload.mode === 'file' && !filteredByKeyword && candidates.length > FILE_NO_KEYWORD_LIMIT) {
    return {
      options: [],
      best: null,
      confidence: 0,
      uncertain: true,
      uncertainProbability: 0,
      targetHere: null,
      totalChildren,
      sentChildren: 0,
      batchCount: 0,
      filteredByKeyword,
      message: `该目录下文件较多（${candidates.length} 个）且未提供名称关键词。请补充关键词以缩小范围。`
    }
  }

  // 4. 分批构造 questions（每批一个 Choice，同一调用并行评估）
  const batchCount = Math.max(1, Math.ceil(candidates.length / MAX_PER_BATCH))
  const batches: Batch[] = []
  const questions: Record<string, unknown> = {}
  for (let i = 0; i < batchCount; i++) {
    const chunk = candidates.slice(i * MAX_PER_BATCH, (i + 1) * MAX_PER_BATCH)
    const keyToChild = new Map<string, FsNode>()
    const criteria: Record<string, string> = {}
    for (const child of chunk) {
      const key = child.name === UNCERTAIN_KEY ? `item_${child.name}` : child.name
      criteria[key] = `${modeText} “${child.name}”`
      keyToChild.set(key, child)
    }
    criteria[UNCERTAIN_KEY] = '不确定：与这一批名称都不匹配，或无法判断'
    const key = `best_${i}`
    batches.push({ key, keyToChild })
    questions[key] = {
      type: 'choice',
      instructions:
        batchCount > 1
          ? `目标${modeText}的名称最可能是以下哪一个？（候选较多，此为第 ${i + 1}/${batchCount} 批；都不匹配请选 uncertain）`
          : `目标${modeText}的名称最可能是以下哪一个？无法确定或都不匹配请选 uncertain。`,
      criteria
    }
  }
  questions['target_here'] = {
    type: 'noul',
    instructions: `综合考虑名称关键词与特征描述，用户要找的${modeText}是否可能就在目录“${payload.dirPath}”的直接子项中？`
  }

  // 5. 请求
  const data = await systemOneRequest(
    {
      state: buildStateText(payload, modeText, keyword, description),
      model: MODEL,
      questions
    },
    apiKey
  )

  // 6. 合并各批结果
  const options: SearchOption[] = []
  let bestByProb: { option: SearchOption; confidence: number } | null = null
  let allBatchesUncertain = true
  let uncertainProbability = 0
  let topConfidence = 0

  for (const batch of batches) {
    const answer: ChoiceAnswer | undefined = data.answers?.[batch.key]
    if (!answer || answer.type !== 'choice') {
      continue
    }
    const batchChoiceUncertain = answer.choice === UNCERTAIN_KEY
    if (!batchChoiceUncertain) {
      allBatchesUncertain = false
    }
    let batchBestProb = -1
    for (const [optionKey, probability] of Object.entries(answer.probabilities ?? {})) {
      if (optionKey === UNCERTAIN_KEY) {
        continue
      }
      const child = batch.keyToChild.get(optionKey)
      if (!child) {
        continue
      }
      options.push({ name: child.name, path: child.path, probability })
      if (probability > batchBestProb) {
        batchBestProb = probability
        if (!bestByProb || probability > bestByProb.option.probability) {
          bestByProb = { option: { name: child.name, path: child.path, probability }, confidence: answer.confidence ?? 0 }
        }
      }
    }
    const uProb = answer.probabilities?.[UNCERTAIN_KEY]
    if (typeof uProb === 'number' && batchBestProb < 0) {
      uncertainProbability = Math.max(uncertainProbability, uProb)
    }
    topConfidence = Math.max(topConfidence, answer.confidence ?? 0)
  }
  options.sort((a, b) => b.probability - a.probability)

  const targetHereAnswer = data.answers?.['target_here']
  const targetHere = typeof targetHereAnswer?.noul === 'number' ? targetHereAnswer.noul : null

  const uncertain = options.length === 0 || allBatchesUncertain
  if (batchCount > 1) {
    messages.push(`候选较多，已分 ${batchCount} 批并行评估；跨批次的概率仅供粗略参考。`)
  }

  return {
    options,
    best: bestByProb && !allBatchesUncertain ? bestByProb.option.path : null,
    confidence: bestByProb ? bestByProb.confidence : topConfidence,
    uncertain,
    uncertainProbability,
    targetHere,
    totalChildren,
    sentChildren: candidates.length,
    batchCount,
    filteredByKeyword,
    message: messages.length > 0 ? messages.join(' ') : undefined
  }
}
