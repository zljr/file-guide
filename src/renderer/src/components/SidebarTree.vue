<template>
  <div class="sidebar">
    <div class="sidebar-head">
      <span class="sidebar-title">目录</span>
      <el-button size="small" text :icon="Refresh" @click="reload">刷新</el-button>
    </div>
    <el-scrollbar class="sidebar-scroll">
      <el-tree
        :key="treeKey"
        lazy
        :load="loadNode"
        :props="treeProps"
        node-key="path"
        highlight-current
        :expand-on-click-node="false"
        @node-click="onNodeClick"
      >
        <template #default="{ data, node }">
          <span class="tree-node" :title="data.path" @dblclick.stop="openNode(data)">
            <el-icon :size="14" class="tree-icon" :color="nodeColor(data, node)">
              <component :is="nodeIcon(data, node)" />
            </el-icon>
            <span class="tree-label">{{ data.name }}</span>
          </span>
        </template>
      </el-tree>
    </el-scrollbar>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { Component } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { fileIconMeta, Folder, FolderOpened } from '../utils/fileIcons'

interface TreeNode {
  name: string
  path: string
  isDirectory: boolean
}

const emit = defineEmits<{ select: [path: string] }>()

const treeKey = ref(0)
/** 文件节点 disabled：不可选中、不可展开，仅作查看 */
const treeProps = {
  label: 'name',
  isLeaf: (data: TreeNode) => !data.isDirectory,
  disabled: (data: TreeNode) => !data.isDirectory
}

async function loadNode(
  node: { level: number; data?: TreeNode },
  resolve: (children: TreeNode[]) => void
): Promise<void> {
  if (node.level === 0) {
    const res = await window.api.getDrives()
    if (!res.ok) {
      ElMessage.error(res.message)
      resolve([])
      return
    }
    resolve(
      res.data.map((drive) => ({
        name: `本地磁盘 (${drive.letter}:)`,
        path: drive.root,
        isDirectory: true
      }))
    )
    return
  }
  const dir = node.data?.path
  if (!dir) {
    resolve([])
    return
  }
  const res = await window.api.listEntries(dir)
  if (!res.ok) {
    ElMessage.error(res.message)
    resolve([])
    return
  }
  resolve(res.data)
}

function nodeIcon(data: TreeNode, node: { expanded?: boolean }): Component {
  if (data.isDirectory) {
    return node.expanded ? FolderOpened : Folder
  }
  return fileIconMeta(data.name).icon
}

function nodeColor(data: TreeNode, node: { expanded?: boolean }): string {
  if (data.isDirectory) {
    return '#e6a23c'
  }
  return fileIconMeta(data.name).color
}

function onNodeClick(data: TreeNode): void {
  // 文件节点仅展示，不能被选为工作目录
  if (data.isDirectory) {
    emit('select', data.path)
  }
}

/** 双击节点：文件夹在资源管理器中打开该文件夹，文件用系统默认程序打开 */
async function openNode(data: TreeNode): Promise<void> {
  const res = await window.api.open(data.path)
  if (!res.ok) {
    ElMessage.error(res.message)
  }
}

/** 刷新整棵树（创建成功后由父组件调用） */
function reload(): void {
  treeKey.value++
}

defineExpose({ reload })
</script>
