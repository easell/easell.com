#!/bin/bash
# certbot 续期成功后的自动生效钩子
# 没有这个钩子，nginx 会继续使用启动时加载的旧证书，直到下次手动 reload —— 这是最常见的"续了白发"。
set -uo pipefail
LOG=/var/log/ssl-guard.log

if nginx -t >/dev/null 2>&1; then
  if systemctl reload nginx; then
    echo "$(date '+%F %T') deploy-hook: 续期后已重载 nginx（${RENEWED_LINEAGE:-unknown}）" >> "$LOG"
  else
    echo "$(date '+%F %T') deploy-hook: 重载 nginx 失败（${RENEWED_LINEAGE:-unknown}）" >> "$LOG"
    exit 1
  fi
else
  # 配置语法有问题时宁可不重载，也不要让站点挂掉
  echo "$(date '+%F %T') deploy-hook: nginx -t 未通过，跳过重载（${RENEWED_LINEAGE:-unknown}）" >> "$LOG"
  exit 1
fi
