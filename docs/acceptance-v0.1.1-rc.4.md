# v0.1.1-rc.4 可用性验收

## 当前状态

候选版，不是稳定版。rc.1 与 rc.2 未产生公开包；rc.3 的 Windows/macOS 构建与 smoke 通过，但 Linux RPM 步骤失败。以本标签的 GitHub Actions 完整结论判断 rc.4 是否可下载。

## Linux RPM 的预发布版本

- Windows/macOS 和 DEB/AppImage 使用 `0.1.1-rc.4`。
- RPM 不允许 SemVer `-rc.N` 放入 RPM Version 字段。候选包元数据用 Version `0.1.1`、Release `0.rc.4`；最终版是 Release `1`，RPM 版本顺序将候选排在最终版之前。
- 本机已复现并验证 rc.3 的 DEB/RPM 生成和 RPM 元数据；AppImage 上游 `linuxdeploy` 下载在本机网络速度较慢，不能以本地超时替代 GitHub runner 的结果。
- 发布脚本检查五类正确版本/架构的安装包、SHA256SUMS 和 GitHub 返回的尺寸与 digest；校验前只建立草稿，校验通过才公开。失败不会删除或覆盖已有 Release。

## 自动门禁覆盖

主 CI 运行前端测试、版本/发布安全测试、Rust 全量测试与本机假 Provider 的真实 RPC smoke。发布矩阵分别构建 Windows、macOS 和 Linux 桌面包及服务程序，再进行真实本机服务的模拟 AI 工作流验收。

## 尚需人工验收

- [ ] Windows x64 安装、首次启动、退出重开、端口占用与旧版升级。
- [ ] macOS Apple Silicon DMG 安装、安全提示、重开与升级。
- [ ] Linux AppImage、DEB、RPM 在干净桌面系统安装和启动。
- [ ] 真实模型的设置、生成、停止、重开、限流与断网提示。
- [ ] 长篇写作、异常退出草稿恢复、磁盘空间不足与权限拒绝。
- [ ] 复制完整作品目录（含 `.novel/`）到其他位置并实际打开验证；校验清单不包含正文，不能恢复丢失稿件。

上述检查完成前，不建议把候选版当作承载唯一原稿的稳定版。
