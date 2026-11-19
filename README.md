# Iris-Creation

**Iris-Creation** 是面向小说与剧本的本地桌面创作工作台，基于 Tauri v2 和 React 构建。文稿保存在各自的作品目录中，可脱离应用用文本编辑器打开。

它围绕创作者的核心工作流设计：

- 作品与资料管理
- 章节写作、分场写作与改稿
- AI 规划、审阅与长期记忆
- 人物、关系、线索与连续性维护

## 当前产品形态

### 1. 作品工作区

小说作品目录结构不变：

```text
<work>/
  concept/   # 设定、人物、关系等资料（.md）
  outline/   # 大纲与规划资料（.md）
  stories/   # 正文章节（.md）
  .novel/    # 状态、缓存、历史、索引
```

### 2. 剧本工作台（开发版）

1. 在书架选「新建作品 → 剧本」。初始作品包含开场、人物表和分场大纲，可直接编辑。
2. 在「场次」里新增内／外景、地点、时间，并用上下移动调整整稿顺序。第一行 `# 标题` 是场次标题；编辑标题不改文件名。对白可写作 `**角色：** 台词`。
3. 「剧本工坊」提供分场大纲、起草单场、对白润色与场次审阅。先预览结果，再存为新场次或送进编辑草稿。停止或失败的结果不作为完成稿写入。剧本对话 Agent 可读取工程资料，不能直接改写原稿。
4. 「导出剧本」按列表顺序合并**已保存**的场次，以 Markdown 或 TXT 写入 `exports/`，每次生成新文件。

剧本正文保存在 `scenes/` 的直属 Markdown 文件中；类型记录在 `.novel/work.json`，编排记录在 `.novel/.settings/scene-order.json`。现有小说无需迁移。完整备份请退出应用后复制整个作品目录（包括 `.novel/`）；「备份」页只生成校验报告。

### 3. 小说工作台

小说继续提供章节管理、写作工坊、AI 任务队列、人物与设定、全文检索及整本导出。规划与记忆索引随作品保存在 `.novel/`。

## 核心能力

- Markdown 编辑、预览与专注写作
- 草稿崩溃恢复、外部修改冲突保护、变更历史与版本恢复
- 编辑草稿本地暂存，确认保存后才写入工程
- 新建章节 / 设定 / 大纲文件
- AI 续写、改写、润色、规划与一致性检查
- 写作技能库（[Novelist-Skills](https://github.com/KurohaneKaoruko/Novelist-Skills) 子模块）：场景三拍、正文铁律、黄金三章、连续性维护与六种风格规范，聊天面板 `/skill <id>` 一键注入
- 修订建议审阅与逐条应用
- 人物关系图与作品结构导航
- 版本记录与恢复

## 快速开始

### 环境要求（Windows）

- Node.js 22.12+（CI 与当前 Vitest 5 均要求 Node 22+）
- Rust stable（含 `cargo`）
- Visual Studio Build Tools（Desktop development with C++ / MSVC）
- WebView2 Runtime

### 本地开发

```powershell
git clone --recurse-submodules <repo-url>
# 已克隆的仓库补拉子模块：
git submodule update --init --recursive

pnpm install --frozen-lockfile
pnpm --dir webui install --frozen-lockfile
pnpm run tauri:dev
```

### 构建

```powershell
pnpm install --frozen-lockfile
pnpm --dir webui install --frozen-lockfile
pnpm run tauri:build
```

安装包会携带 Web 前端资源，桌面壳从应用资源目录启动本地服务；启动不依赖终端当前目录。第一次启动会把旧版本的设置、会话和书架状态补迁移到系统用户数据目录，保留旧文件且不覆盖已有配置（不会移动或删除作品文件）。桌面端绑定本地服务后显示窗口，界面再完成健康检查；服务或资源启动失败时显示原生错误对话框，连接异常时提供重试与诊断提示。

## 常用命令

- `pnpm run dev`：仅启动前端开发服务器
- `pnpm run tauri:dev`：启动桌面开发模式
- `pnpm run build`：构建前端
- `pnpm run tauri:build`：构建桌面应用
- `pnpm run test`：运行 Vitest
- `pnpm run lint`：TypeScript 类型检查

## 找文件与回到正文

- **Ctrl/Cmd+P**：按场次／章节标题、文件名或路径快速打开文件；空搜索按最近打开优先排列，支持上下键和 Enter。最近文档按作品隔离，失效路径不显示，界面最多展示前 80 条以避免长篇工程卡顿。
- **Ctrl/Cmd+K → 全文检索**：分批扫描正文、设定和大纲，显示命中行及前后文。停止、重新搜索或关闭工具中心会取消在途读取；读取失败会提示结果可能不完整。看完一处可重新打开检索继续查看已完成的结果，不必重扫。
- 点击检索结果会按 Markdown **真实源行**定位，即使文件已打开也能跳转；「编辑此处」选中原文，若文件已改变而关键词失效，则只定位光标，不选中无关文字。
- **Ctrl/Cmd+F**：正文编辑器内查找，Enter / Shift+Enter 循环前后命中，中文输入法确认不会误触发导航。切换文件仍受未保存保护，不会静默丢弃草稿。

## AI 工作流摘要

使用 AI 时，输入和所引用的资料会发送给选定的模型服务。无需 AI 即可编辑、编排和导出作品。

### Review-first 默认策略

- AI 改稿默认先生成审阅建议，不直接覆盖正文
- 建议基于原始快照应用，避免连续接受时行号漂移
- 文件内容变化后会阻止脏写入，要求重新生成建议

### Memory 治理

Memory 索引位于：

```text
.novel/state/character-state-index.md
.novel/state/foreshadow-index.md
```

每个索引支持：

- 自动生成 (`source: auto`)
- 手工修订 (`source: manual`)
- 锁定防覆盖 (`locked: true`)
- 恢复自动模式

## 主要存储位置

- 桌面端用户数据根目录：Tauri `app_data_dir`（Windows AppData/Roaming / macOS Application Support / Linux XDG Data Home），子目录为 `com.iriscreation.desktop`
- App settings: `<app-data>/config/settings.json`
- Writing assistants: `<app-data>/data/agents.json`
- Chat history: `<app-data>/data/chat_history.json`
- Bookshelf state: `<app-data>/state/last_workspace.json`, `<app-data>/state/external_projects.json`
- API keys: `<app-data>/secrets/secrets.json`
- 默认新建作品：`<app-data>/projects/`

可用 `IRIS_CREATION_DATA_DIR` 指定数据根目录、`IRIS_CREATION_STATIC_DIR` 指定前端目录；显式指定数据目录时不自动导入历史配置。开发 UI 地址为 `http://localhost:1421`，开发态 RPC 固定使用 `127.0.0.1:8765`；打包态会记住可用端口，冲突时寻找其他端口。主题和恢复草稿按浏览器来源隔离，端口改变时不会自动迁移这些临时状态；工程文件与服务端设置不受影响。技能库可用 `IRIS_CREATION_SKILLS_DIR` 指定（默认自动探测可执行文件旁或仓库内 `skills/`，编译期另有一份内嵌兜底）。

## 下一步

详见[创作路线与验收清单](docs/creative-workflow.md)。图片生成／编辑、分镜与视频生成不包含在本阶段。

## 许可证

GPL-3.0
