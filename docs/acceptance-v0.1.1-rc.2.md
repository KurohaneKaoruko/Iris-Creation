# v0.1.1-rc.2 可用性验收

## 结论

这是内测候选版。主 CI 通过后，发布矩阵再分别构建 Windows x64、macOS Apple Silicon 和 Linux x64 安装包，并运行便携后端启动验收。自动通过不等于真实设备验收完成。

## 自动门禁

```bash
pnpm run lint
pnpm run test
pnpm run build
node scripts/version.mjs check v0.1.1-rc.2
node --test scripts/release.test.mjs
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo build --locked --manifest-path src-tauri/Cargo.toml --bin iris-creation-server
node scripts/smoke-test.mjs
```

`v0.1.1-rc.1` 的发布矩阵三平台 Rust 测试步骤失败，公开 API 只提供 exit 101，原始日志要求仓库管理员权限；主 CI 同一提交的完整 Rust 测试通过。本版发布矩阵在每个平台运行 `cargo test --lib --test desktop_startup` 与 `smoke-test.mjs`，完整 Rust 套件仍由主 CI 运行，矩阵不重复全部 targets。

## 已验证的本地场景

- 生产前端、health、RPC、动态端口和静态资源。
- 中文/emoji/CRLF 保存，过期磁盘基线拒写，历史快照恢复和整本导出。
- 路径越界拒绝；缺密钥、401、坏 JSON、断线和取消生成时原稿保持不变。
- 强制结束后设置/会话/工程副本可重新打开。
- Release API 错误、已有草稿/发布版、安装包数量/名称/大小/digest 异常均阻止发布；成功流程先草稿、上传、核验再公开。

## 尚需人工完成

- [ ] Windows x64 安装、首次启动、占用端口、退出重开和旧版升级。
- [ ] macOS Apple Silicon DMG 安装、系统权限/未签名提示、重开和升级。
- [ ] Linux 三种包在干净环境安装与桌面启动。
- [ ] 真实模型配置、连接测试、生成、停止、限流和断网重试。
- [ ] 长篇连续写作、异常退出草稿恢复、磁盘空间不足与写入权限拒绝。
- [ ] 复制整个作品目录（含 `.novel/`）到新位置并实际打开验证；当前软件没有一键完整备份/恢复。

在这些项目完成前，不应把候选版当成承载唯一原稿的稳定版。
