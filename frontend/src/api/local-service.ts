import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { runCatalogAction, verifyCatalogConsistency } from './catalog-service'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult, VersionedRow } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  expectedRevision?: number,
): ActionResult {
  // 数据目录走独立领域服务：单向状态机、元数据同步、历史版本与事务都在那条链路里收口。
  if (key === 'catalog') {
    return runCatalogAction(id, action, expectedRevision)
  }

  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = rows[index] as VersionedRow
  const currentStatus = String(current.status)
  if (currentStatus === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  // 配置了状态机的模块同样按允许动作收口；未配置的模块沿用旧的目标态流转口径。
  if (meta.transitions) {
    const allowed = meta.transitions[currentStatus] ?? []
    if (!allowed.includes(action)) {
      return {
        ok: false,
        message: `${meta.entity}（编号 ${id}，当前状态「${currentStatus}」）动作被拒：该状态不允许执行「${action}」`,
      }
    }
  }

  const revision = Number(current._revision ?? 1)
  if (typeof expectedRevision === 'number' && expectedRevision !== revision) {
    return {
      ok: false,
      message: `${meta.entity}（编号 ${id}）已被更新到修订号 ${revision}，你基于修订号 ${expectedRevision} 的提交冲突，本次未写入`,
    }
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: VersionedRow = {
    ...current,
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    _revision: revision + 1,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)

  // 导出前先做一致性核对：清单、元数据、历史版本对不上时明确报错，不导出互相矛盾的旧文件。
  if (key === 'catalog') {
    const report = verifyCatalogConsistency()
    if (!report.ok) {
      throw new Error(`编目清单导出中止，数据一致性校验未通过：${report.issues.join('；')}`)
    }
  }

  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    // 内部字段（_revision 等）一律不进导出，导出列与页面列严格同一份 fields 定义。
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
