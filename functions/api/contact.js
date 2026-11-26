// Cloudflare Pages Function — POST /api/contact（易采通官网在线留言接收端点）
// 与 YUHAO / KYSON 同一套留言系统（老板裁定「用同一套留言就行」）：
// honeypot 防垃圾 → 同源校验 → 字段校验 → 转发钉钉群机器人 → 中文致谢页
// 字段为易采通访客口径：姓名/单位/手机/邮箱/地区/来意/说明（政企与零售都走这一个口）。
// 环境变量（Pages 控制台 Settings → Variables，五站同名同值，一个群统接）：
//   DINGTALK_WEBHOOK_URL = 钉钉群机器人 webhook（含 access_token）
//   DINGTALK_SECRET      = 钉钉加签密钥（SEC 开头）
//   WECOM_WEBHOOK_URL    = 企微兜底（仅钉钉未配置/被拒时用）
// 未配置 webhook 时：仍返回致谢页，并把留言 console.log 到 Pages 部署日志，不阻塞访客。

/** 清洗转群机器人 markdown 的文本：去反引号/方括号/引用符（防注入）、压空白、截断 */
function clean(v, max = 500) {
  return String(v || '')
    .replace(/[`>[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 钉钉加签：HMAC-SHA256(timestamp + "\n" + secret) → base64 → URLEncode（Web Crypto） */
async function dingSignUrl(webhook, secret) {
  const ts = String(Date.now());
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(ts + '\n' + secret));
  let bin = '';
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return `${webhook}${webhook.includes('?') ? '&' : '?'}timestamp=${ts}&sign=${encodeURIComponent(btoa(bin))}`;
}

/** 企微兜底转发（仅钉钉不可用时），避免切换期丢单 */
async function forwardWecom(webhook, content, lead) {
  try {
    const r = await fetch(webhook, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.errcode === 0) console.log('[fallback] WECOM forwarded ok');
    else console.error('WECOM fallback REJECTED:', JSON.stringify(j), '— lead:', JSON.stringify(lead));
  } catch (e) {
    console.error('WECOM fallback failed:', e && e.message, '— lead:', JSON.stringify(lead));
  }
}

function page(title, body, status = 200) {
  return new Response(
    `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}｜易采通</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background:#fdf6f0; color:#2b2b2b; display:flex; align-items:center; justify-content:center;
         min-height:100vh; margin:0; padding:20px; }
  .card { background:#fff; border:1px solid #f0dccd; border-radius:12px; padding:44px 40px; max-width:480px; text-align:center; }
  h1 { color:#a84a08; font-size:24px; margin:0 0 14px; }
  p { color:#6b6b6b; line-height:1.9; margin:0 0 22px; font-size:15px; }
  a.btn { display:inline-block; background:#f57921; color:#fff; padding:12px 26px; border-radius:8px;
          text-decoration:none; font-weight:600; }
</style>
</head>
<body><div class="card"><h1>${title}</h1>${body}
<a class="btn" href="/">返回首页</a></div></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}

/** 手机或固话：138xxxx / 0731-88766800 / 073188766800 均可 */
function isPhone(v) {
  const s = String(v || '').replace(/[\s()（）-]/g, '');
  return /^1[3-9]\d{9}$/.test(s) || /^0\d{2,3}\d{7,8}$/.test(s) || /^\d{7,8}$/.test(s);
}

export async function onRequestPost({ request, env }) {
  // 防滥用基线：请求体 ≤ 64KB（正常表单 < 5KB）
  const len = Number(request.headers.get('content-length') || 0);
  if (len > 64 * 1024) return new Response('Payload Too Large', { status: 413 });

  // 同源校验：跨站 POST 直接 403
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) {
        return page('提交被拒绝了', '<p>请从易采通官网（www.easell.com）提交留言。</p>', 403);
      }
    } catch {
      return page('提交被拒绝了', '<p>请从易采通官网（www.easell.com）提交留言。</p>', 403);
    }
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return page('表单读取失败', '<p>留言没能读出来，请返回上一页重新提交，或直接拨打服务热线。</p>');
  }

  // honeypot：机器人填了隐藏字段 → 假装成功，直接丢弃
  if (String(form.get('website') || '').trim() !== '') {
    return page('已收到', '<p>您的留言已收到。</p>');
  }

  const lead = {
    name: clean(form.get('name'), 50),
    org: clean(form.get('org'), 120),
    phone: clean(form.get('phone'), 40),
    email: clean(form.get('email'), 120),
    region: clean(form.get('region'), 60),
    topic: clean(form.get('topic'), 60),
    message: clean(form.get('message'), 800),
    from: clean(form.get('page'), 120) || '/contact/',
    ref: clean(form.get('ref'), 300),
    trail: clean(form.get('trail'), 500),
    receivedAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + '（北京时间）',
  };

  // 必填校验：姓名、来意、至少一个联系方式（手机或邮箱）
  if (!lead.name || !lead.topic || (!lead.phone && !lead.email)) {
    return page(
      '还差一点信息',
      '<p>请返回补齐<strong>姓名</strong>、<strong>来意</strong>，并留下<strong>手机号或邮箱</strong>中的至少一项，方便我们回复你。</p>'
    );
  }
  if (lead.phone && !isPhone(lead.phone)) {
    return page('手机号格式不对', '<p>请返回检查手机号是否填完整（11 位），或改为填写邮箱。</p>');
  }
  if (!lead.phone && lead.email && !/.+@.+\..+/.test(lead.email)) {
    return page('邮箱格式不对', '<p>请返回检查邮箱地址是否正确，或改为填写手机号。</p>');
  }

  // 转发钉钉群机器人（加签 + markdown）；钉钉不可用时退回企微兜底
  const content =
    `**官网在线留言 — 易采通**\n` +
    `姓名：${lead.name}\n` +
    `单位：${lead.org || '—'}\n` +
    `手机：${lead.phone || '—'}\n` +
    `邮箱：${lead.email || '—'}\n` +
    `地区：${lead.region || '—'}\n` +
    `来意：${lead.topic}\n` +
    `说明：${lead.message || '—'}\n` +
    [`来源页：${lead.from}`, lead.trail && lead.trail !== lead.from ? `浏览轨迹：${lead.trail}` : '', lead.ref ? `站外来路：${lead.ref}` : ''].filter(Boolean).join('\n') + '\n' +
    `时间：${lead.receivedAt}`;
  const dingHook = env && env.DINGTALK_WEBHOOK_URL;
  const dingSecret = env && env.DINGTALK_SECRET;
  let dingOk = false;
  if (dingHook && dingSecret) {
    try {
      const url = await dingSignUrl(dingHook, dingSecret);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { title: 'Easell Contact', text: content } }),
      });
      const result = await r.json().catch(() => ({}));
      if (result.errcode === 0) {
        dingOk = true;
        console.log('[contact] DINGTALK ok:', lead.name, lead.org, lead.topic);
      } else {
        console.error('DINGTALK REJECTED:', JSON.stringify(result), '— lead:', JSON.stringify(lead));
      }
    } catch (e) {
      console.error('DINGTALK failed:', e && e.message, '— lead:', JSON.stringify(lead));
    }
  }
  if (!dingOk) {
    const wecomHook = env && env.WECOM_WEBHOOK_URL;
    if (wecomHook) await forwardWecom(wecomHook, content, lead);
    else console.log('[contact] no webhook configured. Lead:', JSON.stringify(lead));
  }

  return page(
    '留言已收到',
    '<p>我们会在<strong>一个工作日内</strong>与你联系。着急的话可以直接拨打服务热线 <strong>0731-88766800</strong>。</p>'
  );
}

// GET /api/contact → 405
export function onRequestGet() {
  return new Response('Method Not Allowed', { status: 405 });
}
