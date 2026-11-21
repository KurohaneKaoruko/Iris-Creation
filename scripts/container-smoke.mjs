#!/usr/bin/env node
/**
 * 容器部署验证：对已启动的 deploy compose 栈做端到端检查。
 *
 * 用法：node scripts/container-smoke.mjs [baseUrl] [user] [password]
 *   baseUrl 默认 http://127.0.0.1:8080（nginx 入口）
 *   凭据默认取 IRIS_AUTH_USER / IRIS_AUTH_PASSWORD
 *
 * 检查项（对应 deploy/README.md 的验收口径）：
 *   1. /api/health 经 nginx 可达（带凭据）
 *   2. Basic Auth：无凭据必须 401
 *   3. RPC：Host/Origin 改写后 ping → set_workspace(/works/_smoke) → list_workspace_tree → 恢复原工作区
 *   4. WebSocket /ws：经 nginx upgrade 透传可建连
 *   5. SPA 静态资源：/ 返回 index.html
 *   6. 容器文件边界：RPC 越界路径被拒（checked_workspace_path 生效）
 *   7. 静态资源缓存头存在（Cache-Control 由 iris 中间件附加）
 * WebSocket 用裸 Upgrade 握手验证（Node 内置 WebSocket 不支持自定义 Authorization 头）。
 */
import crypto from 'node:crypto';
import net from 'node:net';

const baseArg = process.argv[2] || 'http://127.0.0.1:8080';
const user = process.argv[3] || process.env.IRIS_AUTH_USER || 'iris';
const pass = process.argv[4] || process.env.IRIS_AUTH_PASSWORD || '';
if (!pass) {
  console.error('需要密码：第 3 参或 IRIS_AUTH_PASSWORD');
  process.exit(2);
}
const base = baseArg.replace(/\/+$/, '');
const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

let failed = 0;
const ok = (name) => console.log(`  ok ${name}`);
const fail = (name, detail) => { failed++; console.error(`  FAIL ${name}: ${detail}`); };

async function rpc(command, args) {
  const res = await fetch(`${base}/api/rpc/${command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify(args ?? {}),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

// 1. health
{
  const res = await fetch(`${base}/api/health`, { headers: { Authorization: auth } });
  if (res.status === 200) ok('health 200');
  else fail('health', `status=${res.status}`);
}
// 2. 401 without creds
{
  const res = await fetch(`${base}/api/health`);
  if (res.status === 401) ok('basic auth 401');
  else fail('basic auth', `无凭据 status=${res.status}`);
}
// 5. SPA index
{
  const res = await fetch(`${base}/`, { headers: { Authorization: auth } });
  const html = await res.text();
  if (res.status === 200 && /<div id="root">/.test(html)) ok('SPA index');
  else fail('SPA index', `status=${res.status}`);
}
// 7. 静态资源缓存头
{
  const res = await fetch(`${base}/`, { headers: { Authorization: auth } });
  if ((res.headers.get('cache-control') ?? '').length > 0) ok(`静态资源 Cache-Control: ${res.headers.get('cache-control')}`);
  else fail('缓存头', '响应无 Cache-Control');
}
// 3. RPC 往返（ping → set_workspace → tree → 恢复）
{
  const pong = await rpc('ping', {});
  if (pong.status === 200 && pong.body?.ok === 'pong') ok('RPC ping');
  else fail('RPC ping', `status=${pong.status} body=${JSON.stringify(pong.body).slice(0, 120)}`);

  const prev = await rpc('get_last_workspace', {});
  const prevRoot = prev.body?.ok?.root ?? prev.body?.ok?.path ?? null;

  const ws = await rpc('set_workspace', { path: '/works/_smoke' });
  if (ws.status === 200 && ws.body?.ok) ok(`set_workspace(/works/_smoke)：${JSON.stringify(ws.body.ok).slice(0, 80)}`);
  else fail('set_workspace', `status=${ws.status} body=${JSON.stringify(ws.body).slice(0, 120)}（若目录不存在，先在宿主机 deploy/works/ 下创建 _smoke/）`);

  const tree = await rpc('list_workspace_tree', { maxDepth: 2 });
  if (tree.status === 200 && tree.body?.ok) ok('list_workspace_tree 200');
  else fail('list_workspace_tree', `status=${tree.status} body=${JSON.stringify(tree.body).slice(0, 120)}`);

  if (prevRoot) {
    const restore = await rpc('set_workspace', { path: prevRoot });
    if (restore.status === 200) ok(`恢复原工作区 ${prevRoot}`);
    else fail('恢复工作区', `status=${restore.status}`);
  }
}
// 6. RPC 拒绝越界路径
{
  const r = await rpc('read_text', { path: '../../../etc/passwd', workspaceRoot: '/works/_smoke' });
  const bodyText = JSON.stringify(r.body ?? '');
  const rejected = r.status !== 200
    || typeof r.body?.err === 'string'
    || !bodyText.includes('root:');
  if (rejected) ok('越界路径被拒');
  else fail('越界路径', `status=${r.status} body=${bodyText.slice(0, 120)}`);
}
// 4. WebSocket：裸 Upgrade 握手验证全链路（nginx 认证 + upgrade 透传 + iris origin_allowed）；
//    101 即握手成功。仅支持 http（局域网部署形态），https 需自行扩展 TLS 层。
await new Promise((resolve) => {
  const url = new URL(base);
  if (url.protocol === 'https:') { fail('WebSocket', 'https 未支持，请用 http 入口验证'); resolve(); return; }
  const req = net.connect({ host: url.hostname, port: Number(url.port) || 80 });
  const key = Buffer.from(crypto.randomUUID()).toString('base64');
  let head = '';
  req.setTimeout(5000, () => { fail('WebSocket', '5s 超时'); req.destroy(); resolve(); });
  req.on('error', (e) => { fail('WebSocket', e.message); resolve(); });
  req.on('data', (chunk) => {
    head += chunk.toString('latin1');
    const idx = head.indexOf('\r\n\r\n');
    if (idx === -1) return;
    const statusLine = head.slice(0, head.indexOf('\r\n'));
    if (statusLine.includes(' 101 ')) ok('WebSocket /ws 握手 101');
    else fail('WebSocket 握手', statusLine);
    req.destroy();
    resolve();
  });
  req.on('ready', () => {
    req.write(
      `GET /ws HTTP/1.1\r\n` +
      `Host: ${url.host}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `Authorization: ${auth}\r\n\r\n`
    );
  });
});

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
