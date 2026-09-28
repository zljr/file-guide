/** 双端共享的类型定义 */

export type EntryKind = 'file' | 'folder'

/** 提交创建时的模式：直接建文件 / 建文件夹 / 复制上传的文件进来 */
export type CommitMode = 'file' | 'folder' | 'upload'

export interface DriveInfo {
  /** 盘符字母，如 "C" */
  letter: string
  /** 根路径，如 "C:\\" */
  root: string
}

export interface FsNode {
  name: string
  path: string
  isDirectory: boolean
}

/** 文件后缀模式：预设 / 无后缀 / 自定义 */
export type ExtMode = 'preset' | 'none' | 'custom'

/** 预设文件后缀（新建文件时可直接选用） */
export const PRESET_EXTENSIONS = [
  '.txt',
  '.md',
  '.docx',
  '.xlsx',
  '.pptx',
  '.pdf',
  '.csv',
  '.json',
  '.xml',
  '.yml',
  '.js',
  '.ts',
  '.vue',
  '.html',
  '.css',
  '.py',
  '.java',
  '.zip',
  '.png',
  '.jpg'
] as const

export interface SuggestPayload {
  /** 用户在左侧选中的目录 */
  dirPath: string
  /** 将创建的条目类型 */
  kind: EntryKind
  /** 文件/文件夹基本名（不含后缀） */
  base: string
  /** 文件后缀（含前导点，kind === 'folder' 时为空串） */
  ext?: string
  /** 上传文件的原始文件名（作为给模型的提示） */
  sourceName?: string
}

export interface SuggestOption {
  /** 子文件夹名 */
  folder: string
  /** 完整路径 */
  path: string
  /** 该选项的概率 0–1 */
  probability: number
}

export interface SuggestResult {
  /** 按概率降序排列的候选子文件夹（界面只展示前 5 个） */
  options: SuggestOption[]
  /** 模型选中的文件夹路径；选择 uncertain 时为 null */
  best: string | null
  /** 对所选答案的置信度 0–1 */
  confidence: number
  /** 模型是否选择了 uncertain（不确定 / 都不相关） */
  uncertain: boolean
  /** uncertain 选项获得的概率（与 options 中各概率合计为 1） */
  uncertainProbability: number
  /** 附加提示信息（如子文件夹过多被截断、目录为空等） */
  message?: string
}

/** 创建文件/文件夹/复制上传文件的返回 */
export interface CreateResult {
  /** 创建出的完整路径 */
  path: string
}

export interface CommitPayload {
  mode: CommitMode
  /** 创建目标：推荐文件夹路径或当前目录 */
  targetDir: string
  /** 基本名（不含后缀） */
  base: string
  /** 后缀模式（文件夹模式忽略） */
  extMode: ExtMode
  /** extMode === 'preset' 时的预设后缀 */
  presetExt?: string
  /** extMode === 'custom' 时的自定义后缀输入 */
  customExt?: string
  /** mode === 'upload' 时的源文件绝对路径 */
  sourcePath?: string
}

/** 统一 IPC 返回结构 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string }

export interface ConfigInfo {
  hasApiKey: boolean
  /** 掩码显示，如 "sk-****abcd" */
  apiKeyMasked: string
}

/* ===== 查找功能 ===== */

/** 查找模式：folder = 逐层找文件夹；file = 在某一层找文件 */
export type SearchMode = 'folder' | 'file'

export interface SearchPayload {
  dirPath: string
  mode: SearchMode
  /** 名称关键词（本地预筛 + 给模型的提示），可为空串 */
  keyword: string
  /** 自然语言描述，可为空串；与 keyword 至少填一个 */
  description: string
  /** 已下钻经过的目录名轨迹（不含当前目录），给模型上下文 */
  trail: string[]
}

export interface SearchOption {
  name: string
  path: string
  probability: number
}

export interface SearchStepResult {
  /** 按概率降序的候选（文件夹或文件） */
  options: SearchOption[]
  best: string | null
  confidence: number
  uncertain: boolean
  uncertainProbability: number
  /** Noul：目标可能就在当前层直接子项中的程度（0-1） */
  targetHere: number | null
  /** 本层子项总数 */
  totalChildren: number
  /** 实际发送给模型的候选数 */
  sentChildren: number
  /** 分批数（超过 250 时 >1） */
  batchCount: number
  /** 是否被关键词本地预筛过 */
  filteredByKeyword: boolean
  message?: string
}

/* ===== 一键查找（全自动 AI 下钻，无需人工逐步参与） ===== */

/** 一键查找的目标类型：both = 文件与文件夹混合排序 */
export type AutoSearchTarget = 'both' | 'file' | 'folder'

export interface AutoSearchPayload {
  /** 检索范围：左侧选中目录的整个子树 */
  rootPath: string
  /** 目标类型：文件 / 文件夹 / 混合 */
  target: AutoSearchTarget
  /** 名称关键词（可为空串） */
  keyword: string
  /** 自然语言描述「大概是干啥的」（可为空串）；与 keyword 至少填一个 */
  description: string
}

export interface AutoSearchHit {
  name: string
  path: string
  kind: EntryKind
  /** 该层 Choice 给出的层内概率 0–1（目标是该层这个直接子项） */
  probability: number
  /** 全局可比得分：层内概率 × 沿途下钻概率（跨层排序依据） */
  score: number
  /** 命中所在层 Choice 的置信度 0–1 */
  confidence: number
  /** 命中所在层 Noul：目标就在这层直接子项中的程度；未返回时为 null */
  targetHere: number | null
  /** 命中时的深度（搜索起点为 0） */
  depth: number
  /** 命中时所在目录的完整路径 */
  parentPath: string
}

/** 查找过程中的进度回报（IPC 事件 search:autoProgress） */
export interface AutoSearchProgress {
  /** 当前阶段的中文描述 */
  message: string
  /** 已使用的 API 调用次数 */
  callsUsed: number
  /** 已评估过的目录数 */
  nodesVisited: number
  /** 正在下钻的目录轨迹（名称） */
  trail: string[]
}

export interface AutoSearchResult {
  /** 全局 Top10（按 score 降序） */
  hits: AutoSearchHit[]
  /** 模型整体不确定（无命中或最强命中概率过低） */
  uncertain: boolean
  /** 实际使用的 API 调用次数 */
  callsUsed: number
  /** 实际评估过的目录数 */
  nodesVisited: number
  /** 是否因调用/深度预算提前停止（仍有分支未探索） */
  budgetLimited: boolean
  /** 耗时（毫秒） */
  elapsedMs: number
  message?: string
}
