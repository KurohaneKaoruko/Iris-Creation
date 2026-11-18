/** 编辑器崩溃恢复草稿：本地暂存，不覆盖工程文件，恢复前校验原始基线。 */
export type EditorDraft = { baseContent: string; draft: string; savedAt: number }

export function editorDraftKey(workRoot: string, path: string): string {
  return `iris-editor-draft:${encodeURIComponent(workRoot)}:${encodeURIComponent(path)}`
}

export function parseEditorDraft(raw: string | null): EditorDraft | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<EditorDraft>
    if (typeof value.baseContent !== 'string' || typeof value.draft !== 'string' || !Number.isFinite(value.savedAt)) return null
    return value as EditorDraft
  } catch {
    return null
  }
}

export function shouldOfferDraftRecovery(saved: EditorDraft | null, diskContent: string): boolean {
  return !!saved && saved.draft !== saved.baseContent && saved.draft !== diskContent
}
