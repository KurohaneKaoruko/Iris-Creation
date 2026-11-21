#!/bin/sh
# 生成 htpasswd 后启动 nginx。凭据来自环境变量：
#   IRIS_AUTH_USER     （默认 iris）
#   IRIS_AUTH_PASSWORD （必填，长度 >= 8）
set -eu

user="${IRIS_AUTH_USER:-iris}"
pass="${IRIS_AUTH_PASSWORD:-}"
if [ -z "$pass" ] || [ "${#pass}" -lt 8 ]; then
  echo "[entrypoint] IRIS_AUTH_PASSWORD 必须设置且至少 8 个字符" >&2
  exit 1
fi

#    worker 进程以 nginx 用户运行，需要可读
printf '%s:%s\n' "$user" "$(openssl passwd -apr1 "$pass")" > /etc/nginx/htpasswd
chmod 644 /etc/nginx/htpasswd

exec nginx -g 'daemon off;'
