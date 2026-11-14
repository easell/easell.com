#!/bin/bash
# ============================================================================
# ssl-guard.sh —— 证书自动续期守护（免费方案的"最后一公里"）
#
# 解决四类真实故障：
#   1. 证书到期没人续           → 剩余 < 30 天自动续期，带重试（跨境链路抖动）
#   2. 续了但 nginx 没加载      → 比对"实际下发证书序列号"与"磁盘证书序列号"
#   3. 80 口/跳转规则改动后      → 续期验证路径失效却要等到 90 天后才发现
#                                  → 每次巡检真实写文件并用 HTTP 取回验证
#   4. 失败了没人知道           → 异常推送企微群；一切正常则静默
#
# 用法：
#   ssl-guard.sh            # 巡检（定时器调用）
#   ssl-guard.sh --check    # 只检查不续期（人工排查用）
#   ssl-guard.sh --force    # 强制续期一次（验证整条链路）
# ============================================================================
set -uo pipefail

LIVE_DIR=/etc/letsencrypt/live
ACME_ROOT=/var/www/acme
LOG=/var/log/ssl-guard.log
RENEW_DAYS=30      # 剩余不足 30 天开始续（LE 官方建议 30 天）
WARN_DAYS=21       # 剩 21 天仍未成功 → 告警
CRIT_DAYS=14       # 剩 14 天仍未成功 → 紧急告警
RETRIES=4
RETRY_SLEEP=40
CONTACT_UNIT=easell-contact.service   # 复用官网留言的企微群机器人，不新增密钥

MODE="${1:-auto}"
mkdir -p "$(dirname "$LOG")"
touch "$LOG"
say() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }

# ── 企微告警出口：从留言服务的 systemd unit 里取同一个 webhook ──
webhook_url() {
  systemctl show -p Environment --value "$CONTACT_UNIT" 2>/dev/null \
    | tr ' ' '\n' \
    | sed -e 's/^"//' -e 's/"$//' \
    | sed -n 's/^WECOM_WEBHOOK_URL=//p' | head -1
}

notify() {   # $1=级别(提醒/警告/紧急) $2=标题 $3=正文
  local hook body payload
  hook=$(webhook_url)
  if [ -z "${hook:-}" ]; then say "WARN: webhook 取不到，告警仅落本地日志"; return 0; fi
  body=$(printf '**SSL %s · %s**\n> 服务器：47.104.165.13\n> %s\n> 时间：%s' \
         "$1" "$2" "$3" "$(date '+%F %T')")
  payload=$(printf '%s' "$body" | python3 -c 'import json,sys;print(json.dumps({"msgtype":"markdown","markdown":{"content":sys.stdin.read()}}))')
  if curl -s -m 15 -H 'Content-Type: application/json' -d "$payload" "$hook" 2>/dev/null | grep -q '"errcode":0'; then
    say "告警已推送企微群：$2"
  else
    say "WARN: 告警推送失败（内容已落日志）"
  fi
}

days_left() {   # $1=证书文件 → 剩余天数（-1 表示读取失败）
  local end
  end=$(openssl x509 -in "$1" -noout -enddate 2>/dev/null | cut -d= -f2)
  [ -z "$end" ] && { echo -1; return; }
  echo $(( ( $(date -d "$end" +%s 2>/dev/null || echo 0) - $(date +%s) ) / 86400 ))
}

disk_serial() { openssl x509 -in "$1" -noout -serial 2>/dev/null | cut -d= -f2; }

served_serial() {   # $1=域名 $2=ecdsa|rsa，取 nginx 对该类型客户端实际下发的证书
  local cipher=""
  [ "${2:-ecdsa}" = "rsa" ] && cipher="-tls1_2 -cipher ECDHE-RSA-AES256-GCM-SHA384"
  echo | timeout 10 openssl s_client -connect 127.0.0.1:443 -servername "$1" $cipher 2>/dev/null \
    | openssl x509 -noout -serial 2>/dev/null | cut -d= -f2
}

acme_path_ok() {   # $1=域名：真写一个文件，再从 80 口取回
  local token code f
  token="guard-$(date +%s)-$RANDOM"
  f="$ACME_ROOT/.well-known/acme-challenge/$token"
  mkdir -p "$(dirname "$f")"
  if ! echo ok > "$f" 2>/dev/null; then say "WARN: 无法写入 $ACME_ROOT"; return 1; fi
  chown www-data:www-data "$f" 2>/dev/null
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' --resolve "$1:80:127.0.0.1" \
         "http://$1/.well-known/acme-challenge/$token")
  rm -f "$f"
  [ "$code" = "200" ]
}

do_renew() {   # $1=lineage 名
  local i out force="" reason
  [ "$MODE" = "--force" ] && force="--force-renewal"
  for i in $(seq 1 "$RETRIES"); do
    say "续期尝试 $i/$RETRIES → $1 ${force:+(强制)}"
    out=$(certbot renew --cert-name "$1" $force --no-random-sleep-on-renew --non-interactive 2>&1)
    printf '%s\n' "$out" >> "$LOG"
    if grep -qE 'Congratulations|Successfully received certificate' <<<"$out"; then
      RENEW_REASON="成功"; return 0
    fi
    # 明确"未到期"也算正常（--force 场景不会走到这里）
    grep -qE 'not yet due for renewal|No renewals were attempted' <<<"$out" && { RENEW_REASON="未到期"; return 0; }

    reason=$(grep -oE 'urn:ietf:params:acme:error:[a-zA-Z]+|rateLimited|Read timed out|Connection reset|Temporary failure in name resolution' <<<"$out" | head -1)
    # 永久性错误重试无意义，立即停手并说明原因（避免把频率限制越撞越久）
    if grep -qE 'rateLimited|rejectedIdentifier|unauthorized|invalidEmail' <<<"$out"; then
      RENEW_REASON="被 CA 拒绝（${reason:-策略限制}），重试无用"
      say "  永久性错误，停止重试：${reason:-unknown}"
      return 2
    fi
    RENEW_REASON="网络/临时错误（${reason:-unknown}）"
    [ "$i" -lt "$RETRIES" ] && sleep "$RETRY_SLEEP"
  done
  return 1
}

reload_nginx() { nginx -t >/dev/null 2>&1 && systemctl reload nginx; }

# ══════════════════════════ 主流程 ══════════════════════════
say "──────── 巡检开始（模式：$MODE）────────"
problems=0
shopt -s nullglob

for dir in "$LIVE_DIR"/*/; do
  name=$(basename "$dir")
  cert="$dir/cert.pem"
  [ -f "$cert" ] || continue

  domain=$(openssl x509 -in "$cert" -noout -subject 2>/dev/null | sed 's/.*CN *= *//')
  dl=$(days_left "$cert")

  if [ "$dl" -lt 0 ]; then
    say "[$name] 证书无法解析"; notify 紧急 "$domain 证书异常" "证书文件无法解析，请人工检查 $dir"; problems=$((problems+1)); continue
  fi
  say "[$name] $domain 剩余 $dl 天"

  # ① 续期
  if [ "$MODE" = "--force" ] || { [ "$MODE" != "--check" ] && [ "$dl" -le "$RENEW_DAYS" ]; }; then
    if do_renew "$name"; then
      newdl=$(days_left "$cert")
      if [ "$newdl" -gt "$dl" ]; then
        say "[$name] 续期成功：$dl 天 → $newdl 天"
        notify 提醒 "$domain 证书已续期" "有效期延长至新到期日（剩余 $newdl 天），无需处理。"
      else
        say "[$name] 续期命令返回成功，有效期未变（可能未到期）"
      fi
    else
      say "[$name] 续期失败：${RENEW_REASON:-未知}"
      notify 紧急 "$domain 证书自动续期失败" "剩余 $dl 天。原因：${RENEW_REASON:-未知}。守护会在 6 小时后再次尝试；若持续失败请按运维文档手动兜底。"
      problems=$((problems+1))
    fi
  elif [ "$dl" -le "$WARN_DAYS" ]; then
    notify 警告 "$domain 证书临期" "剩余 $dl 天且未续期成功，请检查 certbot 日志。"
    problems=$((problems+1))
  fi

  # ② 发出的证书 = 磁盘上的证书？（防"续了没生效"）
  kind=ecdsa
  case "$name" in *-rsa) kind=rsa ;; esac
  srv=$(served_serial "$domain" "$kind")
  dsk=$(disk_serial "$cert")
  if [ -n "$srv" ] && [ "$srv" != "$dsk" ]; then
    say "[$name] 序列号不一致：对外 $srv ≠ 磁盘 $dsk → 重载 nginx"
    reload_nginx
    sleep 2
    srv=$(served_serial "$domain" "$kind")
    if [ "$srv" != "$dsk" ]; then
      notify 紧急 "$domain 证书未生效" "磁盘已是新证书，但 nginx 对外仍是旧证书，重载后仍未刷新。"
      problems=$((problems+1))
    else
      say "[$name] 重载后已一致"
    fi
  fi

  # ③ 续期验证通道是否可用（80 口 + ACME 路径未被 301/404 吃掉）
  if ! acme_path_ok "$domain"; then
    say "[$name] ACME 验证路径不可达"
    notify 警告 "$domain 续期验证通道异常" "80 端口 /.well-known/acme-challenge/ 取不回测试文件，下次续期会失败（常见原因：80 口被关、nginx 跳转规则改动）。"
    problems=$((problems+1))
  fi
done

say "──────── 巡检结束：$problems 项异常 ────────"
[ "$problems" -eq 0 ] || exit 1
exit 0
