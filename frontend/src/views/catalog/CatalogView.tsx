import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'

import {
  catalogRevision,
  listCatalogHistory,
  verifyCatalogConsistency,
} from '@/api/catalog-service'
import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import type { CatalogHistoryRecord, EntryRow, VersionedRow } from '@/data/types'

const meta = moduleMeta('catalog')

export default function CatalogView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [consistencyIssues, setConsistencyIssues] = useState<string[]>([])
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [historyRows, setHistoryRows] = useState<CatalogHistoryRecord[]>([])
  const filterFields = useMemo(() => meta.fields.slice(0, 3), [])

  const reload = useCallback(() => {
    // 注意：动作失败时不会走到这里，旧的错误提示会保留，不会被一次刷新悄悄清掉。
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      const report = verifyCatalogConsistency()
      setConsistencyIssues(report.issues)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '数据编目列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  // 另一个管理员在别的标签页提交后，本标签页自动对齐清单与元数据，不展示旧档。
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === null || event.key.startsWith('lake-govern-config:')) {
        reload()
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [reload])

  const stats = useMemo(
    () => [
      { label: '数据目录总数', value: rows.length },
      { label: '已发布目录', value: rows.filter((row) => String(row.status) === '已发布').length },
      { label: '待审核目录', value: rows.filter((row) => String(row.status) === '待审核').length },
      { label: '已废弃目录', value: rows.filter((row) => String(row.status) === '已废弃').length },
    ],
    [rows],
  )

  function runAction(action: string, row: EntryRow) {
    const expected = catalogRevision(Number(row.id))
    const result = applyAction(meta.key, Number(row.id), action, expected)
    if (!result.ok) {
      // 失败不 reload：清单维持服务端真实状态，错误提示明确到具体目录版本。
      setErrorMessage(result.message)
      return
    }
    setErrorMessage('')
    reload()
  }

  function handleExport() {
    try {
      downloadEntries(meta.key)
      setErrorMessage('')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '编目清单导出失败')
    }
  }

  function toggleHistory(row: EntryRow) {
    const id = Number(row.id)
    if (expandedId === id) {
      setExpandedId(null)
      setHistoryRows([])
      return
    }
    setExpandedId(id)
    setHistoryRows(listCatalogHistory(id))
  }

  function allowedActions(row: EntryRow): string[] {
    return meta.transitions?.[String(row.status)] ?? meta.actions
  }

  return (
    <section className="page" data-module="catalog">
      <header className="page-head">
        <div>
          <h2>数据编目管理</h2>
          <p className="page-desc">维护数据编目的输入、执行约束与结果记录，为数据编目提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('数据目录登记入口尚未接入审批流')}>
            登记数据目录
          </button>
          <button className="btn" type="button" onClick={handleExport}>
            导出数据编目清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {meta.statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      {consistencyIssues.length > 0 && (
        <div className="consistency-banner" role="alert">
          <strong>清单与元数据一致性校验未通过：</strong>
          <ul>
            {consistencyIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {meta.fields.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
            <th>历史版本</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const enabled = new Set(allowedActions(row))
            const revision = (row as VersionedRow)._revision ?? 1
            return (
              <Fragment key={String(row.id)}>
                <tr>
                  {meta.fields.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                  <td>{row.status}<span className="revision-tag">修订号 {String(revision)}</span></td>
                  <td className="row-actions">
                    {meta.actions.map((action) => {
                      const usable = enabled.has(action)
                      return (
                        <button
                          key={action}
                          className="link"
                          type="button"
                          disabled={!usable}
                          title={usable ? action : `「${String(row.status)}」状态不允许执行「${action}」（状态只能单向推进）`}
                          onClick={() => usable && runAction(action, row)}
                        >
                          {action}
                        </button>
                      )
                    })}
                  </td>
                  <td>
                    <button className="link" type="button" onClick={() => toggleHistory(row)}>
                      {expandedId === Number(row.id) ? '收起历史' : '查看历史'}
                    </button>
                  </td>
                </tr>
                {expandedId === Number(row.id) && (
                  <tr key={`${String(row.id)}-history`} className="history-row">
                    <td colSpan={meta.fields.length + 3}>
                      {historyRows.length === 0 ? (
                        <span className="empty-state">该目录尚无历史版本记录</span>
                      ) : (
                        <table className="history-table">
                          <thead>
                            <tr>
                              <th>编目版本</th>
                              <th>动作</th>
                              <th>状态变化</th>
                              <th>同步元数据条目</th>
                              <th>记录时间</th>
                            </tr>
                          </thead>
                          <tbody>
                            {historyRows.map((record) => (
                              <tr key={`${record.catalogId}-${record.revision}`}>
                                <td>{record.catalogVersion}</td>
                                <td>{record.action}</td>
                                <td>{record.fromStatus} → {record.toStatus}</td>
                                <td>
                                  {record.metaSnapshot.length === 0
                                    ? '—'
                                    : record.metaSnapshot
                                        .map((item) => String(item['条目编号'] ?? item.id))
                                        .join('、')}
                                </td>
                                <td>{record.changedAt}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={meta.fields.length + 3}>暂无数据编目数据，可先登记数据目录</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条数据编目记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
