import type { FindHit } from '../../api/editorFind'

/** textarea 没有可测量的文本节点；复制排版到隐藏镜像，按实际折行而不是按换行符算高度。 */
export function revealEditorSelection(editor: HTMLTextAreaElement, hit: FindHit) {
  editor.setSelectionRange(hit.start, hit.end)
  if (!editor.clientWidth || !editor.clientHeight) return

  const doc = editor.ownerDocument
  const style = doc.defaultView?.getComputedStyle(editor)
  if (!style) return
  const mirror = doc.createElement('div')
  for (const property of [
    'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant',
    'line-height', 'letter-spacing', 'word-spacing', 'tab-size', 'direction', 'text-indent',
    'text-transform', 'text-align', 'white-space', 'word-break', 'overflow-wrap',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  ]) mirror.style.setProperty(property, style.getPropertyValue(property))
  Object.assign(mirror.style, {
    position: 'absolute', top: '0', left: '0', visibility: 'hidden', pointerEvents: 'none',
    boxSizing: 'border-box', width: `${editor.clientWidth}px`,
  })
  mirror.setAttribute('aria-hidden', 'true')
  const value = editor.value
  const text = doc.createTextNode(`${value}\u200b`) // 保证文末空行也有可测量的位置
  mirror.append(text)
  doc.body.append(mirror)
  try {
    const range = doc.createRange()
    const start = Math.min(hit.start, value.length)
    range.setStart(text, start)
    range.setEnd(text, start + ((value.codePointAt(start) ?? 0) > 0xffff ? 2 : 1))
    const rect = range.getClientRects?.()[0]
    if (rect) editor.scrollTop = Math.max(0, rect.top - mirror.getBoundingClientRect().top - editor.clientHeight / 2 + rect.height / 2)
  } finally {
    mirror.remove()
  }
}
