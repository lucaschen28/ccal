const express = require('express')
const { exec } = require('child_process')
const fs = require('fs')
const path = require('path')
const multer = require('multer')
const ecrewParser = require('./ecrew-pdf-parser')
const parseECrewPDF = ecrewParser
const { linkLayovers } = ecrewParser
const pbsParser = require('./pbs-result-parser')

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })

const app = express()
const PORT = process.env.PORT || 3000
// DATA_DIR 指向班表目錄；PBS_DIR 與 schedules 同層（同一個 volume）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data', 'schedules')
const _BASE_DIR = path.dirname(DATA_DIR)  // e.g. /data 或 ./data

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
  const { name } = req.body
  const code = (req.body.code || '').trim().toUpperCase()  // 統一轉大寫，防止大小寫問題
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

// 以 LINE User ID 反查 CCal 代碼（同時回傳 linePublicId、empId）
app.get('/api/lookup/line/:lineUserId', (req, res) => {
  const lineUserId = req.params.lineUserId.trim()
  if (!lineUserId) return res.status(400).json({ error: '無效的 LINE User ID' })
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('_settings.json'))
    for (const file of files) {
      try {
        const settings = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'))
        if (settings.lineUserId === lineUserId) {
          const ccalUserId = file.replace('_settings.json', '')
          // 也讀 profile 取得 empId
          let empId = ''
          try {
            const profile = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${ccalUserId}_profile.json`), 'utf8'))
            empId = profile.empId || ''
          } catch {}
          return res.json({
            userId: ccalUserId,
            linePublicId: settings.linePublicId || '',
            empId
          })
        }
      } catch {}
    }
  } catch {}
  res.status(404).json({ error: '找不到此 LINE 用戶' })
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
  try {
    const { pin, ...safe } = JSON.parse(fs.readFileSync(fp, 'utf8'))
    res.json({ ...safe, hasPin: !!pin })
  } catch { res.json({}) }
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

// 更改個人 PIN（需驗證目前 PIN，若尚無 PIN 則直接設定）
app.post('/api/change-pin/:userId', (req, res) => {
  const fp = profilePath(req.params.userId)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  const { currentPin, newPin } = req.body
  if (!newPin || !/^\d{4,6}$/.test(String(newPin))) {
    return res.status(400).json({ error: 'PIN 需為 4–6 位數字' })
  }
  const existing = (() => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')) } catch { return {} } })()
  if (existing.pin && existing.pin !== String(currentPin)) {
    return res.status(401).json({ error: '目前 PIN 不正確' })
  }
  fs.writeFileSync(fp, JSON.stringify({ ...existing, pin: String(newPin) }))
  res.json({ ok: true })
})

// 以代碼 + 個人 PIN 驗證身份（舊用戶換裝置恢復資料）
app.post('/api/auth-pin', (req, res) => {
  const { userId, pin } = req.body
  if (!userId || !pin) return res.status(400).json({ ok: false, error: '缺少代碼或 PIN' })
  const fp = profilePath(userId)
  if (!fp) return res.status(400).json({ ok: false, error: '代碼或 PIN 錯誤' })
  try {
    const profile = JSON.parse(fs.readFileSync(fp, 'utf8'))
    if (!profile.pin) {
      return res.status(401).json({ ok: false, error: '此帳號尚未設定 PIN，請在原裝置的設定頁面（⚙）先設定 PIN，再來這裡恢復。' })
    }
    if (profile.pin !== String(pin)) {
      return res.status(401).json({ ok: false, error: '代碼或 PIN 錯誤' })
    }
    res.json({ ok: true, empId: profile.empId || '' })
  } catch {
    res.status(401).json({ ok: false, error: '代碼或 PIN 錯誤' })
  }
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

// eCrew PDF 匯入（累積合併：舊 PDF 保留，新 PDF 疊加，manually_added 永遠保留）
app.post('/api/import/:userId', upload.single('pdf'), async (req, res) => {
  const fp = userPath(req.params.userId)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  if (!req.file) return res.status(400).json({ error: '未收到 PDF 檔案' })
  try {
    const newEntries = await parseECrewPDF(req.file.buffer)
    const all = readData(fp)
    const manualEntries = all.filter(e => e.manually_added)
    const oldPdfEntries = all.filter(e => !e.manually_added)
    // 舊 PDF 先放，新 PDF 後放（新覆蓋舊的同 id）
    const seen = new Map()
    oldPdfEntries.forEach(e => seen.set(e.id, e))
    newEntries.forEach(e => seen.set(e.id, e))
    const combined = [...seen.values(), ...manualEntries]
    linkLayovers(combined)
    // 過夜班連結去重：同 id 保留 duty_id 較早的
    const finalSeen = new Map()
    combined.forEach(e => {
      if (!finalSeen.has(e.id) || e.duty_id < finalSeen.get(e.id).duty_id) finalSeen.set(e.id, e)
    })
    const merged = [...finalSeen.values()]
    fs.writeFileSync(fp, JSON.stringify(merged, null, 2))
    res.json({ ok: true, imported: newEntries.length, total: merged.length })
  } catch (err) {
    console.error('PDF 解析失敗:', err)
    res.status(500).json({ error: 'PDF 解析失敗：' + err.message })
  }
})

// ── 管理者 API ───────────────────────────────────────────────
function adminAuth(req, res, next) {
  const pw = process.env.ADMIN_PASSWORD
  if (!pw) return res.status(503).json({ error: '管理者密碼未設定，請在 Railway 設定 ADMIN_PASSWORD' })
  if (req.headers['x-admin-password'] !== pw) return res.status(403).json({ error: '密碼錯誤' })
  next()
}

// 使用者列表
app.get('/api/admin/users', adminAuth, (req, res) => {
  try {
    const allFiles = fs.readdirSync(DATA_DIR)
    const scheduleFiles = new Set(allFiles.filter(f => /^[a-zA-Z0-9]{4,12}\.json$/.test(f)).map(f => f.replace('.json', '')))
    const profileFiles = allFiles.filter(f => /^[a-zA-Z0-9]{4,12}_profile\.json$/.test(f)).map(f => f.replace('_profile.json', ''))
    const userIds = new Set([...scheduleFiles, ...profileFiles])
    const users = [...userIds].map(userId => {
      const scheduleFile = path.join(DATA_DIR, `${userId}.json`)
      const data = scheduleFiles.has(userId) ? readData(scheduleFile) : []
      let empId = ''
      let lastUpdate = null
      try {
        const p = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${userId}_profile.json`), 'utf8'))
        empId = p.empId || ''
      } catch {}
      try { lastUpdate = fs.statSync(scheduleFile).mtime } catch {}
      return { userId, count: data.length, empId, lastUpdate }
    })
    res.json(users)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// 刪除使用者（所有相關檔案）
app.delete('/api/admin/users/:userId', adminAuth, (req, res) => {
  const fp = userPath(req.params.userId)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  const base = fp.replace(/\.json$/, '')
  ;['.json', '_profile.json', '_settings.json', '_contacts.json'].forEach(ext => {
    try { fs.unlinkSync(base + ext) } catch {}
  })
  res.json({ ok: true })
})

// 全域設定（Bot URL、API Secret）
const GLOBAL_CONFIG_PATH = path.join(DATA_DIR, '_global_config.json')
app.get('/api/admin/config', adminAuth, (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8'))) }
  catch { res.json({}) }
})
app.post('/api/admin/config', adminAuth, (req, res) => {
  const { botUrl, apiSecret } = req.body
  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify({ botUrl: botUrl || '', apiSecret: apiSecret || '' }, null, 2))
  res.json({ ok: true })
})

// ── PBS 選班幫幫忙 ───────────────────────────────────────────
const PBS_DIR = path.join(_BASE_DIR, 'pbs')

const PBS_CREW_QUOTA = {
  '32Q': { '區域駐防':6, '區域來回':7 },
  '330': { '區域駐防':11, '區域來回':12, '越洋':12 },
  '350': { '區域駐防':12, '區域來回':12, '越洋':12, '超長程':12 },
  '738': { '區域駐防':5, '區域來回':6 },
  '777': { '區域駐防':15, '區域來回':15, '越洋':16, '超長程':16 },
}
const PBS_Y_QUOTA = {
  '32Q': { '區域駐防':3, '區域來回':4 },
  '330': { '區域駐防':6, '區域來回':7 },
  '350': { '區域駐防':6, '區域來回':7, '越洋':6, '超長程':6 },
  '738': { '區域駐防':3, '區域來回':4 },
  '777': { '區域駐防':8, '區域來回':8, '越洋':8, '超長程':8 },
}
const PBS_DOUBLE_CM_SET = new Set([4,8,12,24,32,36,61,81])
const PBS_RT_KEY = { '駐防':'區域駐防', '來回':'區域來回', '越洋':'越洋', '超長程':'超長程' }
fs.mkdirSync(path.join(PBS_DIR, 'bids'), { recursive: true })
fs.mkdirSync(path.join(PBS_DIR, 'results'), { recursive: true })

function readJSON(fp, fallback = null) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')) } catch { return fallback }
}

function pbsBidPath(userId, month) {
  if (!userPath(userId)) return null
  if (!/^\d{4}-\d{2}$/.test(month)) return null
  const dir = path.join(PBS_DIR, 'bids', month)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${userId}.json`)
}

function pbsResultPath(month, round) {
  return path.join(PBS_DIR, 'results', `${month}_r${round}.json`)
}

// 取得自己的志願
app.get('/api/pbs/:userId/bid/:month', (req, res) => {
  const fp = pbsBidPath(req.params.userId, req.params.month)
  if (!fp) return res.status(400).json({ error: '無效參數' })
  res.json(readJSON(fp, null))
})

// 送出/更新志願
app.post('/api/pbs/:userId/bid', (req, res) => {
  const { month, round = 1, cabinClass, seniority, bids } = req.body
  if (!month || !cabinClass || !seniority || !Array.isArray(bids))
    return res.status(400).json({ error: '缺少必要欄位' })
  const fp = pbsBidPath(req.params.userId, month)
  if (!fp) return res.status(400).json({ error: '無效的 userId' })
  const data = {
    userId: req.params.userId, month, round: parseInt(round),
    cabinClass, seniority: parseInt(seniority), bids,
    submittedAt: new Date().toISOString()
  }
  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  res.json({ ok: true })
})

// 取得預測排名
app.get('/api/pbs/prediction/:month', (req, res) => {
  const { userId } = req.query
  const { month } = req.params
  if (!userId) return res.status(400).json({ error: '需要 userId' })

  const myFp = pbsBidPath(userId, month)
  const myBid = myFp ? readJSON(myFp, null) : null
  if (!myBid) return res.json({ hasBid: false })

  // 讀取本月所有人志願
  const bidDir = path.join(PBS_DIR, 'bids', month)
  let allBids = []
  try {
    allBids = fs.readdirSync(bidDir)
      .filter(f => f.endsWith('.json'))
      .map(f => readJSON(path.join(bidDir, f), null))
      .filter(Boolean)
  } catch {}

  const { getGroup, getDateType } = pbsParser
  const myGroup = getGroup(myBid.cabinClass)

  // 讀取歷史結果（第一階段）
  const histResult = readJSON(pbsResultPath(month, 1), null)

  const predictions = myBid.bids.map(bid => {
    const { date, pairing } = bid

    // 找同 pairing+date 的競爭者（CM 獨立；F/Y 合池但分開計數）
    const competitors = allBids
      .filter(b => {
        const g = getGroup(b.cabinClass)
        if (myGroup === 'CM') return g === 'CM'
        return g === 'F' || g === 'Y'
      })
      .filter(b => b.bids.some(bb => bb.date === date && bb.pairing === pairing))
      .sort((a, b) => a.seniority - b.seniority)

    const myRank = competitors.findIndex(b => b.userId === userId) + 1
    const fCount  = competitors.filter(b => getGroup(b.cabinClass) === 'F').length
    const yCount  = competitors.filter(b => getGroup(b.cabinClass) === 'Y').length
    const cmCount = competitors.filter(b => getGroup(b.cabinClass) === 'CM').length
    const total   = myGroup === 'CM' ? cmCount : fCount + yCount

    // 歷史截止名額（從上傳的結果算）
    let historicalCutoff = null
    if (histResult && histResult.entries) {
      const passed = histResult.entries.filter(e =>
        e.date === date && e.pairing === pairing &&
        getGroup(e.cabinClass) === myGroup && e.result === 'V'
      ).length
      const hasReject = histResult.entries.some(e =>
        e.date === date && e.pairing === pairing &&
        getGroup(e.cabinClass) === myGroup && e.reason === '點數排序'
      )
      if (hasReject) historicalCutoff = passed
    }

    // ── 名額模擬（F/Y 組員且有填機型+班型才跑）
    let simulation = null
    if (myGroup !== 'CM' && bid.aircraft && bid.routeType) {
      const rtKey = PBS_RT_KEY[bid.routeType] || bid.routeType
      const totalQuota = (PBS_CREW_QUOTA[bid.aircraft] || {})[rtKey]
      const yMax = (PBS_Y_QUOTA[bid.aircraft] || {})[rtKey]  // undefined = 未知

      if (totalQuota !== undefined) {
        const pairNum = parseInt((pairing.match(/^(\d+)/) || [])[1] || '0')
        const cmSlots = PBS_DOUBLE_CM_SET.has(pairNum) ? 2 : 1
        const fySlots = totalQuota - cmSlots
        const ySlotsCap = yMax !== undefined ? yMax : Infinity

        const sorted = [...competitors].sort((a, b) => a.seniority - b.seniority)
        let fyRem = fySlots
        let yRem = ySlotsCap
        let simResult = null

        for (const comp of sorted) {
          const g = getGroup(comp.cabinClass)
          const isUser = comp.userId === userId
          const canIn = fyRem > 0 && !(g === 'Y' && yRem <= 0)

          if (canIn) { fyRem--; if (g === 'Y') yRem-- }

          if (isUser) {
            simResult = {
              in: canIn,
              reason: canIn ? null : (fyRem <= 0 ? 'fy_full' : 'y_full'),
              fyRem: Math.max(0, fyRem),
              yRem: yRem === Infinity ? null : Math.max(0, yRem),
            }
            break
          }
        }

        simulation = { fySlots, yMax: yMax !== undefined ? yMax : null, ...simResult }
      }
    }

    return { order: bid.order, date, pairing, myRank, myGroup,
             total, fCount, yCount, cmCount,
             dateType: getDateType(date), historicalCutoff, simulation }
  })

  // 熱度燈號（跟本月其他志願相對比較）
  const maxTotal = Math.max(...predictions.map(p => p.total), 1)
  const result = predictions.map(p => ({
    ...p,
    heat: p.total >= maxTotal * 0.65 ? 'hot' :
          p.total >= maxTotal * 0.35 ? 'warm' : 'cool'
  }))

  res.json({
    hasBid: true,
    myBid: { cabinClass: myBid.cabinClass, seniority: myBid.seniority, round: myBid.round },
    totalParticipants: allBids.length,
    predictions: result
  })
})

// 上傳第一階段結果 PDF（管理員，月份由 PDF 自動偵測）
app.post('/api/pbs/result/upload', adminAuth, upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到 PDF' })
  try {
    console.log(`[PBS] 開始解析，檔案大小 ${req.file.size} bytes`)
    const entries = await pbsParser.parsePBSResultPDF(req.file.buffer)
    const month = pbsParser.detectMonth(entries)
    if (!month) return res.status(400).json({ error: '無法從 PDF 偵測月份，請確認檔案正確' })
    console.log(`[PBS] 解析完成，共 ${entries.length} 筆，月份 ${month}`)
    const data = { month, round: 1, uploadedAt: new Date().toISOString(), entries }
    fs.writeFileSync(pbsResultPath(month, 1), JSON.stringify(data, null, 2))
    res.json({ ok: true, parsed: entries.length, month })
  } catch (err) {
    console.error('[PBS] 解析失敗:', err)
    res.status(500).json({ error: 'PDF 解析失敗：' + err.message })
  }
})

// 查詢第二階段剩餘名額
app.get('/api/pbs/availability/:month', (req, res) => {
  const result = readJSON(pbsResultPath(req.params.month, 1), null)
  if (!result) return res.json({ hasResult: false })

  const { getGroup, getDateType } = pbsParser
  const slots = {}
  for (const e of result.entries) {
    const group = getGroup(e.cabinClass)
    if (!group) continue
    const key = `${e.pairing}|${e.date}|${group}`
    if (!slots[key]) slots[key] = {
      pairing: e.pairing, date: e.date, group,
      approved: 0, full: false, dateType: getDateType(e.date)
    }
    if (e.result === 'V') slots[key].approved++
    if (e.result === 'X' && e.reason === '點數排序') slots[key].full = true
  }

  res.json({ hasResult: true, slots: Object.values(slots) })
})

// Multer 錯誤 handler（檔案過大等）
app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `檔案超過上限（最大 25MB），此檔案 ${(err.field||'')} 太大` })
  }
  console.error('[Server Error]', err)
  res.status(500).json({ error: err.message || '伺服器錯誤' })
})

app.listen(PORT, () => {
  console.log(`✅ CCal 啟動：http://localhost:${PORT}`)
  console.log(`📁 資料目錄：${DATA_DIR}`)
})
