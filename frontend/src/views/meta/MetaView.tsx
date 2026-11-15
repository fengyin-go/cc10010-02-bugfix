import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('meta')
const columns = meta.fields
const actions = meta.actions
const statuses = meta.statuses

export default function MetaView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const stats = useMemo(
    () => [
      { label: '元数据条目总数', value: rows.length },
      { label: '已生效条目', value: rows.filter((row) => String(row.status) === '已生效').length },
      { label: '待审核条目', value: rows.filter((row) => String(row.status) === '待审核').length },
      { label: '已作废条目', value: rows.filter((row) => String(row.status) === '已作废').length },
    ],
    [rows],
  )

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '元数据中心列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  // 目录发布/废弃会在同事务里改元数据条目，跨标签页提交后这里也要对齐，避免显示旧条目。
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === null || event.key.startsWith('lake-govern-config:')) {
        reload()
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  function handleExport() {
    try {
      downloadEntries(meta.key)
      setErrorMessage('')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '元数据清单导出失败')
    }
  }

  return (
    <section className="page" data-module="meta">
      <header className="page-head">
        <div>
          <h2>元数据中心管理</h2>
          <p className="page-desc">维护元数据条目的输入、执行约束与结果记录，为元数据中心提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('元数据条目登记入口尚未接入审批流')}>
            登记元数据条目
          </button>
          <button className="btn" type="button" onClick={handleExport}>
            导出元数据中心清单
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
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

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
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无元数据中心数据，可先登记元数据条目</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条元数据中心记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
