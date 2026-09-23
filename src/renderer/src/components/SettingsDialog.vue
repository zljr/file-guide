<template>
  <el-dialog v-model="visible" title="设置 TypeSafe API Key" width="480px">
    <p class="dlg-hint">
      API Key 保存在本机用户数据目录的 config.json 中，仅由主进程用于向 TypeSafe
      发起请求。可在 console.typesafe.ai/keys 获取。
    </p>
    <p v-if="currentMasked" class="dlg-status">当前状态：已设置（{{ currentMasked }}）</p>
    <p v-else class="dlg-status unset">当前状态：未设置</p>
    <el-input
      v-model="input"
      placeholder="粘贴你的 TypeSafe API Key"
      show-password
      clearable
      @keydown.enter="save"
    />
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

const visible = defineModel<boolean>({ required: true })

const input = ref('')
const currentMasked = ref('')
const saving = ref(false)

watch(visible, async (open) => {
  if (!open) return
  input.value = ''
  const res = await window.api.getConfig()
  currentMasked.value = res.ok ? res.data.apiKeyMasked : ''
})

async function save(): Promise<void> {
  if (!input.value.trim()) {
    ElMessage.warning('请输入 API Key')
    return
  }
  saving.value = true
  try {
    const res = await window.api.setApiKey(input.value)
    if (!res.ok) {
      ElMessage.error(res.message)
      return
    }
    currentMasked.value = res.data.apiKeyMasked
    ElMessage.success('API Key 已保存')
    visible.value = false
  } finally {
    saving.value = false
  }
}
</script>
