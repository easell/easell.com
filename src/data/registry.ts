// 已备案企业名录 —— 唯一信息源
// 数据来源：湖南省可降解塑料信息管理平台（kjjsl.cnhnxhjj.com）导出备份
//   1) 「溯源管理备份(1)」24 份企业档案页（企业自填 + 平台审核）
//   2) 溯源管理数据备份.xlsx「生产企业」「报备企业」两表交叉核对
// 口径（重要，勿改）：
//   - 只收录平台内状态为「正常」、且导出目录内有完整企业档案页的生产企业；共 23 家
//   - 只公开 4 类字段：企业名称、备案产品（品牌）、备案产地（省/市）、产品备案项数
//   - 联系人、电话、法人、身份证、注册资本、营业额、员工数、厂房数 一律不上站
//   - 「湖南低碳壹族环保科技有限公司」为经销备案（经销商表口径），不列入生产企业名录
//   - 待确认可补入者（平台状态正常，但本次导出无企业档案页）：湖南江南生态农业科技开发有限公司、
//     湖南航天磁电有限责任公司、长沙世通纸塑箸业有限公司 —— 老板确认后再入表

export type RegistryEntry = {
  name: string;
  /** 备案产品（品牌）原文；企业未填品牌时用 — */
  products: string;
  province: string;
  city: string;
  /** 该企业在平台的产品备案条目数（仅「审核通过」） */
  filings: number;
};

export const REGISTRY: RegistryEntry[] = [
  { name: '长沙铭凯纸制品有限公司', products: '翠上、Terrax、Mingkay', province: '湖南', city: '长沙', filings: 1 },
  { name: '湖南省维克奇纸塑包装有限公司', products: '维克奇纸杯、纸碗、餐盒', province: '湖南', city: '长沙', filings: 1 },
  { name: '湖南卡普包装有限公司', products: '—', province: '湖南', city: '长沙', filings: 1 },
  { name: '湖南振亚新材料科技有限公司', products: '全生物降解刀叉料、餐盒料、吹膜料、吸管料', province: '湖南', city: '长沙', filings: 0 },
  { name: '湖南科天新材料有限公司', products: '生物降解材料购物袋（科天）', province: '湖南', city: '长沙', filings: 0 },
  { name: '湖南绿塑环保科技有限公司', products: '—', province: '湖南', city: '长沙', filings: 1 },
  { name: '湖南荣宸塑业有限公司', products: '五味鲜牌购物袋', province: '湖南', city: '长沙', filings: 5 },
  { name: '湖南益百永科技开发有限公司', products: '益百永、益百永可生物降解塑料制品', province: '湖南', city: '长沙', filings: 1 },
  { name: '浏阳市生日乐烘焙用品有限公司', products: '食品用纸包装、容器等制品', province: '湖南', city: '长沙', filings: 0 },
  { name: '长沙欣发塑料包装有限公司', products: '降解购物袋', province: '湖南', city: '长沙', filings: 4 },
  { name: '长沙毅华塑料包装有限公司', products: '可降解塑料购物袋、可降解塑料膜', province: '湖南', city: '长沙', filings: 4 },
  { name: '湖南绿斯达生物科技有限公司', products: '全生物降解膜袋', province: '湖南', city: '株洲', filings: 2 },
  { name: '株洲市金宏环保包装科技有限公司', products: '金宏包装', province: '湖南', city: '株洲', filings: 1 },
  { name: '湖南利华新材料有限公司', products: '生物降解塑料购物袋', province: '湖南', city: '湘潭', filings: 4 },
  { name: '邵阳金拓科技开发有限公司', products: '杏叶牌可降解购物袋', province: '湖南', city: '邵阳', filings: 0 },
  { name: '城步苗族自治县华兴民族实业有限公司', products: '蓝品玉、康家乐、苗乡家家乐', province: '湖南', city: '邵阳', filings: 0 },
  { name: '湖南金悦降解塑料制品有限公司', products: '金悦', province: '湖南', city: '衡阳', filings: 3 },
  { name: '漳州新迪新材料科技有限公司', products: 'CBCM 全生物降解材料', province: '福建', city: '漳州', filings: 3 },
  { name: '福建省铨丰环保科技有限公司', products: 'EPA 生物降解材料', province: '福建', city: '泉州', filings: 0 },
  { name: '广东冠宝科技有限公司', products: '冠宝', province: '广东', city: '东莞', filings: 0 },
  { name: '千禾环保科技有限公司', products: '可降解餐具、圆盘、打包盒、刀叉勺、杯碗、背心袋、食品包装袋与托盘、垃圾袋及医疗用品袋', province: '浙江', city: '绍兴', filings: 5 },
  { name: '上海奥巴迪环保科技有限公司', products: '奥巴迪', province: '云南', city: '昆明', filings: 3 },
  { name: '北京艾科美特新材料开发有限公司', products: '艾科美特功能性复合环保材料', province: '广西', city: '贺州', filings: 0 },
];

/** 各字段口径描述，页面与文档共用 */
export const REGISTRY_NOTE = {
  platform: '湖南省可降解塑料信息管理平台',
  asOf: '2023 年',
  source: '平台企业备案与产品报备数据（导出备份）',
} as const;
