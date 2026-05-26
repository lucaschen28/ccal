const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// 寫成暫存 AppleScript 檔避免引號問題
const script = `
tell application "Calendar"
  tell calendar "eCrew"
    set theEvents to every event whose start date > (current date) - 30 * days and start date < (current date) + 60 * days
    set output to ""
    repeat with e in theEvents
      set output to output & "===START===" & return
      set output to output & "title:" & summary of e & return
      set output to output & "start:" & (start date of e as string) & return
      set output to output & "end:" & (end date of e as string) & return
      try
        set output to output & "notes:" & description of e & return
      on error
        set output to output & "notes:" & return
      end try
      set output to output & "===END===" & return
    end repeat
    return output
  end tell
end tell
`

const tmpFile = path.join(os.tmpdir(), 'ecrew_fetch.applescript')
fs.writeFileSync(tmpFile, script)
const raw = execSync(`osascript "${tmpFile}"`, { maxBuffer: 10 * 1024 * 1024 }).toString()
fs.unlinkSync(tmpFile)

// 解析中文日期格式：「2026年5月13日 星期三 下午3:55:00」
function parseChineseDate(str) {
  const match = str.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s+\S+\s+(.+)/)
  if (!match) return null
  const [, year, month, day, timeStr] = match
  // 把原始日期存在 result 上，避免 UTC 轉換造成日期偏移

  const timePrefixes = {
    '凌晨': (h) => h === 12 ? 0 : h,
    '清晨': (h) => h,
    '早上': (h) => h,
    '上午': (h) => h === 12 ? 0 : h,
    '中午': (h) => h,
    '下午': (h) => h === 12 ? 12 : h + 12,
    '晚上': (h) => h === 12 ? 12 : h + 12,
  }

  let adjustHour = (h) => h
  let cleanTime = timeStr
  for (const [prefix, fn] of Object.entries(timePrefixes)) {
    if (timeStr.startsWith(prefix)) {
      adjustHour = fn
      cleanTime = timeStr.slice(prefix.length)
      break
    }
  }

  const timeParts = cleanTime.split(':').map(Number)
  const hour = adjustHour(timeParts[0])
  const minute = timeParts[1] || 0
  const second = timeParts[2] || 0

  const d = new Date(Number(year), Number(month) - 1, Number(day), hour, minute, second)
  d._localDate = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`
  return d
}

function parseEvent(block) {
  const lines = block.split('\n')
  const get = (key) => {
    const line = lines.find(l => l.startsWith(key + ':'))
    return line ? line.slice(key.length + 1).trim() : ''
  }

  const title = get('title').trim()
  const startDate = parseChineseDate(get('start'))
  const endDate = parseChineseDate(get('end'))
  if (!startDate) return null

  // notes 可能跨多行
  const notesIdx = lines.findIndex(l => l.startsWith('notes:'))
  const notesFirstLine = notesIdx >= 0 ? lines[notesIdx].slice(6) : ''
  const notesRest = notesIdx >= 0 ? lines.slice(notesIdx + 1).filter(l => !l.startsWith('===END===')).join('\n') : ''
  const fullNotes = (notesFirstLine + '\n' + notesRest).trim()

  const dayOffCodes = ['OFF', 'ADO', 'RDO', 'SBY', 'STB', '>OFF']
  const titleCode = title.split(/\s+/)[0]
  const isDayOff = dayOffCodes.includes(titleCode)

  if (!startDate || isNaN(startDate.getTime())) {
    console.error('❌ 日期解析失敗:', get('start'))
    return null
  }

  const event = {
    type: isDayOff ? 'day_off' : 'flight',
    title,
    date: startDate._localDate,
    start: startDate.toISOString(),
    end: (endDate && !isNaN(endDate.getTime())) ? endDate.toISOString() : null,
  }

  if (!isDayOff) {
    const reportMatch = fullNotes.match(/Reporting time\s*:\s*(\d{4})/)
    const debriefMatch = fullNotes.match(/Debriefing time\s*:\s*(\d{4})/)
    const flightMatch = title.match(/^(\d+)\s+([A-Z]{3})-([A-Z]{3})/)

    if (flightMatch) {
      event.flight_number = flightMatch[1]
      event.from = flightMatch[2]
      event.to = flightMatch[3]
    }
    if (reportMatch) event.reporting = reportMatch[1]
    if (debriefMatch) event.debrief = debriefMatch[1]

    // 解析航班起降時間
    // (A1713) = 實際時間，(1713) = 表定時間
    const routeMatch = fullNotes.match(/\d+\s+-\s+[A-Z]{3}\s+\((A?)(\d{4})\)\s+-\s+[A-Z]{3}\s+\((A?)(\d{4})/)
    if (routeMatch) {
      const depIsActual = routeMatch[1] === 'A'
      const arrIsActual = routeMatch[3] === 'A'
      event.departure = routeMatch[2]
      event.departure_is_actual = depIsActual
      event.arrival = routeMatch[4]
      event.arrival_is_actual = arrIsActual
      // 分開存表定與實際，方便日後換班設計與 FDP 計算
      if (depIsActual) event.departure_actual    = routeMatch[2]
      else             event.departure_scheduled = routeMatch[2]
      if (arrIsActual) event.arrival_actual      = routeMatch[4]
      else             event.arrival_scheduled   = routeMatch[4]
    }
  } else {
    event.code = titleCode
  }

  return event
}

const outputPath = path.join(__dirname, 'schedule.json')

// 讀取舊資料，保留已知的表定時間（飛完後 eCrew 只剩實際時間）
let prevSchedule = []
try { prevSchedule = JSON.parse(fs.readFileSync(outputPath, 'utf8')) } catch {}

const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
const blocks = normalized.split('===START===').filter(b => b.includes('===END==='))
const events = blocks.map(parseEvent).filter(Boolean).sort((a, b) => new Date(a.start) - new Date(b.start))

// Merge：補回舊資料裡已存的表定/實際時間
events.forEach(ev => {
  if (ev.type !== 'flight') return
  const prev = prevSchedule.find(p => p.type === 'flight' && p.flight_number === ev.flight_number && p.date === ev.date)
  if (!prev) return
  if (!ev.departure_scheduled && prev.departure_scheduled) ev.departure_scheduled = prev.departure_scheduled
  if (!ev.departure_actual    && prev.departure_actual)    ev.departure_actual    = prev.departure_actual
  if (!ev.arrival_scheduled   && prev.arrival_scheduled)   ev.arrival_scheduled   = prev.arrival_scheduled
  if (!ev.arrival_actual      && prev.arrival_actual)      ev.arrival_actual      = prev.arrival_actual
})

fs.writeFileSync(outputPath, JSON.stringify(events, null, 2))
console.log(`✅ 解析完成：${events.length} 筆事件 → ${outputPath}`)
console.log('\n預覽（前 5 筆）:')
console.log(JSON.stringify(events.slice(0, 5), null, 2))
