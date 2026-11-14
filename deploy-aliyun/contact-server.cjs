// 易采通官网在线留言接收服务（阿里云 ECS 版）
// 与 Cloudflare Pages Functions 版（functions/api/contact.js）同一套逻辑：
// honeypot 防垃圾 → 同源校验 → 字段校验 → 转发企业微信群机器人 → 中文致谢页
// 零 npm 依赖（内置 http/https + 自带 multipart 解析，表单无文件上传）。
// 运行：WECOM_WEBHOOK_URL='https://qyapi.weixin.qq.com/...' PORT=8787 node contact-server.js
// （生产用 systemd：deploy-aliyun/easell-contact.service）

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8787);
const WEBHOOK = process.env.WECOM_WEBHOOK_URL || '';
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

/** 转发企业微信群机器人（markdown），errcode!==0 视为失败 */
function forwardToWecom(content) {
  return new Promise((resolve) => {
    if (!WEBHOOK) return resolve({ skipped: true });
    try {
      const u = new URL(WEBHOOK);
      const body = JSON.stringify({ msgtype: 'markdown', markdown: { content } });
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

  // 转发企微（errcode!==0 → 记日志，不丢单不阻塞）
  const result = await forwardToWecom(
    `**官网在线留言 — 易采通**\n` +
    `姓名：${lead.name}\n` +
    `单位：${lead.org || '—'}\n` +
    `手机：${lead.phone || '—'}\n` +
    `邮箱：${lead.email || '—'}\n` +
    `地区：${lead.region || '—'}\n` +
    `来意：${lead.topic}\n` +
    `说明：${lead.message || '—'}\n` +
    `来源页：${lead.from}\n` +
    `时间：${lead.receivedAt}`
  );
  if (result.skipped) {
    console.log('[contact] WECOM_WEBHOOK_URL not set. Lead:', JSON.stringify(lead));
  } else if (result.errcode !== 0) {
    console.error('WECOM forward REJECTED:', JSON.stringify(result), '— lead:', JSON.stringify(lead));
  } else {
    console.log('[contact] forwarded ok:', lead.name, lead.org, lead.topic);
  }

  respond(page('留言已收到',
    '<p>我们会在<strong>一个工作日内</strong>与你联系。着急的话可以直接拨打服务热线 <strong>0731-88766800</strong>。</p>'));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[contact-server] listening on 127.0.0.1:${PORT}, webhook ${WEBHOOK ? 'configured' : 'NOT SET'}`);
});
