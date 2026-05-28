const express = require('express')
const { exec } = require('child_process')
const fs = require('fs')
const path = require('path')
const multer = require('multer')
const ecrewParser = require('./ecrew-pdf-parser')
const parseECrewPDF = ecrewParser
const { linkLayovers } = ecrewParser

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

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

// 聯絡人（常用代碼）
function contactsPath(userId) {
  const fp = userPath(userId)
  if (!fp) return null
  return fp.replace(/\.json$/, '_contacts.json')
}

app.get('/api/contacts/:userId', (req, res) => {
  const fp = contactsPath(req.params.userId)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  res.json(readData(fp))
})

app.post('/api/contacts/:userId', (req, res) => {
  const fp = contactsPath(req.params.userId)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  const { code, name } = req.body
  if (!code || !/^[A-Z0-9]{4,12}$/.test(code)) return res.status(400).json({ error: '無效代碼' })
  const list = readData(fp)
  const idx = list.findIndex(c => c.code === code)
  if (idx >= 0) list[idx].name = name || list[idx].name
  else list.push({ code, name: name || code })
  fs.writeFileSync(fp, JSON.stringify(list, null, 2))
  res.json({ ok: true })
})

app.delete('/api/contacts/:userId/:code', (req, res) => {
  const fp = contactsPath(req.params.userId)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  const list = readData(fp).filter(c => c.code !== req.params.code)
  fs.writeFileSync(fp, JSON.stringify(list, null, 2))
  res.json({ ok: true })
})

// 用班號+日期查共用航班資料（掃描所有用戶）
app.get('/api/flight-lookup/:fn/:date', (req, res) => {
  const fn = req.params.fn.replace(/^0+/, '')  // 去掉前置零
  const date = req.params.date
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => /^[a-zA-Z0-9]{4,12}\.json$/.test(f))
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'))
        const leg = data.find(e =>
          e.type === 'flight' &&
          e.flight_number && e.flight_number.replace(/^0+/, '') === fn &&
          e.date === date &&
          (e.from || e.to || e.departure_scheduled || e.arrival_scheduled)
        )
        if (leg) return res.json({ found: true, leg })
      } catch {}
    }
  } catch {}
  res.json({ found: false })
})

// 查詢同班次組員（回傳所有有該班號+日期的 userId + empId）
app.get('/api/flight-crew/:fn/:date', (req, res) => {
  const fn = req.params.fn.replace(/^0+/, '')
  const date = req.params.date
  const results = []
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => /^[a-zA-Z0-9]{4,12}\.json$/.test(f))
    for (const file of files) {
      const userId = file.replace('.json', '')
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'))
        const has = data.some(e =>
          e.type === 'flight' &&
          e.flight_number && e.flight_number.replace(/^0+/, '') === fn &&
          e.date === date
        )
        if (!has) continue
        let empId = null
        try {
          const p = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${userId}_profile.json`), 'utf8'))
          empId = p.empId || null
        } catch {}
        results.push({ userId, empId })
      } catch {}
    }
  } catch {}
  res.json(results)
})

// 用員編反查 userId
app.get('/api/lookup/emp/:empId', (req, res) => {
  const empId = req.params.empId.trim()
  if (!empId) return res.status(400).json({ error: '無效員編' })
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('_profile.json'))
    for (const file of files) {
      try {
        const profile = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'))
        if (profile.empId === empId) {
          return res.json({ userId: file.replace('_profile.json', '') })
        }
      } catch {}
    }
  } catch {}
  res.status(404).json({ error: '找不到此員編' })
})

// 用戶 profile（員編等）
function profilePath(userId) {
  const fp = userPath(userId)
  if (!fp) return null
  return fp.replace(/\.json$/, '_profile.json')
}

app.get('/api/profile/:userId', (req, res) => {
  const fp = profilePath(req.params.userId)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  try { res.json(JSON.parse(fs.readFileSync(fp, 'utf8'))) } catch { res.json({}) }
})

app.post('/api/profile/:userId', (req, res) => {
  const fp = profilePath(req.params.userId)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  const existing = (() => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')) } catch { return {} } })()
  const updated = { ...existing, ...req.body }
  fs.writeFileSync(fp, JSON.stringify(updated))
  res.json({ ok: true })
})

// 用戶設定（LINE User ID、換班 Bot URL 等）
function settingsPath(userId) {
  const fp = userPath(userId)
  if (!fp) return null
  return fp.replace(/\.json$/, '_settings.json')
}

app.get('/api/settings/:userId', (req, res) => {
  const fp = settingsPath(req.params.userId)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  try { res.json(JSON.parse(fs.readFileSync(fp, 'utf8'))) } catch { res.json({}) }
})

app.post('/api/settings/:userId', (req, res) => {
  const fp = settingsPath(req.params.userId)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  const existing = (() => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')) } catch { return {} } })()
  const updated = { ...existing, ...req.body }
  fs.writeFileSync(fp, JSON.stringify(updated))
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

// eCrew PDF 匯入（完整覆蓋，保留 manually_added）
app.post('/api/import/:userId', upload.single('pdf'), async (req, res) => {
  const fp = userPath(req.params.userId)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  if (!req.file) return res.status(400).json({ error: '未收到 PDF 檔案' })
  try {
    const newEntries = await parseECrewPDF(req.file.buffer)
    const existing = readData(fp).filter(e => e.manually_added)
    const combined = [...existing, ...newEntries]
    linkLayovers(combined)
    // 去重：同 id 保留 duty_id 較早的（過夜班連結優先）
    const seen = new Map()
    combined.forEach(e => {
      if (!seen.has(e.id) || e.duty_id < seen.get(e.id).duty_id) seen.set(e.id, e)
    })
    const merged = [...seen.values()]
    fs.writeFileSync(fp, JSON.stringify(merged, null, 2))
    res.json({ ok: true, imported: newEntries.length, total: merged.length })
  } catch (err) {
    console.error('PDF 解析失敗:', err)
    res.status(500).json({ error: 'PDF 解析失敗：' + err.message })
  }
})

app.listen(PORT, () => {
  console.log(`✅ CCal 啟動：http://localhost:${PORT}`)
  console.log(`📁 資料目錄：${DATA_DIR}`)
})
