// Astro 配置 —— 湖南易采通供应链有限公司官网（easell.com）
// 纯静态 SSG；中文站面向百度 + 微信生态；GitHub 推送 → Cloudflare Pages 自动构建
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://www.easell.com',
  trailingSlash: 'always',
  build: { format: 'directory', inlineStylesheets: 'always' },
  integrations: [
    sitemap({
      filter: (page) => !page.includes('404'),
      serialize(item) {
        // lastmod 用「内容最后更新时间」而非构建时间：
        // 用构建时间等于每次部署都告诉搜索引擎全站更新，会稀释抓取优先级。
        item.lastmod = '2026-11-14';
        const path = item.url.replace('https://www.easell.com', '') || '/';
        if (path === '/') item.priority = 1.0;
        else if (path.startsWith('/products')) item.priority = 0.9;
        else if (['/quality/', '/model/', '/inspection/', '/policy/'].includes(path)) item.priority = 0.8;
        else item.priority = 0.7;
        item.changefreq = path === '/news/' ? 'weekly' : 'monthly';
        return item;
      },
    }),
  ],
});
