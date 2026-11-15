import {
  beginTransaction,
  commitTransaction,
  listHistory,
  listRows,
  type TransactionDraft,
} from '@/data/local-store'
import { moduleMeta } from './local-service'
import { SEED_CATALOG_HISTORY, SEED_ROWS } from '@/data/seed'
import type { ActionResult, CatalogHistoryRecord, EntryRow, VersionedRow } from '@/data/types'

/**
 * 数据目录领域服务：顺着「目录动作 -> 元数据同步 -> 历史版本 -> 导出」这条数据流收口。
 * 页面只负责调用，所有状态机、并发控制、事务与校验都在这里，不允许只在按钮上做限制。
 */

const CATALOG_KEY = 'catalog'
const META_KEY = 'meta'

// 元数据条目上指向数据目录的内部关联字段（下划线开头，不进页面列与导出列）。
const LINK_CATALOG_ID = '_catalogId'
const LINK_CATALOG_VERSION = '_catalogVersion'
const LINK_CATALOG_REVISION = '_catalogRevision'

// 同一目录动作的在途锁：连续点击的第二次请求直接拒绝，配合修订号乐观锁双保险。
const inflight = new Set<number>()

function catalogMeta() {
  return moduleMeta(CATALOG_KEY)
}

function revisionOf(row: VersionedRow): number {
  return Number(row._revision ?? 1)
}

function catalogCode(row: EntryRow): string {
  return String(row['编目编号'] ?? `#${row.id}`)
}

function currentVersion(row: EntryRow): string {
  return String(row['编目版本'] ?? '未登记版本')
}

/** 新版本号口径：编目编号 + 递增修订号；旧版本号原样留在历史快照里，不覆盖、不叠加。 */
function nextCatalogVersion(row: VersionedRow, nextRevision: number): string {
  return `${catalogCode(row)}-v${nextRevision}`
}

function isPendingStatus(status: string): boolean {
  const { statuses } = catalogMeta()
  const index = statuses.indexOf(status)
  return index >= 0 && index < statuses.length - 1
}

function timestamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function linkedMetaEntries(metaRows: EntryRow[], catalogId: number): EntryRow[] {
  return metaRows.filter((row) => Number(row[LINK_CATALOG_ID]) === catalogId)
}

function activeLinkedMeta(metaRows: EntryRow[], catalogId: number): EntryRow[] {
  return linkedMetaEntries(metaRows, catalogId).filter((row) => String(row.status) === '已生效')
}

function nextMetaId(metaRows: EntryRow[]): number {
  return metaRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

/** 发布目录时随版本写入的生效属性条目：元数据模块的结果，与目录版本同事务提交。 */
function buildMetaEntry(
  metaRows: EntryRow[],
  catalog: EntryRow,
  version: string,
  revision: number,
): EntryRow {
  const code = catalogCode(catalog)
  return {
    id: nextMetaId(metaRows),
    status: '已生效',
    pending: false,
    abnormal: false,
    [LINK_CATALOG_ID]: Number(catalog.id),
    [LINK_CATALOG_VERSION]: version,
    [LINK_CATALOG_REVISION]: revision,
    条目编号: `META-${code}-v${revision}`,
    对象类型: '数据目录',
    对象名称: String(catalog['数据集名称'] ?? code),
    属性键: '编目版本',
    属性值: version,
    数据来源: '数据编目',
    更新频率: '随目录发布',
    版本变更: version,
  }
}

export type CatalogConsistencyReport = {
  ok: boolean
  issues: string[]
}

/**
 * 提交后/页面加载时的一致性核对：清单状态、元数据条目、历史版本三者必须对得上。
 * 对不上就明确报出丢在哪一步，而不是靠刷新页面把旧结果冲掉。
 */
export function verifyCatalogConsistency(): CatalogConsistencyReport {
  const issues: string[] = []
  const catalogRows = listRows(CATALOG_KEY)
  const metaRows = listRows(META_KEY)
  const history = listHistory()

  for (const catalog of catalogRows) {
    const code = catalogCode(catalog)
    const status = String(catalog.status)
    const revision = revisionOf(catalog)
    const active = activeLinkedMeta(metaRows, Number(catalog.id))
    const ownHistory = history.filter((record) => record.catalogId === Number(catalog.id))

    if (status === '已发布') {
      if (active.length !== 1) {
        issues.push(
          `目录 ${code}（版本 ${currentVersion(catalog)}）已发布，但生效元数据条目数量为 ${active.length}，元数据同步丢失`,
        )
      } else {
        const entry = active[0]
        if (
          Number(entry[LINK_CATALOG_REVISION]) !== revision ||
          String(entry[LINK_CATALOG_VERSION]) !== currentVersion(catalog)
        ) {
          issues.push(
            `目录 ${code} 清单版本 ${currentVersion(catalog)} 与生效元数据条目版本 ${String(
              entry[LINK_CATALOG_VERSION] ?? '缺失',
            )} 不一致，导出列与清单会各说各话`,
          )
        }
      }
      if (!ownHistory.some((record) => record.revision === revision && record.toStatus === '已发布')) {
        issues.push(`目录 ${code} 已发布但缺少版本 ${currentVersion(catalog)} 的发布历史，历史版本保留不完整`)
      }
    }

    if (status === '已废弃' && active.length > 0) {
      issues.push(
        `目录 ${code} 已废弃但仍有 ${active.length} 条生效元数据条目未同步作废，废弃流程未闭环`,
      )
    }

    // 历史流水从「提交审核」开始落库；沿用既有口径，播种时已是待审核但早于历史功能的旧档不判断裂。
    if ((status === '已发布' || status === '已废弃') && ownHistory.length === 0) {
      issues.push(`目录 ${code} 状态为「${status}」却没有任何历史版本记录，版本链路断裂`)
    }

    const revisions = ownHistory.map((record) => record.revision)
    if (revisions.some((value) => value > revision)) {
      issues.push(`目录 ${code} 存在比当前修订号 ${revision} 更新的历史结论，状态显示为旧档`)
    }
  }

  for (const entry of metaRows) {
    const linkedId = entry[LINK_CATALOG_ID]
    if (linkedId === undefined) {
      continue
    }
    const catalog = catalogRows.find((row) => Number(row.id) === Number(linkedId))
    if (!catalog) {
      issues.push(`元数据条目 ${String(entry['条目编号'] ?? entry.id)} 关联的目录已不存在，成为孤儿条目`)
      continue
    }
    if (String(entry.status) === '已生效' && String(catalog.status) !== '已发布') {
      issues.push(
        `元数据条目 ${String(entry['条目编号'] ?? entry.id)} 仍为已生效，但目录 ${catalogCode(
          catalog,
        )} 状态是「${String(catalog.status)}」，元数据与目录状态脱节`,
      )
    }
  }

  return { ok: issues.length === 0, issues }
}

export function listCatalogHistory(catalogId?: number): CatalogHistoryRecord[] {
  const history = listHistory()
  return typeof catalogId === 'number'
    ? history.filter((record) => record.catalogId === catalogId)
    : history
}

/**
 * 目录动作统一入口。返回值始终带明确目录版本信息：
 * - 状态机不通过 / 修订号冲突：拒绝并写明当前版本，不产生任何写入；
 * - 事务落盘失败：目录、元数据、历史全部回滚到操作前，临时审核结论随草稿丢弃；
 * - 提交后校验失败：报出具体丢失步骤，不留旧结果冒充成功。
 */
export function runCatalogAction(
  id: number,
  action: string,
  expectedRevision?: number,
): ActionResult {
  const meta = catalogMeta()
  if (inflight.has(id)) {
    return {
      ok: false,
      message: `数据目录 #${id} 上一个动作仍在处理中，本次重复提交已拒绝（只允许一个有效结果）`,
    }
  }
  inflight.add(id)
  let draft: TransactionDraft | null = null
  try {
    const rows = listRows(CATALOG_KEY)
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的数据目录` }
    }
    const current = rows[index] as VersionedRow
    const code = catalogCode(current)
    const beforeVersion = currentVersion(current)
    const status = String(current.status)

    if (!meta.actionTargets[action]) {
      return { ok: false, message: `数据目录 ${code}（版本 ${beforeVersion}）没有登记「${action}」这个动作` }
    }

    // 乐观锁：页面带着打开时的修订号提交，两个管理员同时提交时第二个会撞版本。
    const revision = revisionOf(current)
    if (typeof expectedRevision === 'number' && expectedRevision !== revision) {
      return {
        ok: false,
        message: `数据目录 ${code} 已被其他操作更新到版本 ${beforeVersion}（修订号 ${revision}），你基于修订号 ${expectedRevision} 的提交已冲突，本次未写入任何数据`,
      }
    }

    // 单向状态机：只允许 草稿 -> 待审核 -> 已发布 -> 已废弃。
    const allowed = meta.transitions?.[status] ?? []
    if (!allowed.includes(action)) {
      const reason =
        status === '已发布' && action === '提交审核'
          ? '已发布目录不能通过「提交审核」回退状态'
          : status === '已废弃'
            ? '已废弃是终态，不能再执行任何普通动作'
            : `「${status}」状态不允许执行「${action}」`
      return {
        ok: false,
        message: `数据目录 ${code}（版本 ${beforeVersion}，当前状态「${status}」）动作被拒：${reason}`,
      }
    }

    const target = meta.actionTargets[action]
    const nextRevision = revision + 1
    const version = nextCatalogVersion(current, nextRevision)
    const baseVersion = String(current._baseVersion ?? beforeVersion)

    // 事务草稿：以下全部改动先落在内存草稿里，commitTransaction 之前任何失败都不留痕。
    draft = beginTransaction()
    const catalogRows = draft.rows[CATALOG_KEY] as VersionedRow[]
    const metaRows = draft.rows[META_KEY] ?? []

    // 元数据版本冲突判断：已存在修订号不小于本次的生效条目，说明有更新的目录结论先行落库。
    // 冲突取舍口径：以修订号最大的已提交目录版本为准，本次提交直接失败而不是覆盖新结论。
    const active = activeLinkedMeta(metaRows, id)
    if (action === '发布目录') {
      const newer = active.find((row) => Number(row[LINK_CATALOG_REVISION] ?? 0) >= nextRevision)
      if (newer) {
        return {
          ok: false,
          message: `数据目录 ${code} 发布中止：元数据条目 ${String(
            newer['条目编号'] ?? newer.id,
          )} 已包含修订号 ${String(newer[LINK_CATALOG_REVISION])} 的更新版本，按「高修订号生效」口径保留该版本，本次版本 ${version} 未写入`,
        }
      }
    }

    const metaSnapshot: EntryRow[] = []

    if (action === '发布目录') {
      // 旧生效条目先作废保留（不删除），再写入随新版本生效的属性条目。
      for (const row of metaRows) {
        if (Number(row[LINK_CATALOG_ID]) === id && String(row.status) === '已生效') {
          row.status = '已作废'
          row.pending = false
          metaSnapshot.push({ ...row })
        }
      }
      const entry = buildMetaEntry(metaRows, current, version, nextRevision)
      metaRows.push(entry)
      metaSnapshot.push({ ...entry })
      draft.rows[META_KEY] = metaRows
    }

    if (action === '废弃目录') {
      // 废弃必须同步处理对应元数据条目：生效条目全部作废，行数据与历史版本保留。
      for (const row of metaRows) {
        if (Number(row[LINK_CATALOG_ID]) === id && String(row.status) === '已生效') {
          row.status = '已作废'
          row.pending = false
          metaSnapshot.push({ ...row })
        }
      }
      draft.rows[META_KEY] = metaRows
    }

    const updated: VersionedRow = {
      ...current,
      status: target,
      pending: isPendingStatus(target),
      abnormal: false,
      编目版本: version,
      _revision: nextRevision,
      _baseVersion: baseVersion,
    }
    catalogRows[index] = updated
    draft.rows[CATALOG_KEY] = catalogRows

    const record: CatalogHistoryRecord = {
      catalogId: id,
      revision: nextRevision,
      catalogVersion: version,
      fromStatus: status,
      toStatus: target,
      action,
      metaSnapshot,
      changedAt: timestamp(),
    }
    draft.history.push(record)

    try {
      commitTransaction(draft)
    } catch (error) {
      // 落盘失败：commitTransaction 内部已恢复内存与 localStorage，草稿与临时审核结论一并丢弃。
      return {
        ok: false,
        message: `数据目录 ${code} 版本 ${version} 的「${action}」事务写入失败，目录与元数据已回滚到版本 ${beforeVersion}（修订号 ${revision}）；失败步骤：事务落盘（${
          error instanceof Error ? error.message : '未知存储错误'
        }）`,
      }
    }

    // 提交后核对：清单、元数据、历史任一环节没写进去都明确报错，不允许刷新掩盖。
    const verification = verifyCommitted(id, target, nextRevision, version, action)
    if (!verification.ok) {
      return {
        ok: false,
        message: `数据目录 ${code} 版本 ${version} 提交后校验失败：${verification.message}。请勿刷新页面，需按提示补齐丢失环节`,
      }
    }

    const syncNote =
      action === '发布目录'
        ? `，元数据条目 META-${code}-v${nextRevision} 已同步生效`
        : action === '废弃目录'
          ? '，关联生效元数据条目已同步作废且历史版本保留'
          : ''
    return {
      ok: true,
      message: `数据目录 ${code}（版本 ${version}）已${action}，当前状态「${target}」${syncNote}`,
    }
  } finally {
    inflight.delete(id)
  }
}

function verifyCommitted(
  id: number,
  target: string,
  nextRevision: number,
  version: string,
  action: string,
): { ok: boolean; message: string } {
  const stored = listRows(CATALOG_KEY).find((row) => Number(row.id) === id) as VersionedRow | undefined
  if (!stored) {
    return { ok: false, message: '目录清单中查不到该目录，目录写入环节丢失' }
  }
  if (String(stored.status) !== target || revisionOf(stored) !== nextRevision) {
    return {
      ok: false,
      message: `清单仍显示旧档「${String(stored.status)} / 修订号 ${revisionOf(
        stored,
      )}」，目录状态更新环节丢失`,
    }
  }
  if (String(stored['编目版本']) !== version) {
    return { ok: false, message: `清单编目版本仍为 ${currentVersion(stored)}，版本号写入环节丢失` }
  }

  const active = activeLinkedMeta(listRows(META_KEY), id)
  if (action === '发布目录') {
    if (active.length !== 1) {
      return { ok: false, message: `生效元数据条目数量为 ${active.length}（应为 1），元数据同步环节丢失` }
    }
    const entry = active[0]
    if (
      Number(entry[LINK_CATALOG_REVISION]) !== nextRevision ||
      String(entry[LINK_CATALOG_VERSION]) !== version
    ) {
      return { ok: false, message: '元数据条目版本与目录版本对不上，元数据版本写入环节丢失' }
    }
  }
  if (action === '废弃目录' && active.length !== 0) {
    return { ok: false, message: `仍有 ${active.length} 条生效元数据条目未作废，元数据废弃环节丢失` }
  }

  const historyRecord = listHistory().find(
    (item) => item.catalogId === id && item.revision === nextRevision,
  )
  if (!historyRecord) {
    return { ok: false, message: `历史版本 ${version} 没有落库，历史保留环节丢失` }
  }
  return { ok: true, message: '' }
}

/** 供页面与测试读取目录当前修订号，提交时作为乐观锁依据。 */
export function catalogRevision(id: number): number | undefined {
  const row = listRows(CATALOG_KEY).find((item) => Number(item.id) === id) as VersionedRow | undefined
  return row ? revisionOf(row) : undefined
}

/**
 * 重置整条目录链路：目录行、元数据条目、历史版本流水一起回到播种数据，
 * 避免只重置清单而让历史版本残留、被一致性校验判成「状态显示为旧档」。
 */
export function resetCatalogChain(): void {
  const draft = beginTransaction()
  draft.rows[CATALOG_KEY] = clone(SEED_ROWS[CATALOG_KEY] ?? [])
  draft.rows[META_KEY] = clone(SEED_ROWS[META_KEY] ?? [])
  draft.history = clone(SEED_CATALOG_HISTORY)
  commitTransaction(draft)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
