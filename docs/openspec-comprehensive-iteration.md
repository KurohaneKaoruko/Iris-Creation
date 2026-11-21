# OpenSpec 全面迭代实施说明

本文件对应父目录 OpenSpec 变更 `comprehensive-product-iteration`。Iris 按 P0 本地文件/草稿/冲突/凭据边界 → P1 小说、剧本、规划、媒体和 CLI 工作流 → P2 性能与体验 → P3 Tauri/跨平台发布推进。

## 保护与验证

- 当前未提交的 `src-tauri/Cargo.toml`、`services/mod.rs`、`creative.rs`、`creative_media.rs` 属于既有工作，实施前必须单独审查，禁止 reset、checkout 或批量覆盖。任务 4.2 中用户单独授权了 `creative_media.rs` 的一个测试夹具修正，范围和校验记录见下方；不代表整体纳入或业务实现审查完成。
- WebUI 改动运行 `pnpm run lint`、`pnpm run test`；Rust 改动运行 `cargo test --manifest-path src-tauri/Cargo.toml`，通道/服务改动追加 API 冒烟。
- Markdown、`.novel/`、`creative/` 和媒体相对路径保持兼容；任何格式变更先同步对应设计文档并提供迁移/恢复测试。
- 真实 WebView、Windows/macOS/Linux 启动、真实模型和真实 CLI 属于人工/真实环境门；自动化或假 CLI 通过不得代替真机验收。

## 提交与交接

每个可交付切片使用 Conventional Commit，代码、测试、设计文档和 HANDOVER 同步；在未完成真实环境验收时记录限制，不标记为完整发布。

## 2026-11-21 编辑保护交接（任务 4.1）

- 已用组件测试复现并修复：700ms 防抖前卸载漏存、`pagehide` 不补存、缓存写入异常静默。
- 当前编辑状态保留作品、路径、原始基线与最新草稿；页面关闭/隐藏与文档卸载使用同一补存路径。保存成功、显式放弃和载入磁盘版本后标记缓存状态已清理，避免卸载复活旧草稿。
- 新增 8 个组件回归：即时卸载恢复、输入后关闭、页面隐藏、保存失败不导航、放弃/保存后不复活缓存、迟到读取隔离、存储失败提示。已有外部改稿/二次冲突/恢复旧基线测试保持通过。
- 验证：`pnpm run lint` 通过；`pnpm run test` 为 32 文件、317 项通过。真实 WebView/安装器和 Rust 全量测试未在该切片验证，不据此前端测试宣称其通过。
- 既有四个 Rust 未提交文件 SHA-256 与父目录基线一致，未修改或纳入该切片。下一项为 4.2 的 Rust/RPC 文件边界测试。

## 2026-11-21 文件边界交接（任务 4.2）

- 保留 MD/Markdown/TXT 正文及合法内部 JSON 写入。普通文件接口保护 `.git`、`.novel/.history`、`.novel/snapshots`、`.novel/work.json` 和既有分镜/参考图受管路径；读写、新建、删除和重命名拒绝路径逃逸与链接。文件引用、质量检查和小说导出复用安全读取，不再绕过边界。
- 单次普通文本读写按 UTF-8 字节限制为 16 MiB；HTTP 仍以包含 JSON 开销的整个请求体计算 16 MiB，并在超限时返回 413。合法文本恰好达到服务层上限仍可读写。媒体沿用 10 MiB、最大边 12000 像素、24 MP 的既有参考图限制。
- 新增 11 个 Rust 文件服务测试、6 个 RPC 分发测试；真实 HTTP 冒烟覆盖非法/受管/过期工作区、兼容路径、链接、大小限制和拒绝后正文/历史不变，媒体编码/截断/SVG/超限拒绝也核对清单与分镜未变。
- 验证：`cargo test --manifest-path src-tauri/Cargo.toml --offline --locked -- --nocapture` 为库测试 85、CLI 集成 2、桌面启动集成 2，共 89 项通过；`cargo build --manifest-path src-tauri/Cargo.toml --offline --locked --bin iris-creation-server` 通过；`node scripts/smoke-test.mjs` 9 组真实本地 HTTP/WS 冒烟通过。受 `/tmp` 空间限制，Rust/冒烟使用项目内 `.tmp/openspec-cargo` 作为 `TMPDIR`，并以 `CARGO_BUILD_JOBS=1`、`flock -w 30 /tmp/opencode/build.lock` 串行构建。
- 全量测试曾为 84/85：受保护的 `creative_media.rs` 测试手改 PNG 宽度却未更新校验值，先触发图片损坏而非尺寸拒绝。经用户明确授权，仅将这一测试夹具改为编码合法的 12001×1 PNG，媒体业务实现未变。以反向替换并复算 SHA-256 核对其余内容与阶段 0 完全一致；新 SHA-256 为 `cc1263733ca92167350d4a527fa1bd1de9f6b52c2cee6f166c287c057e9e2c78`。另外三个受保护文件校验值未变，任务 4.5 仍待完整审查与纳入决策。
- 构建期间磁盘满，经用户授权仅清理 `src-tauri/target/release/deps` 和 `src-tauri/target/release/build` 可重建产物，保留源码、作品、既有未提交改动和 20 个安装包相关文件（逐文件哈希核对）。未扩大清理范围。
- 未验收：Windows 重解析点/原生文件系统、真实 WebView/安装器、真实模型和恶意本机进程并发换目录；本切片不是 OS 沙箱或跨平台发布绿灯。所有改动仍未提交、未推送。

## 2026-11-21 版本历史交接（任务 4.3）

- 新历史记录保存可选 `content_hash`（BLAKE3 原始 UTF-8 字节）；服务端在预览和恢复前验证，阻止被外部改动的快照覆盖正文。旧索引缺少该字段时仍可读取和恢复，不伪造已校验状态。前端绑定同步为可选字段，无破坏式迁移。
- 手动留档、快照与历史索引读取复用作品内安全读取和 16 MiB 限制，补齐手动快照绕过链接/文件大小保护的旁路。
- 新增 `services/workspace_history_tests.rs` 9 项：Unicode/CRLF 元数据与路径/hash、旧记录、MD/Markdown/TXT 与剧本场次恢复后二次回退、过期基线不留档、篡改拒绝、最新 800 条剪枝与非受管路径保护、索引提交失败不丢旧快照、链接与超大源文件拒绝。场次标题改变但路径和 `scene-order.json` 不变。
- 真实 HTTP 冒烟增加 hash/旧字段兼容、篡改快照拒绝、恢复前备份和再次回退，核对失败后正文与历史索引不变。
- 验证：`pnpm run lint` 通过；WebUI 32 文件/317 项通过；Rust 全量 94 项库测试 + 4 项集成测试，共 98 项通过；重新构建服务后 9 组真实本地 HTTP/WS 冒烟通过。命令和 TMPDIR/单进程设置同 4.2。
- 下一项为 4.4 源行检索/定位回归；4.5 整体媒体审查与真实平台验收仍未完成。没有提交或推送任何仓库。

## 2026-11-21 检索源行定位交接（任务 4.4）

- 纯函数层（`webui/src/api/search.test.ts`）：`locateSearchMatch` 新增重复标题第二命中偏移验证（按请求行选词，不回绕第一个）、非正行号钳制到第 1 行、空白查询退化为行首光标；`matchInContent` 新增围栏代码块内命中按真实源行（第 4 行）报告。
- 渲染层（`MarkdownView.test.tsx`）：围栏内命中在 `pre` 内按 `data-source-line` 精确标 `<mark>` 且获得 `mdv-source-target`；过期查询只保留目标行类名、不产生任何 `<mark>`，不标无关文字。
- 滚动定位层（新文件 `FilePreview.test.tsx`，jsdom 记录 `scrollIntoView` 接收者）：重复标题按源行命中对应 `LI`（而非按锚点顺序取第一个标题）；被删/空行行号回退到其后第一个块而不是文首；越界行号落到最后一个块。定位依据 `data-source-line`/`data-source-start/end` 属性链，与渲染高度无关。
- 集成层（`editor-safety.test.tsx` 新增 4 项，走 Ctrl+K → 全文检索 → 命中 → 预览 → 编辑此处全链路）：重复标题第二命中在预览中标 `mdv-toc-山巅-1` 且第一个标题不标，textarea 选中第 4 行的词；围栏内命中编辑时精确选中围栏里的词（与标题里的同词区分）；CRLF 文件从命中行号、预览 `data-source-line="3"` 到 textarea 选区全链路一致（jsdom 与浏览器同样把 textarea 值的 CRLF 归一为 LF，偏移按 LF 文本计算）；检索提交后文件被外部改写、旧词消失时，预览无 `<mark>`、编辑器只把光标移到该行行首不选中任何文字。新增 `remountWith` 辅助确保磁盘内容在挂载读取前生效。
- 验证：`pnpm run lint` 通过；WebUI 33 文件/330 项全部通过（原 317 + 新增 13）；本任务纯前端，Rust 未改动无需重跑。改动未提交、未推送。

## 2026-11-21 创作台媒体服务审查交接（任务 4.5）

- 审查范围：未跟踪的 `src-tauri/src/services/creative.rs`（167 行）与 `src-tauri/src/services/creative_media.rs`（569 行），以及 `services/mod.rs`、`Cargo.toml` 的依赖性变更。四个文件 SHA-256 与阶段 0 基线逐一核对一致（`creative_media.rs` 为授权夹具修正后的 `cc12…2c78`），本切片未改动其中任何一行。
- `creative.rs`：创作台 board 存取（`creative/board.json`，512 KB 上限、BLAKE3 revision 乐观锁、`.write-*.tmp` 原子写）、`managed_dir` 逐级拒绝链接/重解析、`read_limited` 大小限制；自带作用域隔离与 symlink 重定向测试。与分镜的 `creative/storyboard.json` 是不同文件，无覆盖冲突。
- `creative_media.rs`：图像（OpenAI 兼容）/视频（Runway）生成。密钥全部经 `secrets` 通道，前端只接收 `configured` 布尔值；下载 URL 仅同源或 Runway 官方 CloudFront、禁重定向、MP4 `ftyp` 头校验、24 MB/128 MB 上限、单作品并发 ≤3、跨进程提交中断标 `Interrupted` 不隐式重试。未发现密钥泄漏或日志泄漏。
- 关键事实：两个服务**完全未接线**——无 RPC 分支、无 Tauri command、无 Agent 工具引用；任何入口都不可触达。它们是早于本变更的半成品（分镜/媒体生成路线），编译与测试通过（4.3 全量 98 项已含其单测）。
- 处置决策（用户确认）：**保持未提交原样**。不纳入本变更、不拆分、不单独提交；待接线时再走独立评审。
- 遗留缺口（接线前必须补）：`storyboard::protect_storage` 只保护 `creative/storyboard.json` 与 `creative/references`；新服务管理的 `creative/board.json`、`creative/jobs/`、`creative/assets/` 不在普通文件接口保护清单内，接线时需扩展保护并补回归测试。

## 2026-11-21 文档契约交接（任务 4.6）

- 规划所称 `docs/06`、`docs/08` 在 Iris 不存在；按现存结构映射到 `docs/creative-workflow.md`（数据格式 + 本地工程契约）与 `docs/openspec-comprehensive-iteration.md`（切片交接）。未触碰 Wisteria 任何文件。
- `creative-workflow.md` 新增「检索与源行定位契约」：命中行号按归一化源行、结果保留提交时词/大小写/范围、过期结果只定位不选词、重复标题锚点去重与第 N 命中定位、围栏内 `#` 不进目录但命中照常标亮、「编辑此处」textarea LF 偏移、滚动依据 `data-source-line` 属性链不按渲染高度猜测；附四层自动化测试入口。
- 新增「创作台媒体服务（未接线）」小节：明确两服务当前不可触达、密钥经 secrets 按服务地址分键且前端只见布尔值、下载同源/Runway CDN/禁重定向/ftyp 校验、24 MB/128 MB/并发 3 限制、`Interrupted` 不隐式重试；按 AGENTS.md 口径如实写明 macOS/Linux 密钥仅为 Base64 非加密；记录 protect_storage 缺口为接线前置项。
- 字段一致性核对：`MAX_HITS_PER_FILE=20`、`MAX_TOTAL_HITS=300`、`data-source-line`/`data-source-start/end` 属性、DPAPI/Base64 密钥描述均与代码逐一比对一致。既有「编辑器保存与恢复契约」「文件服务安全边界」「版本历史持久化契约」为 4.1–4.3 已交付内容，未改写。

## 2026-11-21 全量验证交接（任务 4.7，第 4 节完成）

- Iris 根目录全量验证：`pnpm run lint` 通过；`pnpm run test` 33 文件/330 项全部通过；`cargo test --manifest-path src-tauri/Cargo.toml --offline --locked` 98 项全部通过（94 库 + 2 agent_cli_e2e + 2 desktop_startup，与 4.3 基线一致）。
- 重新构建 `iris-creation-server` 后 `node scripts/smoke-test.mjs`（TMPDIR 指向 `.tmp/openspec-cargo`）9 组真实本地 HTTP/WS 冒烟全部通过：Unicode/CRLF 保存与过期拒绝、可逆历史恢复与快照完整性/旧字段兼容、导出与路径守卫、文件系统 HTTP 边界（不安全/受管/过期路径、正文与历史不变、MD/Markdown/TXT 与内部 JSON 兼容、16 MiB 限制、符号链接检查）、模拟 Provider 流式/取消/错误/断流、剧本稳定路径与导出、分镜与素材、剧本 Agent 只读、重启与整目录复制恢复。
- 第 4 节（Iris 编辑可靠性与数据边界）7 项任务全部完成。未验收项维持不变：Windows 重解析点、真实 WebView/安装器、真实付费模型、恶意本机进程并发换目录。全部改动未提交、未推送。
