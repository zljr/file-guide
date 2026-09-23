<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="brand">
        <el-icon :size="20"><FolderOpened /></el-icon>
        <span>File Guide · 智能归档助手</span>
      </div>
      <el-tooltip content="设置 TypeSafe API Key" placement="bottom">
        <el-button text circle @click="settingsVisible = true">
          <el-icon :size="18"><Setting /></el-icon>
        </el-button>
      </el-tooltip>
    </header>

    <div class="app-body">
      <aside class="app-aside">
        <SidebarTree ref="treeRef" @select="selectedDir = $event" />
      </aside>
      <main class="app-main">
        <div class="view-tabs">
          <el-radio-group v-model="viewMode">
            <el-radio-button value="create">新建 / 上传</el-radio-button>
            <el-radio-button value="search">查找</el-radio-button>
          </el-radio-group>
        </div>
        <KeepAlive>
          <ActionPanel
            v-if="viewMode === 'create'"
            :current-path="selectedDir"
            @committed="treeRef?.reload()"
            @need-settings="settingsVisible = true"
          />
          <SearchPanel v-else :current-path="selectedDir" />
        </KeepAlive>
      </main>
    </div>

    <SettingsDialog v-model="settingsVisible" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import SidebarTree from './components/SidebarTree.vue'
import ActionPanel from './components/ActionPanel.vue'
import SearchPanel from './components/SearchPanel.vue'
import SettingsDialog from './components/SettingsDialog.vue'

const selectedDir = ref<string | null>(null)
const settingsVisible = ref(false)
const viewMode = ref<'create' | 'search'>('create')
const treeRef = ref<InstanceType<typeof SidebarTree> | null>(null)
</script>
