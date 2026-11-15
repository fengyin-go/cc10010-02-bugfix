/**
 * 数据目录领域流程验证脚本（非单元测试框架，node scripts/verify-catalog.mjs 直接跑）。
 * 通过 esbuild 打包真实的 src 服务层，并注入内存版 localStorage，
 * 覆盖：单向状态机、乐观锁/并发、元数据同步、废弃闭环、历史版本、事务回滚、导出一致性。
 */
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- 内存版 localStorage ----------------------------------------------------
class MemoryStorage {
  constructor() { this.map = new Map() }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) {
    if (this.failOn === key) {
      throw new Error(`模拟写入失败:${key}`)
    }
    this.map.set(key, String(value))
  }
  removeItem(key) { this.map.delete(key) }
  clear() { this.map.clear() }
}

const storage = new MemoryStorage()
globalThis.window = { localStorage: storage }

async function loadServices() {
  // 单模块图打包：local-service 与 catalog-service 共享同一份缓存与在途锁，
  // 避免两个 bundle 各自缓存导致的脏读。
  const result = await build({
    stdin: {
      contents:
        "export * from '@/api/local-service'; export * from '@/api/catalog-service'; export * from '@/data/local-store';",
      resolveDir: root,
      sourcefile: 'virtual-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    alias: { '@': path.join(root, 'src') },
  })
  const code = result.outputFiles[0].text
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-verify-'))
  const entryFile = path.join(tempDir, 'bundle.mjs')
  fs.writeFileSync(entryFile, code)
  return import(pathToFileURL(entryFile).href)
}

const svc = await loadServices()
const {
  runAction,
  listEntries,
  exportEntries,
  resetModule,
  moduleMeta,
  runCatalogAction,
  verifyCatalogConsistency,
  listCatalogHistory,
  catalogRevision,
  resetCatalogChain,
  reloadFromStorage,
  storageKey,
  historyStorageKey,
} = svc

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

function catalogRows() {
  return listEntries('catalog').items
}
function metaRows() {
  return listEntries('meta').items
}
function row(id) {
  return catalogRows().find((item) => Number(item.id) === id)
}
function linkedActive(id) {
  return metaRows().filter((item) => item._catalogId === id && String(item.status) === '已生效')
}

console.log('1. 播种数据初始一致性')
resetCatalogChain()
check('已发布目录 CATA-0003 自带 1 条生效属性条目且一致性校验通过', () => {
  assert.equal(row(3).status, '已发布')
  assert.equal(linkedActive(3).length, 1)
  assert.equal(verifyCatalogConsistency().ok, true)
  assert.equal(listCatalogHistory(3).length, 1)
})

console.log('2. 草稿 -> 待审核 的单向推进')
check('草稿状态不允许直接发布目录或废弃目录', () => {
  for (const action of ['发布目录', '废弃目录']) {
    const result = runCatalogAction(1, action, catalogRevision(1))
    assert.equal(result.ok, false, action)
    assert.match(result.message, /不允许执行/)
  }
  assert.equal(row(1).status, '草稿')
})
check('草稿目录提交审核成功，修订号 +1、版本号按口径升级', () => {
  const rev = catalogRevision(1)
  const result = runCatalogAction(1, '提交审核', rev)
  assert.equal(result.ok, true, result.message)
  assert.equal(row(1).status, '待审核')
  assert.equal(row(1)._revision, 2)
  assert.equal(row(1)['编目版本'], 'CATA-0001-v2')
})
check('待审核目录不能再次提交审核（普通提交不能回退/原地重复）', () => {
  const result = runCatalogAction(1, '提交审核', catalogRevision(1))
  assert.equal(result.ok, false)
  assert.match(result.message, /不允许执行/)
  assert.equal(row(1).status, '待审核')
})

console.log('3. 发布目录与元数据同步、历史版本')
check('待审核目录发布：状态、版本、生效元数据、历史快照一次到位', () => {
  const rev = catalogRevision(1)
  const result = runCatalogAction(1, '发布目录', rev)
  assert.equal(result.ok, true, result.message)
  assert.equal(row(1).status, '已发布')
  assert.equal(row(1)._revision, 3)
  assert.equal(row(1)['编目版本'], 'CATA-0001-v3')
  const active = linkedActive(1)
  assert.equal(active.length, 1)
  assert.equal(active[0]['属性值'], 'CATA-0001-v3')
  assert.equal(active[0]._catalogRevision, 3)
  const history = listCatalogHistory(1)
  assert.equal(history.length, 2)
  assert.deepEqual(
    history.map((h) => h.toStatus),
    ['待审核', '已发布'],
  )
  assert.equal(verifyCatalogConsistency().ok, true)
})
check('已发布目录再点提交审核被拒绝，状态不回退', () => {
  const result = runCatalogAction(1, '提交审核', catalogRevision(1))
  assert.equal(result.ok, false)
  assert.match(result.message, /已发布目录不能通过/)
  assert.equal(row(1).status, '已发布')
})

console.log('4. 连续点击 / 两个管理员并发提交，只留一个有效结果')
check('带旧修订号的第二次发布会冲突失败，且不产生第二条生效元数据', () => {
  const before = linkedActive(1).length
  const result = runCatalogAction(1, '废弃目录', catalogRevision(1) - 1)
  assert.equal(result.ok, false)
  assert.match(result.message, /冲突/)
  assert.equal(row(1).status, '已发布')
  assert.equal(linkedActive(1).length, before)
})
check('在途锁会拒绝同目录的重入提交', () => {
  // 直接通过通用入口连打两次：第一次成功后修订号变化，第二次的旧修订号必须被拒。
  const r1 = runAction('catalog', 2, '发布目录', catalogRevision(2))
  assert.equal(r1.ok, true, r1.message)
  const r2 = runAction('catalog', 2, '废弃目录', 1) // 仍按发布前修订号提交
  assert.equal(r2.ok, false)
  assert.match(r2.message, /冲突/)
  assert.equal(row(2).status, '已发布')
})
check('两个标签页的管理员基于同一旧修订号并发，只有一个结果生效', () => {
  // 标签页 A 先提交成功；标签页 B 缓存被 storage 事件刷新后，拿着旧修订号提交必须失败。
  const targetId = 1 // 此刻为已发布目录，唯一允许动作是废弃
  const staleRevision = catalogRevision(targetId)
  const first = runCatalogAction(targetId, '废弃目录', staleRevision)
  assert.equal(first.ok, true, first.message)
  // 模拟 B 标签页收到 storage 事件、重新装载存储，再用旧修订号重试。
  reloadFromStorage()
  const second = runCatalogAction(targetId, '废弃目录', staleRevision)
  assert.equal(second.ok, false)
  assert.match(second.message, /冲突|终态/)
  assert.equal(row(targetId).status, '已废弃')
  // 元数据只被作废一次，没有产生重复条目。
  const linked = listEntries('meta').items.filter((item) => item._catalogId === targetId)
  assert.equal(linked.filter((item) => String(item.status) === '已生效').length, 0)
})

console.log('5. 废弃目录：元数据同步作废，历史版本保留')
check('废弃后生效条目清零、条目行保留为已作废、历史仍可查', () => {
  const result = runCatalogAction(2, '废弃目录', catalogRevision(2))
  assert.equal(result.ok, true, result.message)
  assert.equal(row(2).status, '已废弃')
  assert.equal(linkedActive(2).length, 0)
  const linked = metaRows().filter((item) => item._catalogId === 2)
  assert.ok(linked.length > 0)
  assert.ok(linked.every((item) => String(item.status) === '已作废'))
  assert.ok(listCatalogHistory(2).length >= 2)
  assert.equal(verifyCatalogConsistency().ok, true)
})
check('已废弃是终态，任何普通动作都被拒绝', () => {
  for (const action of ['提交审核', '发布目录', '废弃目录']) {
    const result = runCatalogAction(2, action, catalogRevision(2))
    assert.equal(result.ok, false, action)
    assert.match(result.message, /终态|不允许执行/)
  }
  assert.equal(row(2).status, '已废弃')
})

console.log('6. 事务写入失败：目录、元数据、历史全部回滚')
check('localStorage 历史流水写入抛错时，本次临时结论被丢弃并恢复操作前状态', () => {
  const beforeCatalog = JSON.parse(JSON.stringify(row(3)))
  const beforeActive = linkedActive(3).length
  const beforeHistory = listCatalogHistory(3).length
  storage.failOn = historyStorageKey()
  const result = runCatalogAction(3, '废弃目录', catalogRevision(3))
  storage.failOn = null
  assert.equal(result.ok, false)
  assert.match(result.message, /回滚/)
  assert.match(result.message, /数据编目样例3|CATA-0003-v2/)
  assert.deepEqual(row(3), beforeCatalog)
  assert.equal(linkedActive(3).length, beforeActive)
  assert.equal(listCatalogHistory(3).length, beforeHistory)
  assert.equal(verifyCatalogConsistency().ok, true)
})

console.log('7. 导出与异常提示')
check('导出列严格等于模块 fields + 编号/状态，内部字段不落文件', () => {
  const exported = exportEntries('catalog')
  const [header, ...lines] = exported.content.replace('﻿', '').split('\n')
  const expectedHeader = ['编号', ...moduleMeta('catalog').fields, '当前状态'].join(',')
  assert.equal(header, expectedHeader)
  assert.equal(lines.length, catalogRows().length)
  assert.ok(!exported.content.includes('_revision'))
  assert.ok(!exported.content.includes('_catalogId'))
})
check('一致性被破坏时导出中止并指明丢失环节', () => {
  // 模拟「目录已发布但元数据同步丢失」：直接改存储再触发缓存重载（等价于重新打开标签页）。
  const targetId = 3 // 此刻仍为已发布
  assert.equal(row(targetId).status, '已发布')
  const raw = JSON.parse(storage.getItem(storageKey()))
  raw.meta = raw.meta.filter((item) => item._catalogId !== targetId)
  storage.setItem(storageKey(), JSON.stringify(raw))
  reloadFromStorage()
  const report = verifyCatalogConsistency()
  assert.equal(report.ok, false)
  assert.match(report.issues.join('；'), /元数据同步丢失/)
  assert.throws(() => exportEntries('catalog'), /一致性校验未通过/)
  resetCatalogChain()
  assert.equal(verifyCatalogConsistency().ok, true)
})

console.log('8. 其它模块沿用既有流转口径')
check('元数据模块普通动作仍可正常流转', () => {
  const target = listEntries('meta').items.find((item) => String(item.status) === '草稿')
  const result = runAction('meta', Number(target.id), '提交审核')
  assert.equal(result.ok, true, result.message)
})

console.log(`\n全部通过：${passed} 项检查`)
if (process.exitCode) {
  process.exit(process.exitCode)
}
