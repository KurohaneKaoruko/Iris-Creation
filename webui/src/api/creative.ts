/**
 * 创作台媒体服务 API：图片/视频生成任务（workspace 绑定）+ 媒体服务设置（app 级）。
 * 媒体字节不经 JSON RPC（16 MiB 上限），就绪产物走流式 GET /api/creative-media/{id}。
 */

import { rpc } from './rpc'
import { imageFileToBase64 } from './storyboard'

export type MediaJobKind = 'import' | 'image' | 'edit' | 'video'
export type MediaJobState = 'submitting' | 'waiting' | 'ready' | 'failed' | 'interrupted'
export type MediaFormat = 'png' | 'jpg' | 'webp' | 'mp4'

export type MediaJob = {
  id: string
  shotId: string | null
  sourceId: string | null
  kind: MediaJobKind
  state: MediaJobState
  prompt: string
  model: string
  createdAt: number
  asset?: { format: MediaFormat; bytes: number }
  remote?: { id: string; base: string }
  error?: string
  progress?: number
}

export type MediaLibrary = { jobs: MediaJob[]; skipped: number }

export type CreativeBoard = { revision: string | null; board: unknown }

export type MediaSettings = { imageBase: string; imageModel: string; videoBase: string }
export type MediaSettingsView = {
  settings: MediaSettings
  imageKeyConfigured: boolean
  videoKeyConfigured: boolean
}

export const loadCreativeBoard = (workspaceRoot: string) =>
  rpc<CreativeBoard>('load_creative_board', { workspaceRoot })
export const saveCreativeBoard = (workspaceRoot: string, revision: string | null, board: unknown) =>
  rpc<string>('save_creative_board', { workspaceRoot, revision, board })

export const listCreativeMedia = (workspaceRoot: string) =>
  rpc<MediaLibrary>('list_creative_media', { workspaceRoot })
export const importCreativeImage = async (workspaceRoot: string, file: File) => {
  const base64 = await imageFileToBase64(file)
  return rpc<MediaJob>('import_creative_image', { workspaceRoot, shotId: null, base64 })
}
export type GenerateMediaRequest = {
  kind: MediaJobKind
  shotId: string | null
  sourceId: string | null
  prompt: string
  portrait?: boolean
  duration?: number
}
export const generateCreativeMedia = (workspaceRoot: string, request: GenerateMediaRequest) =>
  rpc<MediaJob>('generate_creative_media', { workspaceRoot, request })
export const refreshCreativeMedia = (workspaceRoot: string, id: string) =>
  rpc<MediaJob>('refresh_creative_media', { workspaceRoot, id })

export const getCreativeMediaSettings = () =>
  rpc<MediaSettingsView>('get_creative_media_settings')
export const saveCreativeMediaSettings = (request: {
  settings: MediaSettings
  imageKey: string | null
  videoKey: string | null
}) => rpc<MediaSettingsView>('save_creative_media_settings', { request })

/** 就绪产物的流式地址（经反代/直连均可；服务端按当前作品校验归属）。 */
export const creativeMediaUrl = (id: string) => `api/creative-media/${id}`

/** 人类可读的体积。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const MEDIA_KIND_LABELS: Record<MediaJobKind, string> = {
  import: '导入', image: '生成图', edit: '编辑图', video: '生成视频',
}
export const MEDIA_STATE_LABELS: Record<MediaJobState, string> = {
  submitting: '提交中', waiting: '供应商处理中', ready: '已就绪', failed: '失败', interrupted: '中断',
}

/**
 * 视频在 <video> 里直接流式播放（Range 支持拖动）；图片用 fetch 拉字节转 blob URL，
 * 避免把 base64 塞进内存里的 React 状态。两者都要求服务端可达且任务就绪。
 */
export async function fetchMediaBlob(id: string): Promise<{ url: string; mime: string }> {
  const response = await fetch(creativeMediaUrl(id))
  if (!response.ok) throw new Error(`媒体读取失败（HTTP ${response.status}）`)
  const blob = await response.blob()
  return { url: URL.createObjectURL(blob), mime: blob.type || 'application/octet-stream' }
}
