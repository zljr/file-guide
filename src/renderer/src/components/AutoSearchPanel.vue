<template>
  <div class="auto-panel">
    <div class="search-inputs">
      <el-input
        v-model="keyword"
        placeholder="名称关键词（可不填，支持部分名称）"
        clearable
        :disabled="loading"
        @keydown.enter="startSearch"
      >
        <template #prepend>名称</template>
      </el-input>
      <el-input
        v-model="description"
        type="textarea"
        :rows="2"
        placeholder="大概是干啥的（可不填）：例如「放爬虫脚本的文件夹」「上学期交的实验报告」"
        :disabled="loading"
        @keydown.enter="startSearch"
      />
      <div class="search-actions">
        <el-radio-group v-model="target" size="small" :disabled="loading">
          <el-radio-button value="both">混合</el-radio-button>
          <el-radio-button value="file">找文件</el-radio-button>
          <el-radio-button value="folder">找文件夹</el-radio-button>
        </el-radio-group>
        <el-button
          type="primary"
          :icon="Search"
          :loading="loading"
          :disabled="!canSearch"
          @click="startSearch"
        >
          {{ result ? '重新查找' : '一键查找' }}
        </el-button>
      </div>
      <div v-if="loading" class="auto-progress">
        <el-icon class="is-loading"><Loading /></el-icon>
        <span class="trail-text" :title="progress?.message">
          {{ progress?.message ?? '准备中…' }}
        </span>
      </div>
    </div>

    <div v-if="result" class="suggestions">
      <div class="sug-head">
        <span class="sug-title">AI 一键查找结果（Top {{ result.hits.length }}）</span>
        <span class="confidence">
          用时 {{ (result.elapsedMs / 1000).toFixed(1) }} 秒 · {{ result.callsUsed }} 次 AI 调用 ·
          {{ result.nodesVisited }} 个目录
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
        v-if="result.uncertain"
        type="warning"
        :closable="false"
        class="sug-alert"
        title="模型对结果整体不太确定——建议补充更具体的名称或用途描述，或换一个搜索起点重试。"
      />

      <div v-if="result.hits.length" class="hit-list">
        <div v-for="(hit, index) in result.hits" :key="hit.path" class="hit-item">
          <div class="hit-rank">{{ index + 1 }}</div>
          <el-icon class="hit-icon" :size="18" :style="{ color: iconOf(hit).color }">
            <component :is="iconOf(hit).icon" />
          </el-icon>
          <div class="hit-main">
            <div class="hit-name-row">
              <span class="sug-name" :title="hit.path">{{ hit.name }}</span>
              <el-tag size="small" :type="hit.kind === 'folder' ? 'warning' : 'info'" effect="plain">
                {{ hit.kind === 'folder' ? '文件夹' : '文件' }}
              </el-tag>
              <span class="hit-depth">第 {{ hit.depth }} 层</span>
            </div>
            <div class="hit-path" :title="hit.path">{{ hit.path }}</div>
            <el-progress
              class="sug-progress"
              :percentage="pctNum(hit.probability)"
              :stroke-width="8"
            />
            <div class="hit-meta">
              层内概率 {{ percent(hit.probability) }} · 路径得分 {{ hit.score.toFixed(3) }}
              <template v-if="hit.targetHere !== null"> · 在这层可能性 {{ percent(hit.targetHere) }}</template>
            </div>
          </div>
          <el-button
            class="hit-reveal"
            :icon="FolderOpened"
            size="small"
            :loading="revealing === hit.path"
            @click="revealHit(hit)"
          >
            显示
          </el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { FolderOpened, Loading, Search } from '@element-plus/icons-vue'
import type {
  AutoSearchHit,
  AutoSearchProgress,
  AutoSearchResult,
  AutoSearchTarget
} from '@shared/types'
import { fileIconMeta, Folder, type IconMeta } from '../utils/fileIcons'

const props = defineProps<{ currentPath: string | null }>()

const keyword = ref('')
const description = ref('')
const target = ref<AutoSearchTarget>('both')
const loading = ref(false)
const progress = ref<AutoSearchProgress | null>(null)
const result = ref<AutoSearchResult | null>(null)
const revealing = ref<string | null>(null)
/** 请求序号：丢弃过期响应 */
let searchSeq = 0

const canSearch = computed(() => (keyword.value.trim() || description.value.trim()) !== '')

function percent(value: number): string {
  const fixed = (value * 100).toFixed(1)
  return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed}%`
}

function pctNum(value: number): number {
  return Math.round(value * 1000) / 10
}

function iconOf(hit: AutoSearchHit): IconMeta {
  return hit.kind === 'folder' ? { icon: Folder, color: '#e6a23c' } : fileIconMeta(hit.name)
}

/** 一键查找：全程自动下钻，通过进度回调展示当前在看哪个目录 */
async function startSearch(): Promise<void> {
  const root = props.currentPath
  if (!root || !canSearch.value) return
  const seq = ++searchSeq
  loading.value = true
  progress.value = null
  try {
    const res = await window.api.autoSearch(
      {
        rootPath: root,
        target: target.value,
        keyword: keyword.value.trim(),
        description: description.value.trim()
      },
      (p) => {
        if (seq === searchSeq) {
          progress.value = p
        }
      }
    )
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

async function revealHit(hit: AutoSearchHit): Promise<void> {
  revealing.value = hit.path
  try {
    const res = await window.api.reveal(hit.path)
    if (!res.ok) {
      ElMessage.error(res.message)
    }
  } finally {
    revealing.value = null
  }
}
</script>

<style scoped>
.auto-panel {
  display: flex;
  flex-direction: column;
}

.auto-progress {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #409eff;
}

.hit-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hit-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  background: #fff;
}

.hit-rank {
  flex: none;
  width: 22px;
  height: 22px;
  margin-top: 2px;
  border-radius: 50%;
  background: #409eff;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.hit-icon {
  flex: none;
  margin-top: 3px;
}

.hit-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.hit-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.hit-depth {
  font-size: 12px;
  color: #909399;
}

.hit-path {
  font-size: 12px;
  color: #909399;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.hit-meta {
  font-size: 11px;
  color: #909399;
}

.hit-reveal {
  flex: none;
  margin-top: 2px;
}
</style>
