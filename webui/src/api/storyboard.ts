import { rpc } from './rpc'

export type ShotFraming = 'wide' | 'medium' | 'close_up' | 'extreme_close_up' | 'over_shoulder' | 'point_of_view' | 'insert'
export type CameraMove = 'static' | 'pan' | 'tilt' | 'dolly' | 'track' | 'handheld' | 'zoom'
export type AssetRole = 'reference' | 'character' | 'location' | 'prop' | 'other'

export type Shot = {
  id: string
  scenePath: string
  title: string
  action: string
  dialogue: string
  framing: ShotFraming
  cameraMove: CameraMove
  duration: number
  assetIds: string[]
}

export type StoryboardAsset = {
  id: string
  role: AssetRole
  name: string
  originalName: string
  notes: string
  format: 'png' | 'jpg' | 'webp'
  bytes: number
  width: number
  height: number
  hash: string
  previewHash: string
  path: string
  available: boolean
}

export type ShotDraft = Omit<Shot, 'id'> & { id?: string }
export type Storyboard = { revision: string | null; shots: Shot[]; assets: StoryboardAsset[]; unlinkedScenePaths: string[] }

export const emptyStoryboard = (): Storyboard => ({ revision: null, shots: [], assets: [], unlinkedScenePaths: [] })

export const loadStoryboard = (workspaceRoot: string) => rpc<Storyboard>('load_storyboard', { workspaceRoot })
export const saveShot = (workspaceRoot: string, revision: string | null, shot: ShotDraft) =>
  rpc<Storyboard>('save_storyboard_shot', { workspaceRoot, revision, shot })
export const removeShot = (workspaceRoot: string, revision: string | null, shotId: string) =>
  rpc<Storyboard>('remove_storyboard_shot', { workspaceRoot, revision, shotId })
export const reorderShots = (workspaceRoot: string, revision: string | null, expectedIds: string[], ids: string[]) =>
  rpc<Storyboard>('reorder_storyboard_shots', { workspaceRoot, revision, expectedIds, ids })
export const importStoryboardImage = (
  workspaceRoot: string,
  revision: string | null,
  shotId: string | null,
  role: AssetRole,
  name: string,
  originalName: string,
  base64: string,
) => rpc<Storyboard>('import_storyboard_image', { workspaceRoot, revision, shotId, role, name, originalName, base64 })
export const detachStoryboardAsset = (workspaceRoot: string, revision: string | null, id: string) =>
  rpc<Storyboard>('detach_storyboard_asset', { workspaceRoot, revision, id })
export const readCreativeImage = (workspaceRoot: string, id: string) =>
  rpc<{ mime: string; base64: string }>('read_creative_image', { workspaceRoot, id })
export const exportStoryboard = (workspaceRoot: string, revision: string | null) =>
  rpc<string>('save_storyboard_export', { workspaceRoot, revision })

export const FRAMINGS: Array<{ id: ShotFraming; label: string }> = [
  { id: 'wide', label: '远景' }, { id: 'medium', label: '中景' }, { id: 'close_up', label: '近景' },
  { id: 'extreme_close_up', label: '大特写' }, { id: 'over_shoulder', label: '过肩' },
  { id: 'point_of_view', label: '主观' }, { id: 'insert', label: '插入特写' },
]
export const CAMERA_MOVES: Array<{ id: CameraMove; label: string }> = [
  { id: 'static', label: '固定' }, { id: 'pan', label: '摇镜' }, { id: 'tilt', label: '俯仰' },
  { id: 'dolly', label: '推拉' }, { id: 'track', label: '跟拍' }, { id: 'handheld', label: '手持' }, { id: 'zoom', label: '变焦' },
]
export const ASSET_ROLES: Array<{ id: AssetRole; label: string }> = [
  { id: 'reference', label: '参考图' }, { id: 'character', label: '人物' }, { id: 'location', label: '场景' },
  { id: 'prop', label: '道具' }, { id: 'other', label: '其他' },
]
export const blankShot = (scenePath: string): ShotDraft => ({ scenePath, title: '', action: '', dialogue: '', framing: 'wide', cameraMove: 'static', duration: 5, assetIds: [] })
export const storyboardDraftKey = (workspace: string) => `iris-storyboard-draft:${encodeURIComponent(workspace)}`
export type StoryboardDraft = { revision: string | null; shot: ShotDraft; savedAt: number }

export function parseStoryboardDraft(raw: string | null): StoryboardDraft | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as StoryboardDraft
    const shot = value.shot
    if (!(value.revision === null || typeof value.revision === 'string') || !Number.isFinite(value.savedAt) || !shot
      || (shot.id !== undefined && typeof shot.id !== 'string') || typeof shot.scenePath !== 'string' || typeof shot.title !== 'string'
      || typeof shot.action !== 'string' || typeof shot.dialogue !== 'string' || !FRAMINGS.some(({ id }) => id === shot.framing)
      || !CAMERA_MOVES.some(({ id }) => id === shot.cameraMove) || !Number.isFinite(shot.duration)
      || !Array.isArray(shot.assetIds) || shot.assetIds.length > 8 || !shot.assetIds.every((id) => typeof id === 'string')) return null
    return value
  } catch { return null }
}

export function previewDataUrl(image: { mime: string; base64: string }) {
  if (image.mime !== 'image/png' || image.base64.length > 3 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.base64)) {
    throw new Error('图片预览数据格式无效。')
  }
  return `data:image/png;base64,${image.base64}`
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const IMAGE_SIGNATURES: Array<{ mime: string; start: (bytes: Uint8Array) => boolean }> = [
  { mime: 'image/png', start: (b) => b.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => b[i] === byte) },
  { mime: 'image/jpeg', start: (b) => b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255 },
  { mime: 'image/webp', start: (b) => b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP' },
]

export async function imageFileToBase64(file: File): Promise<string> {
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) throw new Error('图片须为 1 字节至 10 MiB。')
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer())
  const signature = IMAGE_SIGNATURES.find(({ start }) => start(bytes))
  if (!signature) throw new Error('只支持 PNG、JPEG 或 WebP 图片。')
  if (file.type && file.type !== signature.mime && !(file.type === 'image/jpg' && signature.mime === 'image/jpeg')) {
    throw new Error('图片扩展类型与实际文件内容不一致。')
  }
  const data = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < data.length; offset += 0x8000) binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000))
  return btoa(binary)
}
