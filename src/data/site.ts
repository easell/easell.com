// 站点常量 —— 全站唯一信息源
// 只收录已核实事实（见 docs/01-事实底座与证据链 v2，✅ 项）；⚠️ 项一律以注释留白，不渲染。
// 站点常量 —— 全站唯一信息源，域名 easell.com
export const SITE = {
  name: '易采通',
  legalName: '湖南易采通供应链有限公司',
  url: 'https://www.easell.com',
  tagline: '湖南省集采集供平台',
  shortDesc:
    '易采通是湖南省集采集供平台，由湖南省循环经济研究会可降解塑料产业创新专委会监管，主打全生物降解纸杯、打包盒、垃圾袋、购物袋、刀叉勺、吸管等一次性可降解餐饮具与制品，统一监管、统一采购、统一仓储、统一配送，每件产品可溯源。',
  // 统一社会信用代码（营业执照正本转录，已核实）
  uscc: '91430104MABEXYD64',
  // 注册地址（营业执照口径）
  address: '湖南省长沙市岳麓区学士街道学华村碧桂园（智慧园）30 栋 102',
  phone: '0731-88766800',
  phoneNote: '服务热线',
  // 备案号：旧站阿里云备案，ECS 2025-08-13 到期后接入已失效，站现托管于 Cloudflare（境外节点，无需/无法备案）。
  // 按 2026-11-14 裁定（方案 A：维持 Cloudflare 托管），暂不展示备案号，页脚改展示可核验的统一社会信用代码。
  // 若日后核实在工信部备案系统中仍有效（beian.miit.gov.cn 查 easell.com），把号码填回此字段即恢复展示。
  icp: '',
  groupUrl: 'https://yuhao.group',
  founded: '2022-09-01',
} as const;

export const NAV = [
  { href: '/products/', label: '产品中心' },
  { href: '/quality/', label: '溯源与品控' },
  { href: '/model/', label: '集采集供' },
  { href: '/inspection/', label: '核查实录' },
  { href: '/policy/', label: '禁塑政策' },
  { href: '/news/', label: '行业动态' },
  { href: '/dealers/', label: '经销合作' },
  { href: '/about/', label: '关于易采通' },
] as const;
