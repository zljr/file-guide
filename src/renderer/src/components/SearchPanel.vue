<template>
  <div class="panel">
    <div v-if="!currentPath" class="panel-empty">
      <el-empty description="请先在左侧选择一个目录作为搜索起点" />
    </div>

    <template v-else>
      <div class="panel-path">
        <el-icon><Search /></el-icon>
        <span class="path-text" :title="dir ?? ''">{{ (dir ?? '') + '‎' }}</span>
      </div>

      <div class="search-inputs">
        <el-input
          v-model="keyword"
          class="search-keyword"
          placeholder="名称关键词（可不填，支持部分名称）"
          clearable
          @keydown.enter="startSearch"
        >
          <template #prepend>名称</template>
        </el-input>
        <el-input
          v-model="description"
          type="textarea"
          :rows="2"
          class="search-desc"
          placeholder="特征描述（可不填）：例如「放爬虫脚本的文件夹」「上学期交的实验报告」"
          @keydown.enter="startSearch"
        />
        <div class="search-actions">
          <el-radio-group v-model="mode" size="small">
            <el-radio-button value="folder">找文件夹</el-radio-button>
            <el-radio-button value="file">找文件</el-radio-button>
          </el-radio-group>
          <el-button
            type="primary"
            :icon="Search"
            :loading="loading"
            :disabled="!canSearch"
            @click="startSearch"
          >
            {{ result ? '重新查找' : '开始查找' }}
          </el-button>
          <el-button :icon="Back" :disabled="trail.length === 0" @click="goUp">回上一层</el-button>
        </div>
        <div v-if="trail.length > 0" class="search-trail">
          <el-icon><Location /></el-icon>
          <span class="trail-text" :title="trail.join(' > ')">下钻路径：{{ trail.join(' > ') }}</span>
        </div>
      </div>

      <div v-if="result" class="suggestions">
        <div class="sug-head">
          <span class="sug-title">AI 搜索结果（{{ mode === 'folder' ? '文件夹' : '文件' }}）</span>
          <span class="confidence">
            置信度 {{ percent(result.confidence) }}
            <template v-if="result.targetHere !== null">
              · 在这层可能性 {{ percent(result.targetHere) }}
            </template>
          </span>
        </div>

        <el-alert
          v-if="result.message"
          :title="result.message"
          type="info"
          :closable="false"
          class="sug-alert"
        />
        <el-alert
          v-if="result.targetHere !== null && result.targetHere < 0.5 && result.options.length > 0"
          type="warning"
          :closable="false"
          class="sug-alert"
          title="模型认为目标大概率不在这一层——建议回上一层，换一条分支继续。"
        />
        <el-alert
          v-if="result.uncertain || result.options.length === 0"
          type="warning"
          :closable="false"
          class="sug-alert"
          title="模型不确定目标在这一层的哪个子项中——请修改关键词或描述，或回上一层换条分支。"
        />

        <el-radio-group v-if="result.options.length" v-model="selected" class="sug-list">
          <el-radio
            v-for="opt in topOptions"
            :key="opt.path"
            :value="opt.path"
            class="sug-item"
            border
          >
            <div class="sug-content">
              <div class="sug-name" :title="opt.path">{{ opt.name }}</div>
              <el-progress
                class="sug-progress"
                :percentage="pctNum(opt.probability)"
                :stroke-width="8"
              />
            </div>
          </el-radio>

          <el-radio :value="UNCERTAIN" class="sug-item sug-uncertain" border>
            <div class="sug-content">
              <div class="sug-name">不确定（可能不在这一层）</div>
              <el-progress
                class="sug-progress"
                :percentage="pctNum(result.uncertainProbability)"
                :stroke-width="8"
              />
            </div>
          </el-radio>
        </el-radio-group>

        <div class="join-row">
          <el-button
            v-if="mode === 'folder'"
            type="primary"
            :icon="Right"
            :loading="loading"
            :disabled="!canEnter"
            @click="enterSelected"
          >
            进入选中的文件夹（继续找）
          </el-button>
          <el-button
            type="primary"
            :icon="FolderOpened"
            :loading="revealLoading"
            :disabled="!canReveal"
            @click="revealSelected"
          >
            在资源管理器中显示
          </el-button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Back, FolderOpened, Location, Right, Search } from '@element-plus/icons-vue'
import type { SearchMode, SearchStepResult } from '@shared/types'

const props = defineProps<{ currentPath: string | null }>()

/** "uncertain" 行的哨兵值：选中它时不能进入/显示 */
const UNCERTAIN = '__uncertain__'

const dir = ref<string | null>(null)
const trail = ref<string[]>([])
const mode = ref<SearchMode>('folder')
const keyword = ref('')
const description = ref('')

const result = ref<SearchStepResult | null>(null)
const selected = ref<string | null>(null)
const loading = ref(false)
const revealLoading = ref(false)
/** 请求序号：丢弃过期响应 */
let searchSeq = 0

const canSearch = computed(() => (keyword.value.trim() || description.value.trim()) !== '')
const topOptions = computed(() => result.value?.options.slice(0, 5) ?? [])
const canEnter = computed(
  () =>
    mode.value === 'folder' &&
    selected.value !== null &&
    selected.value !== UNCERTAIN
)
const canReveal = computed(() => selected.value !== null && selected.value !== UNCERTAIN)

/**
 * 左侧树点击文件夹：仅切换搜索目标目录（不发起任何请求，避免浏览目录浪费 token）。
 * 重置下钻路径与旧结果；查找只由用户点击「开始查找」按钮触发。
 */
watch(
  () => props.currentPath,
  (value) => {
    if (!value) return
    dir.value = value
    trail.value = []
    clearResult()
  },
  { immediate: true }
)

function percent(value: number): string {
  const fixed = (value * 100).toFixed(1)
  return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed}%`
}

function pctNum(value: number): number {
  return Math.round(value * 1000) / 10
}

function clearResult(): void {
  result.value = null
  selected.value = null
}

async function startSearch(): Promise<void> {
  if (!dir.value || !canSearch.value) return
  // 快速连点不同文件夹时，只应用最后一次请求的结果
  const seq = ++searchSeq
  loading.value = true
  try {
    const res = await window.api.searchStep({
      dirPath: dir.value,
      mode: mode.value,
      keyword: keyword.value.trim(),
      description: description.value.trim(),
      // 注意：必须传普通数组。trail.value 是 Vue 响应式 Proxy，无法结构化克隆过 IPC
      trail: [...trail.value]
    })
    if (seq !== searchSeq) return
    if (!res.ok) {
      if (res.code === 'NO_API_KEY') {
        ElMessage.warning(res.message)
      } else {
        ElMessage.error(res.message)
      }
      return
    }
    result.value = res.data
    selected.value = res.data.uncertain ? UNCERTAIN : res.data.best
  } catch (err) {
    if (seq === searchSeq) {
      ElMessage.error(`查找失败：${err instanceof Error ? err.message : String(err)}`)
    }
  } finally {
    if (seq === searchSeq) {
      loading.value = false
    }
  }
}

/** 进入选中的子文件夹，自动继续下一层搜索 */
async function enterSelected(): Promise<void> {
  if (!selected.value || selected.value === UNCERTAIN || !dir.value) return
  trail.value = [...trail.value, dir.value]
  dir.value = selected.value
  clearResult()
  await startSearch()
}

/** 回上一层，自动重搜 */
async function goUp(): Promise<void> {
  if (trail.value.length === 0) return
  const previous = trail.value[trail.value.length - 1]
  trail.value = trail.value.slice(0, -1)
  dir.value = previous
  clearResult()
  await startSearch()
}

async function revealSelected(): Promise<void> {
  if (!selected.value || selected.value === UNCERTAIN) return
  revealLoading.value = true
  try {
    const res = await window.api.reveal(selected.value)
    if (!res.ok) {
      ElMessage.error(res.message)
    }
  } finally {
    revealLoading.value = false
  }
}
</script>
