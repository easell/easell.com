// 易采通官网在线留言接收服务（阿里云 ECS 版）
// 与 Cloudflare Pages Functions 版（functions/api/contact.js）同一套逻辑：
// honeypot 防垃圾 → 同源校验 → 字段校验 → 转发钉钉群机器人 → 中文致谢页
// 零 npm 依赖（内置 http/https/crypto + 自带 multipart 解析，表单无文件上传）。
// 运行：DINGTALK_WEBHOOK_URL='https://oapi.dingtalk.com/robot/send?access_token=...' DINGTALK_SECRET='SEC...' PORT=8787 node contact-server.cjs
// （生产用 systemd：deploy-aliyun/easell-contact.service）
// 环境变量：DINGTALK_WEBHOOK_URL / DINGTALK_SECRET 为主；WECOM_WEBHOOK_URL 为企微兜底（钉钉不可用时）

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8787);
const DING_WEBHOOK = process.env.DINGTALK_WEBHOOK_URL || '';
const DING_SECRET = process.env.DINGTALK_SECRET || '';
const WECOM_WEBHOOK = process.env.WECOM_WEBHOOK_URL || '';
const ALLOWED_HOST = process.env.ALLOWED_HOST || 'www.easell.com';
const HOTLINE = '0731-88766800';

/** 清洗转企微 markdown 的文本（与 CF 版一致） */
function clean(v, max = 500) {
  return String(v || '').replace(/[`>[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 手机或固话：138xxxx / 0731-88766800 / 073188766800 均可 */
function isPhone(v) {
  const s = String(v || '').replace(/[\s()（）-]/g, '');
  return /^1[3-9]\d{9}$/.test(s) || /^0\d{2,3}\d{7,8}$/.test(s) || /^\d{7,8}$/.test(s);
}

function page(title, body, status = 200) {
  const html = `<!doctype html>
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
<a class="btn" href="/">返回首页</a></div></body></html>`;
  return { status, html };
}

/** 极简 multipart/form-data 解析（仅文本字段，无文件） */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = '--' + (m[1] || m[2]).trim();
  const fields = {};
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const next = buf.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    // 段内容：boundary 后跳过 \r\n，到下一个 boundary 前的 \r\n
    let start = pos + boundary.length;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    let end = next - 2; // 去掉尾部 \r\n
    if (end <= start) { pos = next; continue; }
    const part = buf.slice(start, end);
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const headers = part.slice(0, headEnd).toString('utf8');
      const nameMatch = /name="([^"]*)"/i.exec(headers);
      if (nameMatch) {
        fields[nameMatch[1]] = part.slice(headEnd + 4).toString('utf8');
      }
    }
    pos = next;
  }
  return fields;
}

/** 通用 https POST JSON，返回解析后的响应对象 */
function postJson(urlStr, payload) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const body = JSON.stringify(payload);
      const req = https.request(
        { hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { resolve({ errcode: -1, raw: data.slice(0, 200) }); }
          });
        }
      );
      req.on('error', (e) => resolve({ errcode: -1, errmsg: e.message }));
      req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
      req.end(body);
    } catch (e) {
      resolve({ errcode: -1, errmsg: e.message });
    }
  });
}

/** 钉钉加签 URL：HMAC-SHA256(timestamp + "\n" + secret) → base64 → URLEncode（Node crypto） */
function dingSignedUrl() {
  const ts = String(Date.now());
  const sign = encodeURIComponent(
    crypto.createHmac('sha256', DING_SECRET).update(ts + '\n' + DING_SECRET).digest('base64')
  );
  return `${DING_WEBHOOK}${DING_WEBHOOK.includes('?') ? '&' : '?'}timestamp=${ts}&sign=${sign}`;
}

/** 转发到群机器人：钉钉为主，企微兜底；返回 {channel, ok} */
async function forwardMessage(content) {
  if (DING_WEBHOOK && DING_SECRET) {
    const url = dingSignedUrl();
    const j = await postJson(url, {
      msgtype: 'markdown', markdown: { title: 'Easell Contact', text: content },
    });
    if (j.errcode === 0) return { channel: 'dingtalk', ok: true, result: j };
    console.error('DINGTALK REJECTED:', JSON.stringify(j));
    if (WECOM_WEBHOOK) {
      const wj = await postJson(WECOM_WEBHOOK, { msgtype: 'markdown', markdown: { content } });
      return { channel: 'wecom-fallback', ok: wj.errcode === 0, result: wj };
    }
    return { channel: 'dingtalk', ok: false, result: j };
  }
  if (WECOM_WEBHOOK) {
    const wj = await postJson(WECOM_WEBHOOK, { msgtype: 'markdown', markdown: { content } });
    return { channel: 'wecom-fallback', ok: wj.errcode === 0, result: wj };
  }
  return { channel: 'none', ok: false, skipped: true };
}

const server = http.createServer(async (req, res) => {
  const respond = ({ status, html }) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  };

  if (req.url.split('?')[0] !== '/api/contact') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not Found');
  }
  if (req.method !== 'POST') {
    return respond({ status: 405, html: 'Method Not Allowed' });
  }

  // 防滥用基线：请求体 ≤ 64KB
  const len = Number(req.headers['content-length'] || 0);
  if (len > 64 * 1024) {
    res.writeHead(413, { 'content-type': 'text/plain' });
    return res.end('Payload Too Large');
  }

  // 同源校验：带 Origin 且 host 不符 → 403
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === ALLOWED_HOST; } catch { ok = false; }
    if (!ok) {
      return respond(page('提交被拒绝了', '<p>请从易采通官网（www.easell.com）提交留言。</p>', 403));
    }
  }

  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) {
      res.writeHead(413, { 'content-type': 'text/plain' });
      return res.end('Payload Too Large');
    }
    chunks.push(c);
  }
  const body = Buffer.concat(chunks);
  const ctype = req.headers['content-type'] || '';
  const form = /multipart\/form-data/i.test(ctype)
    ? parseMultipart(body, ctype)
    : Object.fromEntries(new URLSearchParams(body.toString('utf8')));

  if (!form) {
    return respond(page('表单读取失败', '<p>留言没能读出来，请返回上一页重新提交，或直接拨打服务热线。</p>'));
  }

  // honeypot：机器人填了隐藏字段 → 假装成功，直接丢弃
  if (String(form.website || '').trim() !== '') {
    return respond(page('已收到', '<p>您的留言已收到。</p>'));
  }

  const lead = {
    name: clean(form.name, 50),
    org: clean(form.org, 120),
    phone: clean(form.phone, 40),
    email: clean(form.email, 120),
    region: clean(form.region, 60),
    topic: clean(form.topic, 60),
    message: clean(form.message, 800),
    from: clean(form.page, 120) || '/contact/',
    ref: clean(form.ref, 300),
    trail: clean(form.trail, 500),
    receivedAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + '（北京时间）',
  };

  // 必填校验：姓名、来意、至少一个联系方式
  if (!lead.name || !lead.topic || (!lead.phone && !lead.email)) {
    return respond(page('还差一点信息',
      '<p>请返回补齐<strong>姓名</strong>、<strong>来意</strong>，并留下<strong>手机号或邮箱</strong>中的至少一项，方便我们回复你。</p>'));
  }
  if (lead.phone && !isPhone(lead.phone)) {
    return respond(page('手机号格式不对', '<p>请返回检查手机号是否填完整（11 位），或改为填写邮箱。</p>'));
  }
  if (!lead.phone && lead.email && !/.+@.+\..+/.test(lead.email)) {
    return respond(page('邮箱格式不对', '<p>请返回检查邮箱地址是否正确，或改为填写手机号。</p>'));
  }

  // 转发群机器人：钉钉为主、企微兜底（errcode!==0 → 记日志，不丢单不阻塞）
  // 溯源行：来源页必有；浏览轨迹/站外来路拿到才拼，方便按来路精准回复
  const sourceLines = [`来源页：${lead.from}`];
  if (lead.trail && lead.trail !== lead.from) sourceLines.push(`浏览轨迹：${lead.trail}`);
  if (lead.ref) sourceLines.push(`站外来路：${lead.ref}`);
  const delivery = await forwardMessage(
    `**官网在线留言 — 易采通**\n` +
    `姓名：${lead.name}\n` +
    `单位：${lead.org || '—'}\n` +
    `手机：${lead.phone || '—'}\n` +
    `邮箱：${lead.email || '—'}\n` +
    `地区：${lead.region || '—'}\n` +
    `来意：${lead.topic}\n` +
    `说明：${lead.message || '—'}\n` +
    sourceLines.join('\n') + '\n' +
    `时间：${lead.receivedAt}`
  );
  if (delivery.skipped) {
    console.log('[contact] no webhook configured. Lead:', JSON.stringify(lead));
  } else if (!delivery.ok) {
    console.error(`[contact] ${delivery.channel} forward FAILED:`, JSON.stringify(delivery.result), '— lead:', JSON.stringify(lead));
  } else {
    console.log(`[contact] ${delivery.channel} forwarded ok:`, lead.name, lead.org, lead.topic);
  }

  respond(page('留言已收到',
    '<p>我们会在<strong>一个工作日内</strong>与你联系。着急的话可以直接拨打服务热线 <strong>0731-88766800</strong>。</p>'));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[contact-server] listening on 127.0.0.1:${PORT}, webhook ${(DING_WEBHOOK || WECOM_WEBHOOK) ? 'configured' : 'NOT SET'}`);
});
