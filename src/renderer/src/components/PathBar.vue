<template>
  <div class="panel-path">
    <el-icon><slot name="icon"><FolderOpened /></slot></el-icon>
    <template v-if="editing">
      <el-input
        ref="inputRef"
        v-model="draft"
        class="path-input"
        size="small"
        placeholder="输入目录路径后回车，如 D:\分盘软件"
        clearable
        @keydown.enter="confirmEdit"
        @keydown.esc="cancelEdit"
      />
      <el-button
        size="small"
        type="primary"
        :icon="Check"
        :loading="checking"
        @click="confirmEdit"
      >
        确定
      </el-button>
      <el-button class="path-btn" size="small" text @click="cancelEdit">取消</el-button>
    </template>
    <template v-else>
      <span class="path-text" :title="path ?? ''">{{ (path ?? '') + '‎' }}</span>
      <el-button class="path-btn" size="small" text :icon="Edit" @click="startEdit">
        编辑
      </el-button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, Edit, FolderOpened } from '@element-plus/icons-vue'

const props = defineProps<{ path: string | null }>()
const emit = defineEmits<{ navigate: [path: string] }>()

const editing = ref(false)
const checking = ref(false)
const draft = ref('')
const inputRef = ref<{ focus: () => void } | null>(null)

function startEdit(): void {
  draft.value = props.path ?? ''
  editing.value = true
  void nextTick(() => inputRef.value?.focus())
}

function cancelEdit(): void {
  editing.value = false
}

/** 确认跳转：主进程校验路径存在且是文件夹，成功后通知父组件 */
async function confirmEdit(): Promise<void> {
  if (checking.value) return
  checking.value = true
  try {
    const res = await window.api.resolveDir(draft.value)
    if (!res.ok) {
      ElMessage.error(res.message)
      return
    }
    editing.value = false
    emit('navigate', res.data.path)
  } catch (err) {
    // 兜底：例如 preload 未重启导致 window.api.resolveDir 不可用等，都会显式提示
    ElMessage.error(`跳转失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    checking.value = false
  }
}
</script>
