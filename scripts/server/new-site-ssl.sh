#!/bin/bash
# ============================================================================
# new-site-ssl.sh —— 给新站点签发免费证书（沿用同一套机制，一条命令搞定）
#
# 用法： new-site-ssl.sh <主域名> [附加域名...]
# 例：   new-site-ssl.sh molyn.net www.molyn.net
#
# 前置条件（缺一不可，脚本会先自检）：
#   1. 域名 A 记录已指向本机
#   2. 该域名的 nginx server 块已含 80 端口的 ACME 路径：
#        location /.well-known/acme-challenge/ { root /var/www/acme; }
#      且该 location 在 80→443 全站 301 之前（否则验证会被跳走）
#   3. 80 端口对公网开放
#
# 产出：ECDSA（主用）+ RSA 2048（老设备兜底）两张证书，90 天，自动续期
# 之后把脚本打印的 nginx 片段贴进对应站点配置即可。
# ============================================================================
set -uo pipefail

DOMAIN="${1:-}"
shift || true
EXTRA=("$@")
if [ -z "$DOMAIN" ]; then
  echo "用法: $0 <主域名> [附加域名...]"; exit 1
fi

ACME_ROOT=/var/www/acme
NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}.conf"

echo "── 1/4 地址检查 ──"
IP=$(curl -s -m 10 https://api.ipify.org || echo "")
DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}')
echo "  本机公网 IP : ${IP:-取不到}"
echo "  域名解析 IP : ${DNS_IP:-解析失败}"
if [ -n "$IP" ] && [ "$DNS_IP" != "$IP" ]; then
  echo "  ✗ 解析未指向本机，先改 A 记录再签（否则验证必然失败）"; exit 1
fi

echo "── 2/4 ACME 通道检查 ──"
mkdir -p "$ACME_ROOT/.well-known/acme-challenge"
TOK="precheck-$RANDOM"; echo ok > "$ACME_ROOT/.well-known/acme-challenge/$TOK"
chown -R www-data:www-data "$ACME_ROOT"
CODE=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://$DOMAIN/.well-known/acme-challenge/$TOK")
rm -f "$ACME_ROOT/.well-known/acme-challenge/$TOK"
if [ "$CODE" != "200" ]; then
  echo "  ✗ 公网取回验证文件返回 $CODE（期望 200）。检查：80 口是否放行、nginx 是否已配 ACME location、是否被 301 跳走。"
  exit 1
fi
echo "  ✓ 通道正常"

ARGS=(-d "$DOMAIN")
for d in "${EXTRA[@]:-}"; do [ -n "$d" ] && ARGS+=(-d "$d"); done

echo "── 3/4 签发 ECDSA 证书 ──"
for i in 1 2 3 4; do
  if certbot certonly --webroot -w "$ACME_ROOT" "${ARGS[@]}" --cert-name "$DOMAIN" \
       --key-type ecdsa --non-interactive --agree-tos --no-eff-email 2>&1 | tee /tmp/issue.log | tail -3 \
       && grep -qE 'Successfully received|not yet due' /tmp/issue.log; then
    echo "  ✓ ECDSA 完成"; break
  fi
  echo "  第 $i 次失败，20 秒后重试…"; sleep 20
  [ "$i" = 4 ] && { echo "  ✗ ECDSA 签发失败，见 /var/log/letsencrypt"; exit 1; }
done

echo "── 4/4 签发 RSA 备用证书 ──"
for i in 1 2 3; do
  if certbot certonly --webroot -w "$ACME_ROOT" "${ARGS[@]}" --cert-name "${DOMAIN}-rsa" \
       --key-type rsa --rsa-key-size 2048 --non-interactive --agree-tos --no-eff-email 2>&1 | tee /tmp/issue-rsa.log | tail -3 \
       && grep -qE 'Successfully received|not yet due' /tmp/issue-rsa.log; then
    echo "  ✓ RSA 完成"; RSA=1; break
  fi
  echo "  第 $i 次失败，20 秒后重试…"; sleep 20; RSA=0
done

cat <<EOF

════════ 把下面这段贴进 $NGINX_CONF 的 443 server 块 ════════
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
EOF
[ "${RSA:-0}" = "1" ] && cat <<EOF
    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}-rsa/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}-rsa/privkey.pem;
EOF
cat <<EOF

然后：nginx -t && systemctl reload nginx
续期、生效校验、到期告警都会由 ssl-guard.timer 自动接管，无需再配。
════════════════════════════════════════════════════════════
EOF
