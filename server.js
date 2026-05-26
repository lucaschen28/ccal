const express = require('express')
const { exec } = require('child_process')
const fs = require('fs')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data', 'schedules')

// 確保資料夾存在
fs.mkdirSync(DATA_DIR, { recursive: true })

function userPath(userId) {
  // 只允許字母數字，避免路徑穿越
  if (!userId || !/^[a-zA-Z0-9]{4,12}$/.test(userId)) return null
  return path.join(DATA_DIR, `${userId}.json`)
}

function readData(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return [] }
}

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// 取得班表
app.get('/api/schedule/:userId', (req, res) => {
  const fp = userPath(req.params.userId)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  res.json(readData(fp))
})

// 新增一筆
app.post('/api/schedule/:userId', (req, res) => {
  const fp = userPath(req.params.userId)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  const entry = req.body
  if (!entry.date) return res.status(400).json({ error: '缺少 date' })
  if (!entry.id) entry.id = 'manual_' + Date.now() + '_' + Math.floor(Math.random()*9999)
  entry.manually_added = true
  const data = readData(fp)
  data.push(entry)
  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  res.json({ ok: true, entry })
})

// 修改一筆
app.put('/api/schedule/:userId/:id', (req, res) => {
  const fp = userPath(req.params.userId)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  const data = readData(fp)
  const idx = data.findIndex(e => e.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: '找不到' })
  data[idx] = { ...data[idx], ...req.body }
  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  res.json({ ok: true, entry: data[idx] })
})

// 刪除一筆
app.delete('/api/schedule/:userId/:id', (req, res) => {
  const fp = userPath(req.params.userId)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  let data = readData(fp)
  const before = data.length
  data = data.filter(e => e.id !== req.params.id)
  if (data.length === before) return res.status(404).json({ error: '找不到' })
  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  res.json({ ok: true })
})

// 驗證存取密碼（新訪客用，已有代碼的直接略過）
app.post('/api/auth', (req, res) => {
  const expected = process.env.CCAL_ACCESS_CODE
  if (!expected) return res.json({ ok: true })          // 未設密碼 = 開放
  if ((req.body.code || '') === expected) return res.json({ ok: true })
  res.status(401).json({ ok: false, error: '密碼錯誤' })
})

// 整批取代（iOS Shortcuts / eCrew 匯入用）
app.post('/api/bulk/:userId', (req, res) => {
  const fp = userPath(req.params.userId)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  const entries = req.body
  if (!Array.isArray(entries)) return res.status(400).json({ error: '格式錯誤，需傳入陣列' })
  // 保留 manually_added 的資料，覆蓋其餘
  const existing = readData(fp).filter(e => e.manually_added)
  const merged = [...existing, ...entries.filter(e => !e.manually_added)]
  fs.writeFileSync(fp, JSON.stringify(merged, null, 2))
  res.json({ ok: true, count: merged.length })
})

app.listen(PORT, () => {
  console.log(`✅ CCal 啟動：http://localhost:${PORT}`)
  console.log(`📁 資料目錄：${DATA_DIR}`)
})
