/**
 * 一键查找（全自动 AI 下钻）：
 * 用户只给出「名称关键词 + 大概用途描述」，程序自动把逐层 Choice 下钻跑完，
 * 无需人工逐步参与，最后返回全局 Top10（文件/文件夹）。
 *
 * 算法：目录树上的 best-first 搜索（优先队列式 beam search）
 * - 每个节点（目录）一次 System One 调用，包含三类问题并行评估：
 *   pick（目标是本层哪个直接子项，>250 分批）+ container（更深目标在哪个子文件夹里）+ target_here（Noul 门卫）
 * - 所有超过噪声门槛的 container 分支都进全局优先队列（不会在浅层被挤掉就永久丢失），
 *   每轮取 pathFactor 最高的 BEAM_WIDTH 个目录并行评估，直到预算用尽或队列为空
 * - 命中得分 = 层内概率 × 路径因子的深度几何折损，跨层可比，据此取全局 Top10
 * 预算：最多 MAX_CALLS 次调用 / 深度 MAX_DEPTH / 每轮并行 BEAM_WIDTH 个目录。
 */
import type {
  AutoSearchHit,
  AutoSearchPayload,
  AutoSearchProgress,
  AutoSearchResult,
  FsNode
} from '@shared/types'
import { listEntries, FsOpError } from './fsService'
import { MODEL, NoApiKeyError, systemOneRequest, type ChoiceAnswer } from './typesafe'

/** 固定附带的 "uncertain" 选项 key */
const UNCERTAIN_KEY = 'uncertain'
/** Choice 单题最多 255 个选项，留余量 */
const MAX_PER_BATCH = 250
/** 单个目录单次调用最多分批数（250 × 4 = 1000 个候选上限） */
const MAX_BATCHES = 4
/** 每轮并行评估的目录数 */
const BEAM_WIDTH = 2
/** 最大下钻深度（搜索起点为第 0 层） */
const MAX_DEPTH = 6
/** 全程 API 调用预算 */
const MAX_CALLS = 24
/** container 概率低于该阈值的分支视为噪声，不进探索队列 */
const EXPAND_PROB_THRESHOLD = 0.01
/** 最强命中的层内概率低于该值时判定为「模型不确定」 */
const UNCERTAIN_PROB_THRESHOLD = 0.2
/** 文件夹特征采样：每个文件夹最多取多少个子项名（不做文件夹数量截断，避免饿死关键线索） */
const SAMPLE_CHILD_LIMIT = 8

/** 下钻中的一个目录节点 */
interface BeamNode {
  dirPath: string
  /** 从搜索起点到本节点（不含本节点）的目录名轨迹 */
  trail: string[]
  /** 本节点深度（搜索起点 = 0） */
  depth: number
  /** 沿途下钻概率连乘：用于把层内概率折算成全局可比得分 */
  pathFactor: number
}

interface NodeEval {
  node: BeamNode
  hits: AutoSearchHit[]
  /** 值得继续下钻的子目录（已按 container 概率折算 pathFactor） */
  expansions: BeamNode[]
  /** 截断 / 空目录等附注 */
  notes: string[]
}

function targetText(target: AutoSearchPayload['target']): string {
  return target === 'both' ? '文件或文件夹' : target === 'file' ? '文件' : '文件夹'
}

/** 构造发送给模型的 state 文本 */
function buildStateText(payload: AutoSearchPayload, node: BeamNode): string {
  const lines: string[] = []
  lines.push(`用户正在查找一个${targetText(payload.target)}，范围是目录“${payload.rootPath}”的整个子树。`)
  if (payload.keyword) {
    lines.push(`名称关键词：“${payload.keyword}”（可能只是名称的一部分，也可能拼写不完全准确）。`)
  }
  if (payload.description) {
    lines.push(
      payload.target === 'folder'
        ? `这个文件夹大概是装什么的/干什么用的：“${payload.description}”（用户要找的往往正是装着这类东西的那个文件夹）。`
        : `这个目标大概是干啥的：“${payload.description}”。`
    )
  }
  lines.push(
    '注意：目标的名称与路径可能是拼音或英文（例如“原神”可能对应 Genshin Impact 或 yuanshen），判断时优先考虑内容与用途的匹配，不要只看名称字面相似。'
  )
  if (node.trail.length > 0) {
    lines.push(`已经逐层下钻经过：${[...node.trail, node.dirPath].join(' > ')}。`)
  } else {
    lines.push(`当前正在查看的目录：“${node.dirPath}”（搜索起点）。`)
  }
  return lines.join('\n')
}

/** 名称关键词本地预筛：子串匹配（不区分大小写）；无命中时返回空数组 */
function prefilter(children: FsNode[], keyword: string): FsNode[] {
  const kw = keyword.toLowerCase()
  return children.filter((c) => c.name.toLowerCase().includes(kw))
}

/**
 * 采样子文件夹的前几个子项名，作为「这个文件夹大概是干啥的」的特征喂给模型。
 * 读取失败的文件夹只用名称参与判断。
 */
async function sampleFolderChildren(folders: FsNode[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  await Promise.all(
    folders.map(async (folder) => {
      try {
        const children = await listEntries(folder.path)
        const names = children.slice(0, SAMPLE_CHILD_LIMIT).map((c) => c.name)
        if (names.length > 0) {
          map.set(folder.path, names.join('、') + (children.length > names.length ? '…' : ''))
        }
      } catch {
        /* 读不了就只用名称 */
      }
    })
  )
  return map
}

function describeChild(child: FsNode, samples: Map<string, string>): string {
  if (!child.isDirectory) {
    return `文件 “${child.name}”`
  }
  const sample = samples.get(child.path)
  return sample ? `文件夹 “${child.name}”（内含：${sample}）` : `文件夹 “${child.name}”`
}

/**
 * 深度折损：pathFactor 是沿途 container 概率连乘，越深数值天然越小；
 * 直接连乘会把深埋的目标压出 Top10（深度偏置）。
 * 这里按深度取几何平均做折损：第 0 层不折损，越深折损越温和——
 * 保留"路线越不确定越打折"的直觉，但不惩罚深度本身。
 */
function depthDiscount(node: BeamNode): number {
  return Math.pow(node.pathFactor, 1 / Math.max(1, node.depth))
}

/** 评估一个目录节点：一次调用并行问 pick（可分批）+ container + target_here */
async function evaluateNode(
  node: BeamNode,
  payload: AutoSearchPayload,
  apiKey: string
): Promise<NodeEval> {
  const notes: string[] = []
  const entries = await listEntries(node.dirPath)
  const subfolders = entries.filter((e) => e.isDirectory)
  const files = entries.filter((e) => !e.isDirectory)

  // pick 候选：与目标类型匹配的直接子项
  let pickPool: FsNode[]
  if (payload.target === 'folder') {
    pickPool = subfolders
  } else if (payload.target === 'file') {
    pickPool = files
  } else {
    pickPool = entries
  }

  if (pickPool.length > MAX_PER_BATCH * MAX_BATCHES) {
    let shrunk = pickPool
    if (payload.keyword) {
      const hits = prefilter(pickPool, payload.keyword)
      if (hits.length > 0) shrunk = hits
    }
    if (shrunk.length > MAX_PER_BATCH * MAX_BATCHES) {
      notes.push(`目录“${node.dirPath}”候选过多，已截断至前 ${MAX_PER_BATCH * MAX_BATCHES} 个。`)
      shrunk = shrunk.slice(0, MAX_PER_BATCH * MAX_BATCHES)
    } else {
      notes.push(`目录“${node.dirPath}”候选过多，已按名称关键词预筛至 ${shrunk.length} 个。`)
    }
    pickPool = shrunk
  }

  const canExpand = node.depth < MAX_DEPTH && subfolders.length > 0
  if (pickPool.length === 0 && !canExpand) {
    return { node, hits: [], expansions: [], notes }
  }

  // 文件夹特征采样（pick 与 container 两类问题共用）
  const samples = await sampleFolderChildren(subfolders)

  // ---- 构造 questions ----
  const questions: Record<string, unknown> = {}
  const pickBatches: { key: string; keyToChild: Map<string, FsNode> }[] = []
  const batchCount = Math.max(1, Math.ceil(pickPool.length / MAX_PER_BATCH))
  for (let i = 0; i < batchCount; i++) {
    const chunk = pickPool.slice(i * MAX_PER_BATCH, (i + 1) * MAX_PER_BATCH)
    if (chunk.length === 0) continue
    const keyToChild = new Map<string, FsNode>()
    const criteria: Record<string, string> = {}
    for (const child of chunk) {
      const key = child.name === UNCERTAIN_KEY ? `item_${child.name}` : child.name
      criteria[key] = describeChild(child, samples)
      keyToChild.set(key, child)
    }
    criteria[UNCERTAIN_KEY] = '不确定：与这一批都不匹配，或目标不是本目录的直接子项'
    const key = `pick_${i}`
    pickBatches.push({ key, keyToChild })
    questions[key] = {
      type: 'choice',
      instructions:
        batchCount > 1
          ? `用户要找的${targetText(payload.target)}，最可能是以下哪个直接子项？判断依据是名称、内含内容与用途描述的匹配度，而不是名称字面相似。（候选较多，此为第 ${i + 1}/${batchCount} 批；都不匹配请选 uncertain）`
          : `用户要找的${targetText(payload.target)}，最可能是以下哪个直接子项？判断依据是名称、内含内容与用途描述的匹配度，而不是名称字面相似。无法确定或都不匹配请选 uncertain。`,
      criteria
    }
  }

  let containerKeyToChild: Map<string, FsNode> | null = null
  if (canExpand) {
    containerKeyToChild = new Map<string, FsNode>()
    const criteria: Record<string, string> = {}
    for (const folder of subfolders) {
      const key = folder.name === UNCERTAIN_KEY ? `item_${folder.name}` : folder.name
      criteria[key] = describeChild(folder, samples)
      containerKeyToChild.set(key, folder)
    }
    criteria[UNCERTAIN_KEY] = '不确定：目标不在这些子文件夹的更深层里'
    questions['container'] = {
      type: 'choice',
      instructions: `如果用户要找的${targetText(payload.target)}不是本目录的直接子项，它最可能位于哪个子文件夹的更深层？判断依据是子文件夹的内容与用途，而不是名称字面相似。都不像请选 uncertain。`,
      criteria
    }
  }

  questions['target_here'] = {
    type: 'noul',
    instructions: `综合考虑名称关键词与用途描述，用户要找的${targetText(payload.target)}是否可能就是目录“${node.dirPath}”的直接子项之一？`
  }

  const data = await systemOneRequest(
    {
      state: buildStateText(payload, node),
      model: MODEL,
      questions
    },
    apiKey
  )

  // ---- 合并结果 ----
  const hits: AutoSearchHit[] = []
  const hereAnswer = data.answers?.['target_here']
  const targetHere = typeof hereAnswer?.noul === 'number' ? hereAnswer.noul : null
  for (const batch of pickBatches) {
    const answer: ChoiceAnswer | undefined = data.answers?.[batch.key]
    if (!answer || answer.type !== 'choice') continue
    for (const [optionKey, probability] of Object.entries(answer.probabilities ?? {})) {
      if (optionKey === UNCERTAIN_KEY) continue
      const child = batch.keyToChild.get(optionKey)
      if (!child) continue
      hits.push({
        name: child.name,
        path: child.path,
        kind: child.isDirectory ? 'folder' : 'file',
        probability,
        score: probability * depthDiscount(node),
        confidence: answer.confidence ?? 0,
        targetHere,
        depth: node.depth,
        parentPath: node.dirPath
      })
    }
  }

  const expansions: BeamNode[] = []
  if (canExpand && containerKeyToChild) {
    const answer = data.answers?.['container']
    if (answer && answer.type === 'choice' && answer.probabilities) {
      const scored: { folder: FsNode; probability: number }[] = []
      for (const [optionKey, probability] of Object.entries(answer.probabilities)) {
        if (optionKey === UNCERTAIN_KEY) continue
        const folder = containerKeyToChild.get(optionKey)
        if (folder && probability >= EXPAND_PROB_THRESHOLD) {
          scored.push({ folder, probability })
        }
      }
      scored.sort((a, b) => b.probability - a.probability)
      // 全部进全局优先队列（不做 Top-N 截断）：排名靠后的分支只要预算够就有机会被探索
      for (const { folder, probability } of scored) {
        expansions.push({
          dirPath: folder.path,
          trail: [...node.trail, node.dirPath],
          depth: node.depth + 1,
          pathFactor: node.pathFactor * probability
        })
      }
    }
  }
  if (batchCount > 1) {
    notes.push(`目录“${node.dirPath}”候选分 ${batchCount} 批评估，跨批次概率仅供参考。`)
  }

  return { node, hits, expansions, notes }
}

export async function autoSearch(
  payload: AutoSearchPayload,
  apiKey: string,
  onProgress?: (progress: AutoSearchProgress) => void
): Promise<AutoSearchResult> {
  if (!apiKey.trim()) {
    throw new NoApiKeyError()
  }
  const keyword = payload.keyword.trim()
  const description = payload.description.trim()
  if (!keyword && !description) {
    throw new FsOpError('EMPTY_QUERY', '请至少填写名称关键词或用途描述之一')
  }

  const startedAt = Date.now()
  const allHits: AutoSearchHit[] = []
  const notes: string[] = []
  let callsUsed = 0
  let nodesVisited = 0

  // 全局优先队列（best-first）：任何有希望的分支都会排队等待，
  // 不会像固定 beam 那样在浅层被挤掉就永久丢失
  const pending: BeamNode[] = [
    { dirPath: payload.rootPath, trail: [], depth: 0, pathFactor: 1 }
  ]
  const visited = new Set<string>()

  while (pending.length > 0 && callsUsed < MAX_CALLS) {
    // 每轮取 BEAM_WIDTH 个最有希望的未探索目录并行评估
    const level: BeamNode[] = []
    while (level.length < BEAM_WIDTH && pending.length > 0) {
      const next = pending.shift()
      if (!next || visited.has(next.dirPath)) continue
      visited.add(next.dirPath)
      level.push(next)
    }
    if (level.length === 0) break

    onProgress?.({
      message: `正在评估 ${level.length} 个目录：${level.map((n) => n.dirPath).join('、')}`,
      callsUsed,
      nodesVisited,
      trail: level[0].trail.concat(level[0].dirPath)
    })

    const evals = await Promise.all(
      level.map(async (node): Promise<NodeEval> => {
        try {
          return await evaluateNode(node, payload, apiKey)
        } catch (err) {
          if (err instanceof NoApiKeyError) throw err
          return {
            node,
            hits: [],
            expansions: [],
            notes: [`目录“${node.dirPath}”评估失败：${err instanceof Error ? err.message : String(err)}`]
          }
        }
      })
    )

    for (const evalResult of evals) {
      callsUsed += 1
      nodesVisited += 1
      allHits.push(...evalResult.hits)
      notes.push(...evalResult.notes)
      pending.push(...evalResult.expansions.filter((e) => !visited.has(e.dirPath)))
    }
    // 优先探索 pathFactor（目标落在该子树的概率）高的分支
    pending.sort((a, b) => b.pathFactor - a.pathFactor)

    onProgress?.({
      message: `已评估 ${nodesVisited} 个目录，累计 ${callsUsed} 次 AI 调用，候选命中 ${allHits.length} 个`,
      callsUsed,
      nodesVisited,
      trail: []
    })
  }

  // 预算用尽但队列里还有分支 = 还有希望的目录没来得及探索
  const budgetLimited = pending.length > 0

  // 同一目标可能在父层被 pick、又在本层出现：按 path 去重，保留更高得分
  const bestByPath = new Map<string, AutoSearchHit>()
  for (const hit of allHits) {
    const existing = bestByPath.get(hit.path)
    if (!existing || hit.score > existing.score) {
      bestByPath.set(hit.path, hit)
    }
  }
  const hits = [...bestByPath.values()].sort((a, b) => b.score - a.score).slice(0, 10)

  const uncertain = hits.length === 0 || hits[0].probability < UNCERTAIN_PROB_THRESHOLD
  const summary = [
    `已自动下钻 ${nodesVisited} 个目录、调用 ${callsUsed} 次。`,
    budgetLimited
      ? '已达调用/深度预算，仍有分支未探索——可补充更具体的关键词或缩小搜索起点后重试。'
      : '所有有希望的分支已探索完毕。',
    uncertain && hits.length > 0 ? '模型对结果整体不太确定，建议补充更具体的名称或用途描述。' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return {
    hits,
    uncertain,
    callsUsed,
    nodesVisited,
    budgetLimited,
    elapsedMs: Date.now() - startedAt,
    message: [...notes, summary].join(' ')
  }
}
