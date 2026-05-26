const express = require('express')
const { exec } = require('child_process')
const fs = require('fs')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000
const cachePath = path.join(__dirname, 'schedule.json')

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// 直接回傳快取，不等 parse（快）
app.get('/api/schedule', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    res.json(data)
  } catch {
    res.status(500).json({ error: '找不到班表資料，請先執行 node parse-ecrew.js' })
  }
})

// 手動觸發更新（需要 Calendar app 開著），非同步執行不卡住
app.post('/api/refresh', (req, res) => {
  exec('node parse-ecrew.js', { cwd: __dirname }, (err) => {
    if (err) {
      console.warn('⚠️  行事曆讀取失敗，請確認 Calendar app 有開著')
      return res.status(500).json({ ok: false, error: err.message })
    }
    res.json({ ok: true })
  })
})

// 新增航班
app.post('/api/schedule', (req, res) => {
  const entry = req.body
  if (!entry.date) return res.status(400).json({ error: '缺少 date' })
  entry.id = 'manual_' + Date.now()
  entry.manually_added = true
  const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  data.push(entry)
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2))
  res.json({ ok: true, entry })
})

// 修改航班
app.put('/api/schedule/:id', (req, res) => {
  const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  const idx = data.findIndex(e => e.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: '找不到' })
  data[idx] = { ...data[idx], ...req.body }
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2))
  res.json({ ok: true, entry: data[idx] })
})

// 刪除航班
app.delete('/api/schedule/:id', (req, res) => {
  let data = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  const before = data.length
  data = data.filter(e => e.id !== req.params.id)
  if (data.length === before) return res.status(404).json({ error: '找不到' })
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2))
  res.json({ ok: true })
})

app.listen(PORT, () => {
  console.log(`✅ CCal 啟動：http://localhost:${PORT}`)
})
