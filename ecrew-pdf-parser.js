/**
 * eCrew PDF Parser
 * 解析 China Airlines Personal Crew Schedule Report PDF
 */
const pdfParse = require('pdf-parse')

const AC_MAP = {
  '359':'A350', '35K':'A350', '333':'A330', '332':'A330',
  '32Q':'A320', '321':'A321', '320':'A320', '32A':'A320',
  '738':'B738', '73H':'B738', '77W':'B777', '77L':'B777', '744':'B744'
}

// DD/MM/YYYY → YYYY-MM-DD
function toISO(ddmmyyyy) {
  const [d, m, y] = ddmmyyyy.split('/')
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`
}

// 從時間字串抽出所有 HH:MM，回傳 { t:'HHMM', isActual:bool, crossDay:bool }
function extractTimes(s) {
  // 匹配 [A]HH:MM[/HH:MM][+1/⁺¹]
  const re = /(A?)(\d{2}):(\d{2})(?:\/\d{2}:\d{2})?([⁺+]\d*)?/g
  const times = []
  let m
  while ((m = re.exec(s)) !== null) {
    if (parseInt(m[2], 10) > 23) continue  // 排除 74:25 這類累計飛時
    times.push({
      t:        m[2] + m[3],
      isActual: m[1] === 'A',
      crossDay: !!(m[4])
    })
  }
  return times
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

const DATE_RE   = /^(\d{2}\/\d{2}\/\d{4})\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*/
const CREW_RE   = /^(CA|FO|CM|F|Y|RP|JR|SP)\s*[-–]\s*(ACM\s*[-–]\s*)?\d/
const OFF_CODES = ['ADO', '>OFF', 'OFF', 'RDO', 'AL', 'XL', 'HC']
const SKIP_RE   = /^(Generated on|Page \d|China Airlines|Schedule Details|Total Hours|Block Hours|Expiry Dates?|Code Desc|Pax Transfer|Descriptions?|Duty Codes?|Indicators?|ADO\s*[-–]|>?OFF\s*[-–]|RDO\s*[-–]|\d{2,3}:\d{2}\s+\d{2,3}:\d{2}|ECM\/JCM|All times)/

module.exports = async function parseECrewPDF(buffer) {
  const data = await pdfParse(buffer)
  return parsePDFText(data.text)
}

function parsePDFText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)

  // 分組：每個 DD/MM/YYYY 開頭為一個 block
  const blocks = []
  let cur = null
  for (const line of lines) {
    if (SKIP_RE.test(line)) continue
    if (CREW_RE.test(line)) continue

    const dm = line.match(DATE_RE)
    if (dm) {
      cur = { date: toISO(dm[1]), body: [line.replace(DATE_RE, '').trim()] }
      blocks.push(cur)
    } else if (cur) {
      cur.body.push(line)
    }
  }

  const entries = []

  for (const { date, body } of blocks) {
    const firstLine = body[0] || ''

    // ── 休假類型 ──────────────────────────────────────────────
    const offCode = firstLine && OFF_CODES.find(c => firstLine.startsWith(c))
    if (offCode) {
      entries.push({
        id:             `ecrew_${date}_${offCode}`,
        type:           'day_off',
        code:           offCode,
        date,
        ecrew_imported: true
      })
      continue
    }

    // 只有指標（S / R / S,R）→ 跳過
    if (/^[SR,]+$/.test(firstLine)) continue

    // ── 待命（S1~S8 現場待命 / HS1~HS8 居家待命）─────────────
    const standbyMatch = firstLine.match(/^(HS[1-8]|S[1-8])(?:\s|$)/)
    if (standbyMatch) {
      const sbCode = standbyMatch[1]
      const allSbText = body.join(' ')
      const sbTimes = extractTimes(allSbText)
      const sbEntry = {
        id:             `ecrew_${date}_${sbCode}`,
        type:           'standby',
        code:           sbCode,
        date,
        ecrew_imported: true
      }
      if (sbTimes.length >= 2) {
        sbEntry.start_time = sbTimes[0].t
        sbEntry.end_time   = sbTimes[sbTimes.length - 1].t
      } else if (sbTimes.length === 1) {
        sbEntry.start_time = sbTimes[0].t
      }
      entries.push(sbEntry)
      continue
    }

    // ── 受訓 ──────────────────────────────────────────────────
    const TRAINING_CODES = ['CM', 'SEP', 'CRM', 'LT', 'OE', 'RECUR']
    const trainingCode = body.find(l => TRAINING_CODES.includes(l.trim()))
    if (trainingCode) {
      // 找所有 HH:MM - HH:MM 時間段
      const allText0 = body.join(' ')
      const trRe = /(\d{2}):(\d{2})\s*[-–]\s*(\d{2}):(\d{2})/g
      const ranges = []
      let trm
      while ((trm = trRe.exec(allText0)) !== null) {
        if (parseInt(trm[1]) <= 23 && parseInt(trm[3]) <= 23)
          ranges.push({ start: trm[1]+trm[2], end: trm[3]+trm[4] })
      }
      const entry = {
        id:             `ecrew_${date}_training`,
        type:           'training',
        code:           trainingCode.trim(),
        date,
        ecrew_imported: true
      }
      if (ranges.length > 0) {
        entry.start_time = ranges[0].start
        entry.end_time   = ranges[ranges.length - 1].end
      }
      entries.push(entry)
      continue
    }

    // ── 飛航任務 ──────────────────────────────────────────────
    const allText = body.join(' ')

    // 1) 班號 & 機型
    const flightNums = []
    const acTypes    = []
    for (const line of body) {
      // 有機型：123 [32Q] 或 123 [32Q] 路線...
      const withAC = line.match(/^(\d{1,4})\s*\[(\w+)\]/)
      if (withAC) { flightNums.push(withAC[1]); acTypes.push(AC_MAP[withAC[2]] || withAC[2]); continue }
      // 只有班號（無機型，如 ACM 航班 190）
      const bare = line.match(/^\*?(\d{1,4})$/)
      if (bare) { flightNums.push(bare[1]); acTypes.push(null) }
    }
    if (flightNums.length === 0) continue

    // 2) 路線
    const routes   = []
    const routeRe  = /\*?([A-Z]{3})\s*[-–]\s*([A-Z]{3})/g
    let rm
    while ((rm = routeRe.exec(allText)) !== null) {
      routes.push({ from: rm[1], to: rm[2] })
    }

    const N = flightNums.length

    // 3) 時間解析
    const times = extractTimes(allText)
    // 期望: [report, dep1, arr1, dep2, arr2, ..., depN, arrN, debrief]
    let reportTime  = null
    let debriefTime = null
    let depArr      = []   // [{ dep, arr }] per leg

    const expected = N * 2 + 2
    const hasActual = times.some(t => t.isActual)

    if (times.length >= N * 2) {
      if (times.length === N * 2 + 2) {
        // 完整：report + N對 + debrief
        reportTime  = times[0].t
        debriefTime = times[times.length - 1].t
        for (let i = 0; i < N; i++) {
          depArr.push({ dep: times[1 + i*2], arr: times[2 + i*2] })
        }
      } else if (times.length === N * 2 + 1) {
        if (!times[0].isActual && hasActual) {
          // 有 report 沒有 debrief
          reportTime = times[0].t
          for (let i = 0; i < N; i++) {
            depArr.push({ dep: times[1 + i*2], arr: times[2 + i*2] })
          }
        } else {
          // 有 debrief 沒有 report
          debriefTime = times[times.length - 1].t
          for (let i = 0; i < N; i++) {
            depArr.push({ dep: times[i*2], arr: times[1 + i*2] })
          }
        }
      } else if (times.length === N * 2) {
        // 無 report / debrief
        for (let i = 0; i < N; i++) {
          depArr.push({ dep: times[i*2], arr: times[1 + i*2] })
        }
      } else {
        // 時間超過預期，取最外兩個為 report/debrief
        reportTime  = times[0].t
        debriefTime = times[times.length - 1].t
        for (let i = 0; i < N; i++) {
          const idx = 1 + i * 2
          if (idx + 1 < times.length - 1) {
            depArr.push({ dep: times[idx], arr: times[idx + 1] })
          }
        }
      }
    }

    // 4) 建立 entry（同天多腿共用 duty_id）
    const dutyId = `duty_ecrew_${date}_${flightNums[0]}`
    for (let i = 0; i < N; i++) {
      const da  = depArr[i]
      const entry = {
        id:             `ecrew_${date}_${flightNums[i]}_${i}`,
        duty_id:        dutyId,
        type:           'flight',
        date,
        flight_number:  flightNums[i],
        ecrew_imported: true
      }
      if (acTypes[i])           entry.aircraft_type       = acTypes[i]
      if (routes[i])            { entry.from = routes[i].from; entry.to = routes[i].to }
      if (i === 0 && reportTime) entry.reporting          = reportTime
      if (da?.dep) {
        const key = da.dep.isActual ? 'departure_actual' : 'departure_scheduled'
        entry[key] = da.dep.t
      }
      if (da?.arr) {
        const key = da.arr.isActual ? 'arrival_actual' : 'arrival_scheduled'
        entry[key] = da.arr.t
        // 跨日降落
        if (da.arr.crossDay) entry.arrival_next_day = true
      }
      if (i === N - 1 && debriefTime) entry.debrief = debriefTime
      entries.push(entry)
    }
  }

  linkLayovers(entries)
  return entries
}

// 可單獨呼叫：合併多個 PDF 解析結果後再跑一次
function linkLayovers(entries) {
  const HOME = new Set(['TPE', 'TSA'])
  const flights = entries
    .filter(e => e.type === 'flight')
    .sort((a, b) => a.date.localeCompare(b.date))

  for (let i = 0; i < flights.length; i++) {
    const out = flights[i]
    if (!out.from || !HOME.has(out.from)) continue
    if (!out.to   ||  HOME.has(out.to))   continue

    const alreadyLinked = flights.some(g =>
      g.duty_id === out.duty_id && HOME.has(g.to)
    )
    if (alreadyLinked) continue

    for (let j = i + 1; j < flights.length; j++) {
      const ret = flights[j]
      if (HOME.has(ret.from) && !HOME.has(ret.to)) break
      if (ret.from === out.to && HOME.has(ret.to)) {
        ret.duty_id = out.duty_id
        break
      }
    }
  }
}

module.exports.parsePDFText = parsePDFText
module.exports.linkLayovers = linkLayovers
