# easell.com 迁回阿里云 · 执行手册（方案 B，2026-11-14 裁定）

目标：把 https://www.easell.com 从 Cloudflare Pages 迁回阿里云内地节点，**保住备案
湘ICP备2022019296号-1**（已在阿里云备案系统核实：主体与网站记录均在、接入商仍为阿里云）。

## 0. 分工

| 谁 | 做什么 |
|---|---|
| 老板 | ①买服务器（下述规格）②给我 IP + root 密码（或密钥）③备案页如提示「服务器信息变更」按提示确认 |
| WorkBuddy | 部署、证书、解析切换、备案号挂回、验收、公安备案材料清单 |

## 1. 老板买服务器（规格卡死，别买错）

- 产品：**轻量应用服务器**（最便宜够用）或 ECS 经济型 e 实例
- 地域：**中国内地**任选（杭州/上海/深圳均可，湖南访问延迟差别可忽略）——**不能选香港/海外**
- 规格：2核2G 起步即可（纯静态站 + 一个 Node 小服务）
- 计费：**包年**（备案硬性要求服务器有效期内 ≥3 个月；按量付费不能用）
- 镜像：Ubuntu 22.04 或 24.04
- 带宽：固定带宽 3–5M 或按流量（静态站流量很小）
- 安全组/防火墙：放行 **80、443、22**

## 2. WorkBuddy 部署步骤（拿到 IP 后照此执行）

```bash
# 1) 上传产物与服务
ssh root@<IP> "mkdir -p /opt/easell /var/www/easell /var/www/acme"
scp -r dist/* root@<IP>:/var/www/easell/          # Astro 构建产物
scp deploy-aliyun/contact-server.cjs deploy-aliyun/nginx-easell.conf deploy-aliyun/easell-contact.service root@<IP>:/opt/easell/

# 2) 装依赖 + 起留言服务
ssh root@<IP> "apt update && apt install -y nginx nodejs npm"
ssh root@<IP> "cp /opt/easell/easell-contact.service /etc/systemd/system/ && \
  sed -i 's/填企微群机器人webhook地址/<WECOM_WEBHOOK_URL 值>/' /etc/systemd/system/easell-contact.service && \
  systemctl daemon-reload && systemctl enable --now easell-contact"
# 本机先 curl 自测：curl -s 127.0.0.1:8787/api/contact -X POST -F name=测试 -F topic=其他 -F phone=13800138000

# 3) nginx：先只启用 80 块（443 块注释掉），签证书
ssh root@<IP> "cp /opt/easell/nginx-easell.conf /etc/nginx/sites-available/easell.conf && \
  ln -sf /etc/nginx/sites-available/easell.conf /etc/nginx/sites-enabled/ && rm -f /etc/nginx/sites-enabled/default && nginx -t && systemctl reload nginx"
ssh root@<IP> "~/.acme.sh/acme.sh --issue -d easell.com -d www.easell.com --webroot -w /var/www/acme --server letsencrypt"
# （acme.sh 未装则先：curl https://get.acme.sh | sh -s email=<邮箱>）
ssh root@<IP> "mkdir -p /etc/ssl/easell && ~/.acme.sh/acme.sh --install-cert -d www.easell.com \
  --fullchain-file /etc/ssl/easell/fullchain.pem --key-file /etc/ssl/easell/key.pem \
  --reloadcmd 'systemctl reload nginx'"
# 4) 启用 443 块（去掉注释）→ nginx -t → reload → 安装续签已由 acme.sh --install-cert 自动挂 cron

# 5) HTTP-01 自测（必须从公网 HTTP 能访问 challenge 路径，此时域名还指 CF，先跳过；见 §3 顺序）
```

## 3. 切换顺序（关键，避免证书/备案核验翻车）

1. **服务器侧就绪**（§2 全部完成，先不切解析）
2. **Cloudflare DNS 改灰云**：zone easell.com → DNS → `www` 与根域两条记录：
   - 删掉指向 `easell-com.pages.dev` 的 CNAME（Proxied 橙云）
   - 新建 `www` A 记录 → 服务器 IP，**Proxy status = DNS only（灰云）**
   - 根域 A 记录同样灰云指服务器 IP（根域 301→www 由 nginx 承担）
   - Cloudflare 的 SSL/Always Use HTTPS/重定向规则此时已无意义，留着不影响
3. **验证** HTTP-01 证书路径可访问 → `curl -4 --noproxy '*' https://www.easell.com/` 200
4. **备案号挂回**：`src/data/site.ts` → `icp: '湘ICP备2022019296号-1'` → `npm run build` → 产物重新 scp 到服务器（页脚自动显示备案号，链工信部）
5. **留言实测**：线上表单提交一条 → 企微群应收到（同一 webhook）
6. **公安联网备案**：上线后 30 日内，全国互联网安全管理服务平台（beian.mps.gov.cn）提交主体+网站，通过后页脚追加公安备案号（代码里再加一行）

## 4. 回滚方案

解析改回 CF（www CNAME→easell-com.pages.dev 橙云）即恢复原状，CF Pages 项目保留未动，
`easell-com.pages.dev` 一直在。切换过程网站中断时间 ≈ DNS 生效时间（几分钟）。

## 5. 迁移后各系统状态

| 系统 | 迁移后 |
|---|---|
| 生产站 | 阿里云 ECS（nginx 静态 + Node 留言服务） |
| CF Pages `easell-com.pages.dev` | 保留为预览/备用（不挂备案号） |
| CF DNS | 保留仅解析（灰云） |
| GitHub 仓库 | 保留（版本管理与预览构建） |
| 留言 webhook | 同一个企微群机器人（三站共用） |
| 月度行业动态自动化 | 部署目标改为「push GitHub → CF 预览 + scp 到 ECS」——切换完成后需更新 automation prompt |

## 6. 备案维持要点（长期）

- 域名解析**长期指向阿里云内地节点**（不要长期挂 CF 橙云，否则核查判定接入不符）
- 备案页若提示主体/负责人信息变更（如负责人手机号）→ 及时在阿里云做「变更备案」
- 网站内容与备案名称（湖南易采通）一致性没问题；底部备案号+链接工信部为必备
