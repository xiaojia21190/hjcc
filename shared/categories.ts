import type { CategoryMeta, IndexCategory } from '../shared/types'

/** 六大宽基类别：每类取规模最大 ETF 监控汇金持仓 */
export const CATEGORIES: CategoryMeta[] = [
  {
    id: 'sse50',
    name: '上证50',
    shortName: '上证50',
    keywords: ['上证50', '上证 50'],
    candidates: ['510050', '510100', '510230'],
  },
  {
    id: 'csi300',
    name: '沪深300',
    shortName: '沪深300',
    keywords: ['沪深300', '沪深 300'],
    candidates: ['510300', '510310', '159919', '510330', '159925'],
  },
  {
    id: 'csi500',
    name: '中证500',
    shortName: '中证500',
    keywords: ['中证500', '中证 500'],
    candidates: ['510500', '512500', '159922', '510510'],
  },
  {
    id: 'csi1000',
    name: '中证1000',
    shortName: '中证1000',
    keywords: ['中证1000', '中证 1000'],
    candidates: ['512100', '159845', '159633', '560010'],
  },
  {
    id: 'chinext',
    name: '创业板',
    shortName: '创业板',
    keywords: ['创业板'],
    candidates: ['159915', '159952', '159977', '159949'],
  },
  {
    id: 'star50',
    name: '科创50',
    shortName: '科创50',
    keywords: ['科创板50', '科创50', '上证科创板50'],
    candidates: ['588000', '588080', '588050', '588090'],
  },
]

/** 汇金系主体名称匹配（持有人名称包含即可） */
export const HUIJIN_NAME_PATTERNS = [
  '中央汇金投资有限责任公司',
  '中央汇金资产管理有限责任公司',
  '中央汇金',
]

export function isHuijinHolder(name: string): boolean {
  const n = name.trim()
  // 直接主体或「易方达基金－中央汇金资管…」这类资管计划
  return HUIJIN_NAME_PATTERNS.some((p) => n.includes(p))
}

export function categoryById(id: IndexCategory): CategoryMeta {
  const c = CATEGORIES.find((x) => x.id === id)
  if (!c) throw new Error(`unknown category ${id}`)
  return c
}

/** 判断 ETF 是否直接跟踪基础指数，排除联接基金及增强、细分等衍生指数。 */
export function matchCategory(name: string, category: CategoryMeta): boolean {
  const compact = name.replace(/\s+/g, '')
  if (/联接|连接|FOF|货币|债/.test(compact)) return false
  return category.keywords.some((keyword) =>
    compact.includes(`${keyword.replace(/\s+/g, '')}ETF`),
  )
}
