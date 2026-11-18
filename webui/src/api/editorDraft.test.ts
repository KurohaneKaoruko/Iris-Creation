import { describe, expect, it } from 'vitest'
import { editorDraftKey, parseEditorDraft, shouldOfferDraftRecovery } from './editorDraft'

describe('editor crash-recovery drafts', () => {
  it('isolates drafts by workspace and file path', () => {
    expect(editorDraftKey('/work/a', 'stories/1.md')).not.toBe(editorDraftKey('/work/b', 'stories/1.md'))
    expect(editorDraftKey('/work/a', 'stories/1.md')).not.toBe(editorDraftKey('/work/a', 'stories/2.md'))
  })
  it('parses only valid draft envelopes', () => {
    expect(parseEditorDraft('{bad')).toBeNull()
    expect(parseEditorDraft(JSON.stringify({ baseContent: 1, draft: 'text', savedAt: Date.now() }))).toBeNull()
  })
  it('offers recovery only when the draft differs from both baseline and disk', () => {
    const saved = { baseContent: 'old', draft: 'unsaved', savedAt: 123 }
    expect(shouldOfferDraftRecovery(saved, 'old')).toBe(true)
    expect(shouldOfferDraftRecovery(saved, 'unsaved')).toBe(false)
    expect(shouldOfferDraftRecovery({ ...saved, draft: 'old' }, 'old')).toBe(false)
    expect(shouldOfferDraftRecovery(null, 'old')).toBe(false)
  })
})
