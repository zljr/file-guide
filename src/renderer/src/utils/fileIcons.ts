/**
 * 文件类型 → 图标 映射：
 * 1. 文件夹单独处理（展开/收起两种状态）
 * 2. 常见类型文件按后缀映射到不同图标与颜色
 * 3. 未识别类型兜底使用灰色 Document
 */
import type { Component } from 'vue'
import {
  Cpu,
  DataBoard,
  Document,
  Files,
  Folder,
  FolderOpened,
  Grid,
  Headset,
  Memo,
  Monitor,
  Notebook,
  Picture,
  VideoCamera
} from '@element-plus/icons-vue'

export interface IconMeta {
  icon: Component
  color: string
}

const EXT_ICON_MAP: Record<string, IconMeta> = {}

function register(extensions: string[], meta: IconMeta): void {
  for (const ext of extensions) {
    EXT_ICON_MAP[ext] = meta
  }
}

// 图片
register(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'], {
  icon: Picture,
  color: '#67c23a'
})
// 视频
register(['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv'], { icon: VideoCamera, color: '#f56c6c' })
// 音频
register(['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'], { icon: Headset, color: '#9c6ade' })
// 压缩包
register(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'], { icon: Files, color: '#e6a23c' })
// Word / 文档
register(['doc', 'docx', 'rtf', 'odt'], { icon: Memo, color: '#409eff' })
// Excel / 表格
register(['xls', 'xlsx', 'csv'], { icon: Grid, color: '#67c23a' })
// PPT / 演示
register(['ppt', 'pptx'], { icon: DataBoard, color: '#e6a23c' })
// PDF
register(['pdf'], { icon: Document, color: '#f56c6c' })
// 代码 / 配置
register(
  [
    'js', 'ts', 'jsx', 'tsx', 'vue', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs',
    'php', 'rb', 'sh', 'bat', 'ps1', 'html', 'htm', 'css', 'scss', 'less', 'json',
    'xml', 'yml', 'yaml', 'toml'
  ],
  { icon: Monitor, color: '#409eff' }
)
// 纯文本 / 笔记
register(['txt', 'md', 'log', 'ini', 'conf'], { icon: Notebook, color: '#909399' })
// 可执行 / 安装包
register(['exe', 'msi', 'dll'], { icon: Cpu, color: '#9093bf' })

/** 取文件名的小写后缀；无后缀返回空串（".gitignore" 这类隐藏文件视为无后缀） */
export function extOf(fileName: string): string {
  const idx = fileName.lastIndexOf('.')
  if (idx <= 0 || idx === fileName.length - 1) {
    return ''
  }
  return fileName.slice(idx + 1).toLowerCase()
}

/** 按后缀取图标；未识别类型兜底为灰色 Document */
export function fileIconMeta(fileName: string): IconMeta {
  return EXT_ICON_MAP[extOf(fileName)] ?? { icon: Document, color: '#909399' }
}

export { Folder, FolderOpened }
