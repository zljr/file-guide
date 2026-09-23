<template>
  <div class="panel">
    <div v-if="!currentPath" class="panel-empty">
      <el-empty description="请先在左侧选择一个目录" />
    </div>

    <template v-else>
      <div class="panel-path">
        <el-icon><FolderOpened /></el-icon>
        <span class="path-text" :title="currentPath">{{ currentPath + '‎' }}</span>
      </div>

      <el-radio-group v-model="mode" class="mode-seg">
        <el-radio-button value="file">新建文件</el-radio-button>
        <el-radio-button value="folder">新建文件夹</el-radio-button>
        <el-radio-button value="upload">上传文件</el-radio-button>
      </el-radio-group>

      <div v-if="mode === 'upload'" class="upload-row">
        <el-button :icon="Upload" @click="chooseSource">选择文件…</el-button>
        <span v-if="sourceFile" class="source-name" :title="sourceFile.path">
          {{ sourceFile.name }}（{{ sourceFile.path }}）
        </span>
        <span v-else class="upload-hint">尚未选择文件</span>
      </div>

      <div class="name-row">
        <el-input
          v-model="base"
          :placeholder="isFolderMode ? '文件夹名称' : '文件名（不含后缀）'"
          clearable
          @keydown.enter="getSuggestions"
        />
        <template v-if="mode !== 'folder'">
          <el-radio-group v-model="extMode">
            <el-radio-button value="preset">预设后缀</el-radio-button>
            <el-radio-button value="none">无后缀</el-radio-button>
            <el-radio-button value="custom">自定义</el-radio-button>
          </el-radio-group>
          <el-select v-if="extMode === 'preset'" v-model="presetExt" class="ext-select">
            <el-option v-for="ext in PRESET_EXTENSIONS" :key="ext" :label="ext" :value="ext" />
          </el-select>
          <el-input
            v-if="extMode === 'custom'"
            v-model="customExt"
            class="ext-input"
            placeholder="如 mdx"
            clearable
          />
        </template>
      </div>

      <div class="validate-line">
        <span v-if="validation.valid" class="ok">将创建：{{ validation.finalName }}</span>
        <span v-else class="bad">{{ validation.reason ?? ' ' }}</span>
      </div>

      <div class="join-row">
        <el-button
          type="primary"
          :icon="MagicStick"
          :loading="suggestLoading"
          :disabled="!validation.valid"
          @click="getSuggestions"
        >
          获取建议
        </el-button>
        <el-button
          :icon="Check"
          :loading="commitLoading"
          :disabled="!canCreateHere"
          @click="commit(currentPath)"
        >
          直接在当前目录创建
        </el-button>
      </div>

      <div v-if="suggestions" class="suggestions">
        <div class="sug-head">
          <span class="sug-title">AI 推荐目录</span>
          <span class="confidence">置信度 {{ percent(suggestions.confidence) }}</span>
        </div>

        <el-alert
          v-if="suggestions.message"
          :title="suggestions.message"
          type="info"
          :closable="false"
          class="sug-alert"
        />
        <el-alert
          v-if="suggestions.uncertain || selectedPath === UNCERTAIN"
          type="warning"
          :closable="false"
          class="sug-alert"
          title="不确定——该名称可能不属于这一层目录。请更换左侧目录后重试，或直接在当前目录创建。"
        />
        <el-alert
          v-else-if="suggestions.confidence < LOW_CONFIDENCE"
          type="info"
          :closable="false"
          class="sug-alert"
          :title="`模型置信度较低（${percent(suggestions.confidence)}），推荐结果仅供参考。`"
        />

        <el-radio-group v-model="selectedPath" class="sug-list">
          <el-radio
            v-for="opt in topOptions"
            :key="opt.path"
            :value="opt.path"
            class="sug-item"
            border
          >
            <div class="sug-content">
              <div class="sug-name" :title="opt.path">{{ opt.folder }}</div>
              <el-progress
                class="sug-progress"
                :percentage="pctNum(opt.probability)"
                :stroke-width="8"
              />
            </div>
          </el-radio>

          <el-radio :value="UNCERTAIN" class="sug-item sug-uncertain" border>
            <div class="sug-content">
              <div class="sug-name">不确定（可能不属于这一层目录）</div>
              <el-progress
                class="sug-progress"
                :percentage="pctNum(suggestions.uncertainProbability)"
                :stroke-width="8"
              />
            </div>
          </el-radio>
        </el-radio-group>

        <div class="join-row">
          <el-button
            type="primary"
            :icon="CircleCheck"
            :loading="commitLoading"
            :disabled="!canJoin"
            @click="commit(selectedPath)"
          >
            加入（创建到选中的文件夹）
          </el-button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, CircleCheck, MagicStick, Upload } from '@element-plus/icons-vue'
import { PRESET_EXTENSIONS } from '@shared/types'
import type { ExtMode, SuggestResult } from '@shared/types'
import {
  checkCustomExtension,
  inferExtModeFromSource,
  validateFileName,
  validateFolderName
} from '@shared/validate'

type Mode = 'file' | 'folder' | 'upload'

const props = defineProps<{ currentPath: string | null }>()
const emit = defineEmits<{ committed: []; 'need-settings': [] }>()

const LOW_CONFIDENCE = 0.4
/** 推荐目录最多展示 5 个（请求仍会带上全部子文件夹 + uncertain 选项） */
const MAX_SHOW = 5
/** 推荐列表中 "uncertain（不确定）" 行的哨兵值：选中它时不能执行加入 */
const UNCERTAIN = '__uncertain__'

const mode = ref<Mode>('file')
const base = ref('')
const extMode = ref<ExtMode>('preset')
const presetExt = ref('.txt')
const customExt = ref('')
const sourceFile = ref<{ path: string; name: string } | null>(null)

const suggestions = ref<SuggestResult | null>(null)
const selectedPath = ref<string | null>(null)
const suggestLoading = ref(false)
const commitLoading = ref(false)

const isFolderMode = computed(() => mode.value === 'folder')

const validation = computed(() =>
  isFolderMode.value
    ? validateFolderName(base.value)
    : validateFileName(base.value, extMode.value, presetExt.value, customExt.value)
)

/** 校验通过后的最终后缀（自定义时做规范化） */
const finalExt = computed(() => {
  if (isFolderMode.value || extMode.value === 'none') return ''
  if (extMode.value === 'preset') return presetExt.value
  return checkCustomExtension(customExt.value).ext
})

const topOptions = computed(() => suggestions.value?.options.slice(0, MAX_SHOW) ?? [])

const hasSource = computed(() => mode.value !== 'upload' || sourceFile.value !== null)

const canCreateHere = computed(() => validation.value.valid && hasSource.value)
const canJoin = computed(
  () =>
    validation.value.valid &&
    hasSource.value &&
    selectedPath.value !== null &&
    selectedPath.value !== UNCERTAIN
)

// 切换目录或模式后，旧建议不再适用
watch(
  () => props.currentPath,
  () => {
    suggestions.value = null
    selectedPath.value = null
  }
)
watch(mode, () => {
  suggestions.value = null
  selectedPath.value = null
})

/** 概率显示：保留一位小数，避免小概率被舍入成 0% */
function percent(value: number): string {
  const fixed = (value * 100).toFixed(1)
  return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed}%`
}

/** el-progress 用的数值形式（一位小数精度） */
function pctNum(value: number): number {
  return Math.round(value * 1000) / 10
}

async function chooseSource(): Promise<void> {
  const res = await window.api.pickSourceFile()
  if (!res.ok) {
    ElMessage.error(res.message)
    return
  }
  if (!res.data) return
  sourceFile.value = res.data
  const inferred = inferExtModeFromSource(res.data.name)
  base.value = inferred.base
  extMode.value = inferred.extMode
  presetExt.value = inferred.presetExt || '.txt'
  customExt.value = inferred.customExt
}

async function getSuggestions(): Promise<void> {
  if (!props.currentPath || !validation.value.valid) return
  suggestLoading.value = true
  try {
    const res = await window.api.suggest({
      dirPath: props.currentPath,
      kind: isFolderMode.value ? 'folder' : 'file',
      base: validation.value.base,
      ext: isFolderMode.value ? '' : finalExt.value,
      sourceName: sourceFile.value?.name
    })
    if (!res.ok) {
      if (res.code === 'NO_API_KEY') {
        ElMessage.warning(res.message)
        emit('need-settings')
      } else {
        ElMessage.error(res.message)
      }
      return
    }
    suggestions.value = res.data
    selectedPath.value = res.data.uncertain ? UNCERTAIN : res.data.best
  } finally {
    suggestLoading.value = false
  }
}

async function commit(target: string | null): Promise<void> {
  if (!target || target === UNCERTAIN || !validation.value.valid || !hasSource.value) return
  commitLoading.value = true
  try {
    const res = await window.api.commit({
      mode: mode.value,
      targetDir: target,
      base: validation.value.base,
      extMode: isFolderMode.value ? 'none' : extMode.value,
      presetExt: presetExt.value,
      customExt: customExt.value,
      sourcePath: sourceFile.value?.path
    })
    if (!res.ok) {
      ElMessage.error(res.message)
      return
    }
    ElMessage.success(`创建成功：${res.data.path}`)
    suggestions.value = null
    selectedPath.value = null
    base.value = ''
    sourceFile.value = null
    emit('committed')
  } finally {
    commitLoading.value = false
  }
}
</script>
