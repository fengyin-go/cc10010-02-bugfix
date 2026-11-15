/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

/** 目录/条目内部使用的乐观锁与版本字段（下划线开头，不会出现在页面列与导出列里）。 */
export type VersionedRow = EntryRow & {
  /** 修订号：每完成一次状态动作 +1，并发提交时作为乐观锁版本。 */
  _revision?: number
  /** 首次纳管时冻结的业务版本原值，后续生成新版本号都基于它，避免版本标签反复叠加。 */
  _baseVersion?: string
}

/** 一次目录动作留下的历史版本快照，只追加不改写，废弃后仍可追溯。 */
export type CatalogHistoryRecord = {
  catalogId: number
  revision: number
  catalogVersion: string
  fromStatus: string
  toStatus: string
  action: string
  /** 随该版本一并写入的生效属性条目快照（元数据模块结果）。 */
  metaSnapshot: EntryRow[]
  changedAt: string
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /**
   * 状态机：只登记允许的「当前状态 -> 可执行动作」。
   * 未配置该字段的模块沿用旧的目标态流转口径，避免改动其它模块既有行为。
   */
  transitions?: Record<string, string[]>
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
