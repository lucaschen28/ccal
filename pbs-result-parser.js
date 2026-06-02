/**
 * PBS 選班結果 PDF 解析器
 *
 * PDF 內有兩種排版格式：
 * 格式 A（CM）：單行資料 + 下一行 V/X
 *   30633***李○○CM22026/06/13 53A
 *   X5.志願衝突
 *
 * 格式 B（F/Y）：三行一組，結果在第三行末尾
 *   4
 *   634***程○○
 *   FF22026/06/06 4AV
 */
const pdfParse = require('pdf-parse')

async function parsePBSResultPDF(buffer) {
  const data = await pdfParse(buffer)
  return parsePBSText(data.text)
}

function parsePBSText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l)
  const entries = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // ── 格式 A：{numPrefix}***{name}{CC}{bidOrder}{date} {content} ──
    // 下一行為 V 或 X{reason}
    const mA = line.match(/^(\d+)\*{3}.+?(CM|FF|MF|FY|MY)(\d)(\d{4}\/\d{2}\/\d{2})\s+(.+)$/)
    if (mA) {
      const [, numBefore, cabinClass, , dateRaw, content] = mA
      const nextLine = lines[i + 1] || ''
      const resM = nextLine.match(/^([VX])/)
      if (resM) {
        const entry = buildEntry(numBefore, cabinClass, dateRaw, content, resM[1], nextLine)
        if (entry) entries.push(entry)
      }
      continue
    }

    // ── 格式 B：seniority（單獨一行） / empId***name / CC+data+result ──
    if (/^\d+$/.test(line) && i + 2 < lines.length) {
      const empLine  = lines[i + 1]
      const dataLine = lines[i + 2]

      if (empLine.includes('***')) {
        const mB = dataLine.match(/^(FF|MF|FY|MY)(\d)(\d{4}\/\d{2}\/\d{2})\s+(.+?)([VX].*)$/)
        if (mB) {
          const [, cabinClass, , dateRaw, content, resultTail] = mB
          const entry = buildEntry(line, cabinClass, dateRaw, content.trim(), resultTail[0], resultTail)
          if (entry) entries.push(entry)
          i += 2
          continue
        }
      }
    }
  }

  return entries
}

function buildEntry(senSource, cabinClass, dateRaw, content, result, reasonStr) {
  const pairing = parsePairing(content)
  if (!pairing) return null

  const [yy, mm, dd] = dateRaw.split('/')
  const date = `${yy}-${mm}-${dd}`

  // 從 senSource 萃取序號：最後 3 位是員編前綴，其餘是序號
  const senStr = String(senSource)
  const sen = senStr.length > 3 ? parseInt(senStr.slice(0, -3)) : parseInt(senStr)
  const seniority = isNaN(sen) ? null : sen

  return { seniority, cabinClass, date, pairing, result, reason: parseReason(reasonStr) }
}

function parsePairing(content) {
  const rdoM = content.match(/^(\d+)\s*RDO/i)
  if (rdoM) return rdoM[1] + 'RDO'
  const pairM = content.match(/^(\d{1,4}[A-Z]+)/)
  if (pairM) return pairM[1]
  return null
}

function parseReason(str) {
  if (!str) return ''
  if (str.includes('點數排序')) return '點數排序'
  if (str.includes('志願衝突')) return '志願衝突'
  if (str.includes('違反法規')) return '違反法規'
  if (str.includes('訓練'))   return '訓練衝突'
  if (str.includes('差假'))   return '差假衝突'
  if (str.includes('其他'))   return '其他'
  return ''
}

/** 從解析結果自動偵測月份（取最多出現的 yyyy-mm） */
function detectMonth(entries) {
  const counts = {}
  for (const e of entries) {
    const ym = e.date.slice(0, 7)
    counts[ym] = (counts[ym] || 0) + 1
  }
  let best = null, bestN = 0
  for (const [ym, n] of Object.entries(counts)) {
    if (n > bestN) { best = ym; bestN = n }
  }
  return best
}

function getDateType(dateStr) {
  const HOLIDAYS = new Set([
    '2026-01-01','2026-01-26','2026-01-27','2026-01-28','2026-01-29','2026-01-30','2026-02-02',
    '2026-02-28','2026-04-03','2026-04-04','2026-04-05','2026-04-06','2026-05-01',
    '2026-06-19','2026-06-20','2026-06-21',
    '2026-09-24','2026-09-25','2026-09-26','2026-09-27',
    '2026-10-09','2026-10-10','2026-10-11','2026-10-12',
  ])
  if (HOLIDAYS.has(dateStr)) return 'holiday'
  const dow = new Date(dateStr + 'T12:00:00').getDay()
  return (dow === 0 || dow === 6) ? 'weekend' : 'weekday'
}

function getGroup(cabinClass) {
  if (cabinClass === 'CM') return 'CM'
  if (['FF', 'MF'].includes(cabinClass)) return 'F'
  if (['FY', 'MY'].includes(cabinClass)) return 'Y'
  return null
}

module.exports = { parsePBSResultPDF, parsePBSText, detectMonth, getDateType, getGroup }
