# v0.1.1-rc.5 可用性验收

## 当前状态

这是候选版，不是稳定版。此前四个候选均未发布下载包。rc.5 在 rc.4 已验证的 Linux RPM 版本映射基础上，恢复 Windows/macOS 上一轮通过的标准 Tauri build 命令。最终以本标签 GitHub workflow 全绿和线上资产校验为准。

## 自动门禁

- 主 CI：版本一致性、26 项发布安全测试、前端类型检查及 295 项测试、生产构建、完整 Rust 测试、真实服务 + 本机假 Provider smoke。
- Windows/macOS：使用标准 `pnpm run tauri:build` 构建相应安装器。
- Linux：候选版用 SemVer 构建 DEB/AppImage；RPM 通过额外 Tauri config 转成合法的基础 Version + `0.<prerelease>` Release，并验证其排序早于稳定 release `1`。
- 三个平台各自构建服务程序并通过本机模拟 AI 的保存/冲突/历史恢复/停止/错误/重启验收。
- 发布只接受预期版本/平台五种安装包；上传后核验尺寸和 SHA256。任何失败均不删除/覆盖旧 Release，也不公开不完整候选。

## 尚需人工验收

- [ ] Windows x64 安装、启动、重开、端口占用与旧版升级。
- [ ] macOS Apple Silicon DMG、安全提示、重开与升级。
- [ ] Linux AppImage、DEB、RPM 在干净环境安装/启动；验证 rc.5 RPM 可更新至正式版。
- [ ] 真实模型的配置、生成、停止、重开、限流和断网反馈。
- [ ] 长篇写作、异常退出恢复、磁盘空间不足/权限拒绝。
- [ ] 手动复制整个作品目录（含 `.novel/`）并实际恢复打开。校验清单不包含正文。

人工验收完成前，不应把候选版当作承载唯一原稿的稳定版。
