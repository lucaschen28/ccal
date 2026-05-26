const express = require('express')
const { exec } = require('child_process')
const fs = require('fs')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000
const cachePath = path.join(__dirname, 'schedule.json')

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

app.listen(PORT, () => {
  console.log(`✅ CCal 啟動：http://localhost:${PORT}`)
})
