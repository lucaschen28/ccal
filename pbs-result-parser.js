/**
 * PBS 選班結果 PDF 解析器
 * 解析「PBS 第一階段選班結果」PDF，回傳結構化資料
 */
const pdfParse = require('pdf-parse')

// 台灣 2026 國定假日（含連假）
const HOLIDAYS_2026 = new Set([
  '2026-01-01',
  '2026-01-26','2026-01-27','2026-01-28','2026-01-29','2026-01-30','2026-02-02',
  '2026-02-28',
  '2026-04-03','2026-04-04','2026-04-05','2026-04-06',
  '2026-05-01',
  '2026-06-19','2026-06-20','2026-06-21',
  '2026-09-24','2026-09-25','2026-09-26','2026-09-27',
  '2026-10-09','2026-10-10','2026-10-11','2026-10-12',
])

function getDateType(dateStr) {
  if (HOLIDAYS_2026.has(dateStr)) return 'holiday'
  const dow = new Date(dateStr + 'T12:00:00').getDay()
  return (dow === 0 || dow === 6) ? 'weekend' : 'weekday'
}

async function parsePBSResultPDF(buffer) {
  const data = await pdfParse(buffer)
  return parsePBSText(data.text)
}

function parsePBSText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l)
  const entries = []

  for (const line of lines) {
    // 每行必須有：日期 + pairing + 結果(V/X)
    const m = line.match(/(\d{4}\/\d{2}\/\d{2})\s+(\d+\s?RDO|\d{2,4}[A-Z])\s+([VX])/)
    if (!m) continue

    const [yy, mm, dd] = m[1].split('/')
    const date    = `${yy}-${mm}-${dd}`
    const pairing = m[2].replace(/\s/g, '')
    const result  = m[3]

    const reason =
      line.includes('點數排序') ? '點數排序' :
      line.includes('志願衝突') ? '志願衝突' :
      line.includes('違反法規') ? '違反法規' :
      line.includes('訓練課程') ? '訓練衝突' :
      line.includes('差假衝突') ? '差假衝突' :
      line.includes('其他')     ? '其他' : ''

    const clsM = line.match(/\b(CM\*代理座艙長|CM|FF|MF|FY|MY)\b/)
    if (!clsM) continue
    const cabinClass = clsM[1].replace('*代理座艙長', '').trim()

    // 嘗試抓資深序號（行首的數字）
    const senM = line.match(/^\s*(\d+)\s/)
    const seniority = senM ? parseInt(senM[1]) : null

    entries.push({ seniority, cabinClass, date, pairing, result, reason })
  }

  return entries
}

function getGroup(cabinClass) {
  if (cabinClass === 'CM') return 'CM'
  if (['FF', 'MF'].includes(cabinClass)) return 'F'
  if (['FY', 'MY'].includes(cabinClass)) return 'Y'
  return null
}

module.exports = { parsePBSResultPDF, parsePBSText, getDateType, getGroup }
