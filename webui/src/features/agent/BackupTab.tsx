import { useCallback, useEffect, useState } from 'react'
import { listWorkspaceTree, readText, writeText, createDir } from '../../api/backend'
import {
  assembleBackupReport,
  buildExportFilename,
  collectBackupFiles,
  sha256Hex,
  type BackupFileEntry,
} from '../../api/exportCenter'
import { Icon } from '../../components/Icon'
import { useProject } from '../../state/ProjectContext'
import './BackupTab.css'

/** 单文件清单采集：读内容 → 字数（去空白）+ 字节 + SHA-256 */
async function collectEntry(path: string, workspace?: string): Promise<BackupFileEntry> {
  const content = await readText(path, undefined, workspace)
  return {
    path,
    words: content.replace(/\s/g, '').length,
    bytes: new TextEncoder().encode(content).length,
    hash: await sha256Hex(content),
  }
}

/**
 * 「备份」页签：工程快照报告（零新依赖，非压缩包）。
 * 全工程文件树（排除 exports/）逐文件字数/大小/SHA-256 清单，落盘 exports/backups/。
 * hash 清单用于日后核对内容是否被改动；完整目录冷备份建议用系统工具。
 */
export function BackupTab() {
  const { workName, workRoot } = useProject()
  const workspace = workRoot ?? undefined
  const [files, setFiles] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [done, setDone] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const tree = await listWorkspaceTree(8, undefined, workspace)
        setFiles(collectBackupFiles(tree))
      } catch (error) {
        setErr(`扫描失败：${error instanceof Error ? error.message : String(error)}`)
        setFiles([])
      }
    })()
  }, [workspace])

  const run = useCallback(async () => {
    const snapshotFiles = files ?? []
    if (snapshotFiles.length === 0 || busy) return
    setBusy(true)
    setErr('')
    setDone('')
    setProgress(0)
    try {
      const entries: BackupFileEntry[] = []
      // 分批处理（批间让出主线程），千文件级工程不冻 UI
      const BATCH = 12
      for (let i = 0; i < snapshotFiles.length; i += BATCH) {
        const batch = snapshotFiles.slice(i, i + BATCH)
        entries.push(...(await Promise.all(batch.map((p) => collectEntry(p, workspace)))))
        setProgress(Math.min(snapshotFiles.length, i + BATCH))
        await new Promise((r) => setTimeout(r, 0))
      }
      await createDir('exports/backups', workspace)
      const filename = buildExportFilename(workName || '未命名作品', 'backup', 'md')
      const relPath = `exports/backups/${filename}`
      await writeText(relPath, assembleBackupReport({ workName: workName || '未命名作品', files: entries }), workspace)
      setDone(relPath)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [busy, files, workName, workspace])

  return (
    <div className="bkp">
      <div className="bkp-intro">
        <Icon name="package" size={16} />
        <div>
          <div className="bkp-title">工程文件校验清单（非完整备份）</div>
          <div className="bkp-desc">
            为扫描到的工程文本文件生成清单：逐文件记录字数、大小与 SHA-256 校验值，写入 <code>exports/backups/</code>。
            此报告不包含正文副本，不能用于恢复丢失的文件；也不包含二进制参考图校验。完整备份请先保存并关闭作品，再将包含 <code>creative/</code> 与 <code>.novel/</code> 的整个作品目录复制到其他磁盘。
          </div>
        </div>
      </div>

      <div className="bkp-actions">
        <button className="tools-run primary" disabled={busy || !files || files.length === 0} onClick={() => void run()}>
          {busy ? `生成中 ${progress}/${files?.length ?? 0}…` : <><Icon name="download" size={14} />生成校验清单</>}
        </button>
        <span className="tools-run-hint">
          {files === null ? '扫描工程中…' : `${files.length} 个文件将纳入清单（exports/ 产物不重复纳入）`}
        </span>
      </div>

      {done ? (
        <div className="tools-ok">
          <Icon name="check-circle" size={14} /> 校验清单已生成（不含正文副本）：<code className="exp-path">{done}</code>
        </div>
      ) : null}
      {err ? <div className="tools-err">{err}</div> : null}

      {files !== null && files.length > 0 ? (
        <div className="bkp-files">
          <div className="tools-section-title">纳入清单的文件（前 30）</div>
          {files.slice(0, 30).map((p) => (
            <div key={p} className="bkp-file">
              <Icon name="file-text" size={13} />
              <span className="bkp-file-path">{p}</span>
            </div>
          ))}
          {files.length > 30 ? <div className="bkp-more">…共 {files.length} 个</div> : null}
        </div>
      ) : files !== null ? (
        <div className="tools-hint">工程内暂无可纳入清单的文件。</div>
      ) : null}
    </div>
  )
}
