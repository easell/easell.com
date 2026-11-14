#!/usr/bin/env python3
"""easell.com 全 Cloudflare 落地脚本

做四件事（幂等，可重复跑）：
  1. 建 zone easell.com（已存在则复用），打印分配的 NS
  2. 补 DNS：www / 根域 CNAME → easell-com.pages.dev（Proxied）
  3. 刷新 Pages 自定义域（删了重加，触发自动激活与证书签发）
  4. 开 Always Use HTTPS + SSL 严格模式 + 根域 301 到 www

token 来源（优先级）：环境变量 CLOUDFLARE_API_TOKEN → 同目录 .cf_api_token 文件
用法：python scripts/cf_setup_zone.py
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

ACCT = "bb779188139eae225f315743948dd854"
ZONE_NAME = "easell.com"
PAGES_PROJECT = "easell-com"
PAGES_HOST = "easell-com.pages.dev"
PROXIED_DOMAIN = "www." + ZONE_NAME
API = "https://api.cloudflare.com/client/v4"


def load_token() -> str:
    tok = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if tok:
        return tok
    here = os.path.dirname(os.path.abspath(__file__))
    p = os.path.join(here, ".cf_api_token")
    if os.path.exists(p):
        return open(p, encoding="utf8").read().strip()
    sys.exit("缺少 token：设置环境变量 CLOUDFLARE_API_TOKEN，或写入 scripts/.cf_api_token")


TOKEN = load_token()
H = {"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}


def api(path, method="GET", body=None):
    url = API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=H)
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        return {"HTTP_ERROR": e.code, "body": e.read().decode()[:600]}


def step(msg):
    print("\n=== " + msg)


# 0. 验证 token
step("验证 token")
v = api("/user/tokens/verify")
if "HTTP_ERROR" in v or not v.get("success"):
    sys.exit("token 校验失败：%s" % v)
print("token 有效，状态：", v["result"]["status"])

# 1. zone
step("zone " + ZONE_NAME)
zs = api("/zones?name=" + ZONE_NAME)
if "HTTP_ERROR" in zs:
    sys.exit("查询 zone 失败：%s" % zs)
zone = zs["result"][0] if zs.get("result") else None
if not zone:
    r = api("/zones", "POST", {"name": ZONE_NAME, "account": {"id": ACCT}, "type": "full", "jump_start": False})
    if "HTTP_ERROR" in r:
        sys.exit("建 zone 失败（token 需 Zone:Edit）：%s" % r)
    zone = r["result"]
    print("zone 已新建")
else:
    print("zone 已存在，复用")
zid = zone["id"]
print("zone id:", zid, "| 状态:", zone["status"])
print("NS（去注册商填这两个）:", zone.get("name_servers"))

# 2. DNS
step("DNS 记录")
existing = api(f"/zones/{zid}/dns_records?per_page=100")
names = {}
if "HTTP_ERROR" not in existing:
    for rec in existing["result"]:
        names.setdefault(rec["name"], []).append(rec)

want = [("www." + ZONE_NAME, "www"), (ZONE_NAME, "@")]
for fqdn, _label in want:
    old = names.get(fqdn, [])
    for rec in old:
        if rec["type"] in ("A", "AAAA", "CNAME") and rec["content"] != PAGES_HOST:
            d = api(f"/zones/{zid}/dns_records/{rec['id']}", "DELETE")
            print(f"  删除旧记录 {fqdn} {rec['type']} {rec['content']}: {'OK' if 'HTTP_ERROR' not in d else d}")
    hit = [r for r in old if r["type"] == "CNAME" and r["content"] == PAGES_HOST]
    if hit:
        print(f"  已存在 {fqdn} CNAME → {PAGES_HOST}")
        continue
    keep = [r for r in old if r["type"] not in ("A", "AAAA", "CNAME")]
    if keep:
        print(f"  跳过 {fqdn}（存在其它类型记录）")
        continue
    c = api(f"/zones/{zid}/dns_records", "POST",
            {"type": "CNAME", "name": fqdn, "content": PAGES_HOST, "proxied": True, "ttl": 1})
    print(f"  新建 {fqdn} CNAME → {PAGES_HOST}: {'OK' if 'HTTP_ERROR' not in c else c}")

# 3. 刷新 Pages 自定义域
step("Pages 自定义域")
for dom in (ZONE_NAME, PROXIED_DOMAIN):
    api(f"/accounts/{ACCT}/pages/projects/{PAGES_PROJECT}/domains/{dom}", "DELETE")
    r = api(f"/accounts/{ACCT}/pages/projects/{PAGES_PROJECT}/domains", "POST", {"name": dom})
    print(f"  {dom}: {'OK ' + r['result']['status'] if 'HTTP_ERROR' not in r else r}")

# 4. zone 设置
step("zone 设置")
for key, val in (("always_use_https", "on"), ("automatic_https_rewrites", "on"),
                 ("ssl", "strict"), ("min_tls_version", "1.2")):
    r = api(f"/zones/{zid}/settings/{key}", "PATCH", {"value": val})
    print(f"  {key}={val}: {'OK' if 'HTTP_ERROR' not in r else r}")

# 5. 根域 301 到 www
step("重定向规则：apex → www")
rule_body = {"rules": [{
    "action": "redirect",
    "action_parameters": {
        "from_value": {
            "status_code": 301,
            "target_url": {"expression": 'concat("https://' + PROXIED_DOMAIN + '", http.request.uri.path)'},
            "preserve_query_string": True,
        }
    },
    "expression": '(http.host eq "' + ZONE_NAME + '")',
    "description": "apex 301 to www",
    "enabled": True,
}]}
r = api(f"/zones/{zid}/rulesets/phases/http_request_dynamic_redirect/entrypoint", "PUT", rule_body)
print("  规则:", "OK" if "HTTP_ERROR" not in r else r)

step("完成")
print("下一步：把上面两个 NS 填到注册商（阿里云 → 域名 → DNS 修改）；zone 变 active 后通知我跑线上验收")
