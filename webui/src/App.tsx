import { Component, useEffect, useState, type ReactNode, type ErrorInfo } from 'react'
import { ProjectProvider, useProject } from './state/ProjectContext'
import { ThemeProvider } from './state/ThemeContext'
import { LaunchScreen } from './features/launch/LaunchScreen'
import { AgentWorkspace } from './features/agent/AgentWorkspace'
import { backendRetryDelay, probeBackend } from './api/health'
import { Icon } from './components/Icon'
import './App.css'

function BackendGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [checking, setChecking] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [message, setMessage] = useState('正在启动本地写作服务…')
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let active = true
    let timer: number | undefined
    const check = async () => {
      setChecking(true)
      setReady(false)
      for (let index = 0; index < 18 && active; index += 1) {
        const result = await probeBackend()
        if (!active) return
        if (result.ok) {
          setReady(true)
          setChecking(false)
          setAttempt(index + 1)
          return
        }
        setMessage(result.message)
        setAttempt(index + 1)
        if (index < 17) {
          await new Promise<void>((resolve) => {
            timer = window.setTimeout(resolve, backendRetryDelay(index))
          })
        }
      }
      if (active) setChecking(false)
    }
    void check()
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [retryKey])

  if (ready) return children
  return (
    <main className="startup-gate" role="status" aria-live="polite">
      <div className="startup-card">
        <div className={`startup-mark ${checking ? 'is-loading' : 'is-error'}`}>
          <Icon name={checking ? 'book-open' : 'triangle-alert'} size={28} />
        </div>
        <p className="startup-eyebrow">IRIS CREATION</p>
        <h1>{checking ? '正在准备写作空间' : '写作服务尚未就绪'}</h1>
        <p className="startup-copy">
          {checking ? '正在启动本地服务并检查应用资源，通常只需几秒。' : message}
        </p>
        <div className="startup-progress" aria-hidden="true"><span className={checking ? 'active' : ''} /></div>
        <p className="startup-detail">{checking ? `连接检查 ${attempt}/18` : '你的作品文件不会因此受到影响。'}</p>
        {!checking ? (
          <div className="startup-actions">
            <button className="startup-retry" onClick={() => setRetryKey((key) => key + 1)}>
              <Icon name="refresh" size={15} />重新连接
            </button>
            <button className="startup-copy-error" onClick={() => { void navigator.clipboard?.writeText(message).catch(() => setMessage('无法访问剪贴板，请手动记录上方诊断信息。')) }}>
              复制诊断信息
            </button>
          </div>
        ) : null}
      </div>
    </main>
  )
}

function Shell() {
  const { workRoot, error, setError } = useProject()

  return (
    <>
      {workRoot ? <AgentWorkspace key={workRoot} /> : <LaunchScreen />}
      {error ? (
        <div className="toast-error glass-float" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      ) : null}
    </>
  )
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state: { message: string | null } = { message: null }
  static getDerivedStateFromError(error: Error) { return { message: error.message } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[iris] UI error', error, info.componentStack) }
  render() {
    if (!this.state.message) return this.props.children
    return (
      <main className="startup-gate">
        <section className="startup-card" role="alert">
          <div className="startup-mark is-error"><Icon name="triangle-alert" size={28} /></div>
          <h1>界面遇到了问题</h1>
          <p className="startup-copy">你的作品文件仍保存在本地。重新加载界面后可继续使用。</p>
          <details className="startup-copy"><summary>查看诊断信息</summary><pre>{this.state.message}</pre></details>
          <button className="startup-retry" onClick={() => window.location.reload()}>重新加载</button>
        </section>
      </main>
    )
  }
}

export default function App() {
  return (
    <AppErrorBoundary>
      <ThemeProvider>
        <BackendGate>
          <ProjectProvider>
            <Shell />
          </ProjectProvider>
        </BackendGate>
      </ThemeProvider>
    </AppErrorBoundary>
  )
}
