# deploy/

Iris-Creation 的容器化部署：**nginx（Basic Auth）→ iris-creation-server**，面向局域网单用户场景。

## 文件

| 文件 | 作用 |
|---|---|
| `Dockerfile.iris` | 瘦运行镜像：release 二进制 + `webui/dist`（无需 GTK/webkit，见下） |
| `Dockerfile.proxy` | nginx 入口镜像 |
| `nginx.conf` | Basic Auth、Host/Origin 改写、WS upgrade、17m body 上限 |
| `nginx-entrypoint.sh` | 从 `IRIS_AUTH_USER`/`IRIS_AUTH_PASSWORD` 生成 htpasswd |
| `compose.yaml` | 编排两个服务；iris 不直接暴露端口 |
| `.env.example` | 凭据模板（复制为 `.env`） |

## 为什么需要 nginx 改写 Host

`src-tauri/src/server/mod.rs` 的 `origin_allowed` 强制 Host/Origin 必须是 `127.0.0.1`/`localhost`（防 DNS rebinding 的设计）。局域网浏览器访问 `http://192.168.x.x:8080` 时 Host 不是本机地址，RPC 与 WS 会被 403。nginx 把 Host 改写为 `127.0.0.1` 并清空 Origin 后转发，服务端校验照常通过。

## 为什么运行镜像不需要 GTK/webkit

`iris-creation-server` 与桌面壳共用 `iris_creation` lib，但 server 路径不引用 `TauriEventSink`/GUI 符号；release 链接（`--as-needed`）后 `ldd` 仅剩 `libc/libm/libgcc_s`，无需 GTK/webkit。

基础镜像用 `debian:trixie-slim`：编译机 glibc 较新（二进制最高引用 `GLIBC_2.39` 符号），bookworm(2.36) 跑不起来，trixie(2.41) 满足。若在旧系统上编译（glibc ≤ 2.36），可换回 `debian:bookworm-slim`。

> 注意：若未来 server 代码开始直接引用 tauri GUI 类型，镜像需要重评估。

## 部署步骤

```bash
# 1. 构建产物（在仓库根目录）
pnpm --dir webui run build
cargo build --manifest-path src-tauri/Cargo.toml --release --bin iris-creation-server

# 2. 凭据与卷目录
cd deploy
cp .env.example .env
# 编辑 .env：IRIS_AUTH_PASSWORD 至少 8 位（openssl rand -base64 18）
mkdir -p works data && chmod 700 data
# 卷属主必须与容器内 iris 用户（uid 1000）一致，否则书架状态/设置写入会 Permission denied：
sudo chown -R 1000:1000 works data && sudo chmod 1000:1000 .

# 3. 起服务
docker compose up -d --build

# 4. 验证
curl -u iris:<密码> http://127.0.0.1:8080/api/health
#   → {"ok":true,"app":"iris-creation-server"}
# 无凭据应得 401：
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/health

# 端到端冒烟（health/401/RPC 往返/WS 握手/SPA/越界拒绝/缓存头，9 项；
# set_workspace 需要 deploy/works/_smoke 目录存在；在仓库根目录运行）：
mkdir -p deploy/works/_smoke
node scripts/container-smoke.mjs http://127.0.0.1:8080 iris '<密码>'
```

浏览器访问 `http://<局域网IP>:8080`，「打开作品」选择 `/works` 下的目录（或先把现有作品目录拷入 `deploy/works/`）。

## 数据与备份

| 卷 | 内容 | 备份策略 |
|---|---|---|
| `deploy/works/` | 作品库（正文/历史/分镜） | 整目录复制（`.novel/` 与 `creative/` 一起拷） |
| `deploy/data/` | 设置、**API Key**、会话、书架状态 | 整目录复制；`data/secrets/secrets.json` 在 Linux 上仅 Base64 非加密 |

升级：重新构建产物后 `docker compose up -d --build`，卷不动。

## 常见问题

- **书架/设置写入报 `Permission denied`**：卷属主不是容器内 uid 1000。按部署步骤 `chown -R 1000:1000 works data`，并确认 `deploy/` 目录自身属主（容器需要遍历它）。
- **忘记密码**：编辑 `deploy/.env` 后 `docker compose up -d proxy`（entrypoint 会重新生成 htpasswd）。

## 已知边界（与上游验收口径一致）

- **单用户**：AppState 全局唯一，多人并发打开不同作品会互相踢工作区
- **无 HTTPS**：局域网明文 + Basic Auth；跨公网使用需自行加 TLS 层（或套 VPN）
- RPC 的 16 MiB body 上限在 nginx 侧配置为 17m，导入大图会同时受 iris 的 10 MB 媒体上限约束
- 未验收项不变：真实付费模型、恶意多进程并发换目录等仍按项目文档执行
- `origin_allowed` 改写意味着 DNS rebinding 防线转移到了 nginx：不要把 8080 暴露到不可信网络
