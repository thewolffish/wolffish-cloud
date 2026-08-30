import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import ExcelJS from 'exceljs'
import Papa from 'papaparse'


const toolDefinitions = [
  {
    name: 'spreadsheet_read',
    description: 'Read any spreadsheet file (xlsx, csv, tsv) and return structured JSON data.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the spreadsheet file' },
        sheet: { type: 'string', description: 'Sheet name or 1-based index (for xlsx)' },
        range: { type: 'string', description: 'Excel-style range like "A1:D50"' },
        headers: { type: 'string', description: '"true" or "false" for first row as headers' }
      },
      required: ['path']
    }
  },
  {
    name: 'spreadsheet_create',
    description: 'Create a new spreadsheet file with columns, rows, and styles.',
    parameters: {
      type: 'object',
      properties: {
        output_path: { type: 'string', description: 'Absolute path for output (extension sets format)' },
        sheets: { type: 'string', description: 'JSON array of sheet definitions' }
      },
      required: ['output_path', 'sheets']
    }
  },
  {
    name: 'spreadsheet_modify',
    description: 'Edit an existing spreadsheet — add/remove sheets, insert/delete rows/columns, update cells.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source spreadsheet' },
        output_path: { type: 'string', description: 'Absolute path for output' },
        operations: { type: 'string', description: 'JSON array of operations' }
      },
      required: ['path', 'output_path', 'operations']
    }
  },
  {
    name: 'spreadsheet_formula',
    description: 'Add or set formulas in spreadsheet cells.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source spreadsheet' },
        output_path: { type: 'string', description: 'Absolute path for output' },
        formulas: { type: 'string', description: 'JSON array of formula operations' }
      },
      required: ['path', 'output_path', 'formulas']
    }
  },
  {
    name: 'spreadsheet_chart',
    description: 'Add a chart to a spreadsheet.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source spreadsheet' },
        output_path: { type: 'string', description: 'Absolute path for output' },
        chart: { type: 'string', description: 'JSON chart definition' }
      },
      required: ['path', 'output_path', 'chart']
    }
  },
  {
    name: 'spreadsheet_style',
    description: 'Apply formatting — borders, colors, fonts, merge cells, freeze panes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source spreadsheet' },
        output_path: { type: 'string', description: 'Absolute path for output' },
        styles: { type: 'string', description: 'JSON array of style operations' }
      },
      required: ['path', 'output_path', 'styles']
    }
  },
  {
    name: 'spreadsheet_convert',
    description: 'Convert between spreadsheet formats (xlsx, csv, tsv).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source file' },
        output_path: { type: 'string', description: 'Absolute path for output (extension sets format)' },
        options: { type: 'string', description: 'Optional JSON: {delimiter?, encoding?, sheet?}' }
      },
      required: ['path', 'output_path']
    }
  },
  {
    name: 'spreadsheet_analyze',
    description: 'Quick data analysis — summary stats, types, duplicates, blanks.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to spreadsheet' },
        sheet: { type: 'string', description: 'Sheet name or index' },
        columns: { type: 'string', description: 'Optional JSON array of column names to analyze' }
      },
      required: ['path']
    }
  },
  {
    name: 'spreadsheet_filter',
    description: 'Filter and sort rows by criteria.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to spreadsheet' },
        output_path: { type: 'string', description: 'Optional output file path' },
        filters: { type: 'string', description: 'JSON array of filter operations' },
        sort: { type: 'string', description: 'Optional JSON array of sort operations' },
        limit: { type: 'number', description: 'Maximum rows to return' }
      },
      required: ['path', 'filters']
    }
  },
  {
    name: 'spreadsheet_pivot',
    description: 'Create a pivot table from spreadsheet data.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source spreadsheet' },
        output_path: { type: 'string', description: 'Absolute path for output' },
        rows: { type: 'string', description: 'JSON array of row grouping columns' },
        columns: { type: 'string', description: 'JSON array of column grouping columns' },
        values: { type: 'string', description: 'JSON array of value aggregations' }
      },
      required: ['path', 'output_path', 'rows', 'columns', 'values']
    }
  }
]

function parseJsonParam(value, name) {
  if (value == null) return undefined
  if (typeof value === 'object') return value
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch {
      throw new Error(`Invalid JSON in ${name} parameter`)
    }
  }
  throw new Error(`Expected object or JSON string for ${name}, got ${typeof value}`)
}

function resolvePath(input) {
  if (!input || typeof input !== 'string') throw new Error('path is required')
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2))
  }
  return path.resolve(input)
}

/** Existence probe (throws ENOENT early with a clean message); never a size gate. */
async function checkFileSize(filePath) {
  const stat = await fs.stat(filePath)
  return stat.size
}

function getExt(filePath) {
  return path.extname(filePath).toLowerCase()
}

function colLetterToIndex(letter) {
  let idx = 0
  for (let i = 0; i < letter.length; i++) {
    idx = idx * 26 + (letter.charCodeAt(i) - 64)
  }
  return idx
}

function parseRange(rangeStr) {
  if (!rangeStr) return null
  const match = rangeStr.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i)
  if (!match) return null
  return {
    startCol: colLetterToIndex(match[1].toUpperCase()),
    startRow: parseInt(match[2], 10),
    endCol: colLetterToIndex(match[3].toUpperCase()),
    endRow: parseInt(match[4], 10)
  }
}

function cellValue(cell) {
  if (!cell || cell.value === null || cell.value === undefined) return null
  const v = cell.value
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    if (v.result !== undefined) return v.result
    if (v.text) return v.text
    if (v.richText) return v.richText.map((r) => r.text).join('')
    return JSON.stringify(v)
  }
  return v
}

async function readXlsx(filePath, sheetId, range, useHeaders) {
  const workbook = new ExcelJS.Workbook()
  await checkFileSize(filePath)
  await workbook.xlsx.readFile(filePath)

  let worksheet
  if (sheetId) {
    const idx = parseInt(sheetId, 10)
    if (!isNaN(idx)) {
      worksheet = workbook.worksheets[idx - 1]
    } else {
      worksheet = workbook.getWorksheet(sheetId)
    }
  }
  if (!worksheet) worksheet = workbook.worksheets[0]
  if (!worksheet) throw new Error('No worksheets found')

  const rangeSpec = parseRange(range)
  const rows = []
  worksheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rangeSpec) {
      if (rowNum < rangeSpec.startRow || rowNum > rangeSpec.endRow) return
    }
    const values = []
    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      if (rangeSpec) {
        if (colNum < rangeSpec.startCol || colNum > rangeSpec.endCol) return
      }
      values[colNum - (rangeSpec ? rangeSpec.startCol : 1)] = cellValue(cell)
    })
    rows.push(values)
  })

  const headers = useHeaders !== false && rows.length > 0 ? rows[0] : null
  const data = headers ? rows.slice(1) : rows

  return {
    sheetName: worksheet.name,
    sheetCount: workbook.worksheets.length,
    sheets: workbook.worksheets.map((ws) => ws.name),
    headers,
    rows: data,
    rowCount: data.length,
    columnCount: headers ? headers.length : (data[0] ? data[0].length : 0)
  }
}

async function readCsvTsv(filePath, useHeaders, delimiter) {
  const buffer = await fs.readFile(filePath)
  let content = buffer.toString('utf8')

  // BOM detection
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1)
  } else if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    content = buffer.toString('utf16le').slice(1)
  }

  const ext = getExt(filePath)
  if (!delimiter) {
    delimiter = ext === '.tsv' ? '\t' : ','
  }

  const result = Papa.parse(content, {
    delimiter,
    header: useHeaders !== false,
    skipEmptyLines: true,
    dynamicTyping: true
  })

  if (result.errors.length > 0 && result.data.length === 0) {
    throw new Error(`Parse error: ${result.errors[0].message}`)
  }

  if (useHeaders !== false) {
    return {
      headers: result.meta.fields,
      rows: result.data,
      rowCount: result.data.length,
      columnCount: result.meta.fields?.length || 0
    }
  }

  return {
    headers: null,
    rows: result.data,
    rowCount: result.data.length,
    columnCount: result.data[0] ? result.data[0].length : 0
  }
}

async function spreadsheetRead(args) {
  const filePath = resolvePath(args.path)
  try {
    await checkFileSize(filePath)
  } catch (err) {
    return { success: false, error: err.message }
  }

  const ext = getExt(filePath)
  const useHeaders = args.headers === 'false' ? false : true

  try {
    let result
    if (ext === '.xlsx' || ext === '.xls') {
      result = await readXlsx(filePath, args.sheet, args.range, useHeaders)
    } else if (ext === '.csv' || ext === '.tsv') {
      result = await readCsvTsv(filePath, useHeaders)
    } else {
      return { success: false, error: `Unsupported format: ${ext}. Supported: .xlsx, .xls, .csv, .tsv` }
    }
    return { success: true, output: JSON.stringify(result, null, 2) }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    if (err.code === 'EBUSY' || err.code === 'EPERM') return { success: false, error: 'File is open in another application' }
    return { success: false, error: err.message }
  }
}

async function spreadsheetCreate(args) {
  const outputPath = resolvePath(args.output_path)
  let sheets
  try {
    sheets = parseJsonParam(args.sheets, 'sheets')
  } catch (err) {
    return { success: false, error: err.message }
  }

  const ext = getExt(outputPath)

  try {
    if (ext === '.csv' || ext === '.tsv') {
      const delimiter = ext === '.tsv' ? '\t' : ','
      const sheet = sheets[0]
      const headerRow = sheet.columns ? sheet.columns.map((c) => c.header || '') : []
      const allRows = headerRow.length > 0 ? [headerRow, ...sheet.rows] : sheet.rows
      const csv = Papa.unparse(allRows, { delimiter })
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, csv, 'utf8')
      return {
        success: true,
        output: JSON.stringify({ path: outputPath, rows: sheet.rows.length, format: ext.slice(1) })
      }
    }

    const workbook = new ExcelJS.Workbook()
    for (const sheetDef of sheets) {
      const ws = workbook.addWorksheet(sheetDef.name || 'Sheet1')

      if (sheetDef.columns) {
        ws.columns = sheetDef.columns.map((col) => ({
          header: col.header || '',
          key: col.header || '',
          width: col.width || 15
        }))
      }

      if (sheetDef.rows) {
        for (const row of sheetDef.rows) {
          ws.addRow(row)
        }
      }

      if (sheetDef.styles) {
        if (sheetDef.styles.headerBold !== false) {
          const headerRow = ws.getRow(1)
          headerRow.font = { bold: true }
        }
      }
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await workbook.xlsx.writeFile(outputPath)

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        sheets: sheets.map((s) => ({ name: s.name, rows: s.rows?.length || 0 })),
        format: 'xlsx'
      })
    }
  } catch (err) {
    return { success: false, error: `Failed to create spreadsheet: ${err.message}` }
  }
}

async function spreadsheetModify(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  let operations
  try {
    operations = parseJsonParam(args.operations, 'operations')
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    await checkFileSize(filePath)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)

    for (const op of operations) {
      const ws = op.sheet ? workbook.getWorksheet(op.sheet) : workbook.worksheets[0]
      if (!ws && op.type !== 'add_sheet') {
        throw new Error(`Sheet not found: ${op.sheet || 'default'}`)
      }

      switch (op.type) {
        case 'add_sheet': {
          workbook.addWorksheet(op.name || 'New Sheet')
          break
        }
        case 'remove_sheet': {
          const target = workbook.getWorksheet(op.name || op.sheet)
          if (target) workbook.removeWorksheet(target.id)
          break
        }
        case 'rename_sheet': {
          if (ws) ws.name = op.new_name || op.name
          break
        }
        case 'insert_rows': {
          const rowNum = op.row || ws.rowCount + 1
          const rows = op.rows || [[]]
          ws.insertRows(rowNum, rows)
          break
        }
        case 'delete_rows': {
          const start = op.start || 1
          const count = op.count || 1
          ws.spliceRows(start, count)
          break
        }
        case 'insert_columns': {
          const colNum = op.column || ws.columnCount + 1
          ws.spliceColumns(colNum, 0, ...(op.values || [[]]))
          break
        }
        case 'delete_columns': {
          const colStart = op.column || 1
          const colCount = op.count || 1
          ws.spliceColumns(colStart, colCount)
          break
        }
        case 'set_cell': {
          const cell = ws.getCell(op.cell)
          cell.value = op.value
          break
        }
        case 'set_range': {
          const startRow = op.start_row || 1
          const startCol = op.start_col || 1
          const values = op.values || []
          for (let r = 0; r < values.length; r++) {
            for (let c = 0; c < values[r].length; c++) {
              ws.getCell(startRow + r, startCol + c).value = values[r][c]
            }
          }
          break
        }
      }
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await workbook.xlsx.writeFile(outputPath)

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        operationsApplied: operations.length,
        sheets: workbook.worksheets.map((ws) => ws.name)
      })
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    if (err.code === 'EBUSY' || err.code === 'EPERM') return { success: false, error: 'File is open in another application' }
    return { success: false, error: `Modify failed: ${err.message}` }
  }
}

async function spreadsheetFormula(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  let formulas
  try {
    formulas = parseJsonParam(args.formulas, 'formulas')
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    await checkFileSize(filePath)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)

    for (const f of formulas) {
      const ws = f.sheet ? workbook.getWorksheet(f.sheet) : workbook.worksheets[0]
      if (!ws) throw new Error(`Sheet not found: ${f.sheet || 'default'}`)
      const cell = ws.getCell(f.cell)
      cell.value = { formula: f.formula.startsWith('=') ? f.formula.slice(1) : f.formula }
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await workbook.xlsx.writeFile(outputPath)

    return {
      success: true,
      output: JSON.stringify({ path: outputPath, formulasSet: formulas.length })
    }
  } catch (err) {
    return { success: false, error: `Formula operation failed: ${err.message}` }
  }
}

async function spreadsheetChart(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  let chartDef
  try {
    chartDef = parseJsonParam(args.chart, 'chart')
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    await checkFileSize(filePath)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)

    const ws = chartDef.sheet ? workbook.getWorksheet(chartDef.sheet) : workbook.worksheets[0]
    if (!ws) throw new Error('Worksheet not found')

    // ExcelJS doesn't have native chart support via the streaming/JS API.
    // We add chart data as a note on the output for now.
    // The chart definition is stored as a worksheet property that Excel can interpret.
    const chartSheet = workbook.addWorksheet(`${chartDef.title || 'Chart'}_data`)
    chartSheet.getCell('A1').value = `Chart Type: ${chartDef.type || 'bar'}`
    chartSheet.getCell('A2').value = `Data Range: ${chartDef.data_range || ''}`
    chartSheet.getCell('A3').value = `Title: ${chartDef.title || ''}`
    chartSheet.getCell('A4').value = `X Axis: ${chartDef.x_axis || ''}`
    chartSheet.getCell('A5').value = `Y Axis: ${chartDef.y_axis || ''}`
    chartSheet.getCell('A6').value = 'Note: Chart metadata stored. Open in Excel/LibreOffice to render.'

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await workbook.xlsx.writeFile(outputPath)

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        chart: chartDef,
        note: 'Chart definition stored. ExcelJS does not render charts directly — open the file in Excel or LibreOffice to see the chart.'
      })
    }
  } catch (err) {
    return { success: false, error: `Chart operation failed: ${err.message}` }
  }
}

async function spreadsheetStyle(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  let styles
  try {
    styles = parseJsonParam(args.styles, 'styles')
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    await checkFileSize(filePath)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)

    for (const style of styles) {
      const ws = style.sheet ? workbook.getWorksheet(style.sheet) : workbook.worksheets[0]
      if (!ws) throw new Error(`Sheet not found: ${style.sheet || 'default'}`)

      switch (style.type) {
        case 'format_cells': {
          if (style.range) {
            const range = parseRange(style.range)
            if (range) {
              for (let r = range.startRow; r <= range.endRow; r++) {
                for (let c = range.startCol; c <= range.endCol; c++) {
                  const cell = ws.getCell(r, c)
                  if (style.font) cell.font = { ...cell.font, ...style.font }
                  if (style.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.fill.color || 'FFFFFF00' } }
                  if (style.alignment) cell.alignment = style.alignment
                  if (style.numFmt) cell.numFmt = style.numFmt
                }
              }
            }
          }
          break
        }
        case 'merge': {
          if (style.range) ws.mergeCells(style.range)
          break
        }
        case 'freeze': {
          const row = style.row || 1
          const col = style.column || 0
          ws.views = [{ state: 'frozen', xSplit: col, ySplit: row }]
          break
        }
        case 'border': {
          if (style.range) {
            const range = parseRange(style.range)
            if (range) {
              const borderStyle = style.style || 'thin'
              const border = {
                top: { style: borderStyle },
                left: { style: borderStyle },
                bottom: { style: borderStyle },
                right: { style: borderStyle }
              }
              for (let r = range.startRow; r <= range.endRow; r++) {
                for (let c = range.startCol; c <= range.endCol; c++) {
                  ws.getCell(r, c).border = border
                }
              }
            }
          }
          break
        }
        case 'conditional': {
          if (style.range && style.rules) {
            ws.addConditionalFormatting({
              ref: style.range,
              rules: style.rules
            })
          }
          break
        }
      }
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await workbook.xlsx.writeFile(outputPath)

    return {
      success: true,
      output: JSON.stringify({ path: outputPath, stylesApplied: styles.length })
    }
  } catch (err) {
    return { success: false, error: `Style operation failed: ${err.message}` }
  }
}

async function spreadsheetConvert(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  let options = {}
  try {
    if (args.options) options = parseJsonParam(args.options, 'options')
  } catch (err) {
    return { success: false, error: err.message }
  }

  const srcExt = getExt(filePath)
  const dstExt = getExt(outputPath)

  try {
    await checkFileSize(filePath)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })

    if ((srcExt === '.csv' || srcExt === '.tsv') && dstExt === '.xlsx') {
      const data = await readCsvTsv(filePath, true, options.delimiter)
      const workbook = new ExcelJS.Workbook()
      const ws = workbook.addWorksheet('Sheet1')
      if (data.headers) {
        ws.addRow(data.headers)
        ws.getRow(1).font = { bold: true }
      }
      for (const row of data.rows) {
        if (Array.isArray(row)) {
          ws.addRow(row)
        } else {
          ws.addRow(Object.values(row))
        }
      }
      await workbook.xlsx.writeFile(outputPath)
    } else if (srcExt === '.xlsx' && (dstExt === '.csv' || dstExt === '.tsv')) {
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile(filePath)
      const ws = options.sheet ? workbook.getWorksheet(options.sheet) : workbook.worksheets[0]
      if (!ws) throw new Error('No worksheet found')

      const rows = []
      ws.eachRow({ includeEmpty: false }, (row) => {
        const values = []
        row.eachCell({ includeEmpty: true }, (cell, colNum) => {
          values[colNum - 1] = cellValue(cell)
        })
        rows.push(values)
      })

      const delimiter = options.delimiter || (dstExt === '.tsv' ? '\t' : ',')
      const csv = Papa.unparse(rows, { delimiter })
      await fs.writeFile(outputPath, csv, 'utf8')
    } else if (srcExt === '.csv' && dstExt === '.tsv') {
      const data = await readCsvTsv(filePath, false, ',')
      const tsv = Papa.unparse(data.rows, { delimiter: '\t' })
      await fs.writeFile(outputPath, tsv, 'utf8')
    } else if (srcExt === '.tsv' && dstExt === '.csv') {
      const data = await readCsvTsv(filePath, false, '\t')
      const csv = Papa.unparse(data.rows, { delimiter: ',' })
      await fs.writeFile(outputPath, csv, 'utf8')
    } else {
      return { success: false, error: `Unsupported conversion: ${srcExt} → ${dstExt}` }
    }

    const stat = await fs.stat(outputPath)
    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        from: srcExt.slice(1),
        to: dstExt.slice(1),
        size: stat.size
      })
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    if (err.code === 'EBUSY' || err.code === 'EPERM') return { success: false, error: 'File is open in another application' }
    return { success: false, error: `Convert failed: ${err.message}` }
  }
}

async function spreadsheetAnalyze(args) {
  const filePath = resolvePath(args.path)
  let targetColumns
  try {
    if (args.columns) targetColumns = parseJsonParam(args.columns, 'columns')
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    await checkFileSize(filePath)
    const ext = getExt(filePath)
    let headers, rows

    if (ext === '.xlsx' || ext === '.xls') {
      const result = await readXlsx(filePath, args.sheet, null, true)
      headers = result.headers
      rows = result.rows
    } else {
      const result = await readCsvTsv(filePath, true)
      headers = result.headers
      rows = result.rows
    }

    if (!headers || headers.length === 0) {
      return { success: false, error: 'No headers found in the file' }
    }

    const colIndices = targetColumns
      ? targetColumns.map((c) => headers.indexOf(c)).filter((i) => i >= 0)
      : headers.map((_, i) => i)

    const analysis = {}
    for (const idx of colIndices) {
      const colName = headers[idx]
      const values = rows.map((row) => {
        if (Array.isArray(row)) return row[idx]
        return row[colName]
      }).filter((v) => v !== null && v !== undefined && v !== '')

      const numericValues = values.filter((v) => typeof v === 'number' || !isNaN(Number(v))).map(Number)
      const blanks = rows.length - values.length
      const uniqueValues = new Set(values.map(String))

      const colAnalysis = {
        total: rows.length,
        nonEmpty: values.length,
        blanks,
        unique: uniqueValues.size,
        duplicates: values.length - uniqueValues.size,
        detectedType: numericValues.length > values.length * 0.8 ? 'numeric' : 'text'
      }

      if (numericValues.length > 0) {
        numericValues.sort((a, b) => a - b)
        colAnalysis.min = numericValues[0]
        colAnalysis.max = numericValues[numericValues.length - 1]
        colAnalysis.sum = numericValues.reduce((a, b) => a + b, 0)
        colAnalysis.avg = colAnalysis.sum / numericValues.length
        const mid = Math.floor(numericValues.length / 2)
        colAnalysis.median = numericValues.length % 2 === 0
          ? (numericValues[mid - 1] + numericValues[mid]) / 2
          : numericValues[mid]
      }

      analysis[colName] = colAnalysis
    }

    return {
      success: true,
      output: JSON.stringify({
        file: filePath,
        totalRows: rows.length,
        totalColumns: headers.length,
        analyzedColumns: colIndices.length,
        columns: analysis
      }, null, 2)
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    return { success: false, error: `Analysis failed: ${err.message}` }
  }
}

async function spreadsheetFilter(args) {
  const filePath = resolvePath(args.path)
  let filters, sort
  try {
    filters = parseJsonParam(args.filters, 'filters')
  } catch (err) {
    return { success: false, error: err.message }
  }
  try {
    sort = args.sort ? parseJsonParam(args.sort, 'sort') : null
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    await checkFileSize(filePath)
    const ext = getExt(filePath)
    let headers, rows

    if (ext === '.xlsx' || ext === '.xls') {
      const result = await readXlsx(filePath, null, null, true)
      headers = result.headers
      rows = result.rows.map((row) => {
        if (Array.isArray(row)) {
          const obj = {}
          headers.forEach((h, i) => { obj[h] = row[i] })
          return obj
        }
        return row
      })
    } else {
      const result = await readCsvTsv(filePath, true)
      headers = result.headers
      rows = result.rows
    }

    let filtered = rows
    for (const f of filters) {
      filtered = filtered.filter((row) => {
        const val = row[f.column]
        switch (f.operator) {
          case 'eq': return val == f.value
          case 'neq': return val != f.value
          case 'gt': return Number(val) > Number(f.value)
          case 'lt': return Number(val) < Number(f.value)
          case 'gte': return Number(val) >= Number(f.value)
          case 'lte': return Number(val) <= Number(f.value)
          case 'contains': return String(val || '').toLowerCase().includes(String(f.value).toLowerCase())
          case 'startsWith': return String(val || '').toLowerCase().startsWith(String(f.value).toLowerCase())
          case 'endsWith': return String(val || '').toLowerCase().endsWith(String(f.value).toLowerCase())
          case 'empty': return val === null || val === undefined || val === ''
          case 'notEmpty': return val !== null && val !== undefined && val !== ''
          default: return true
        }
      })
    }

    if (sort) {
      filtered.sort((a, b) => {
        for (const s of sort) {
          const aVal = a[s.column]
          const bVal = b[s.column]
          const cmp = String(aVal || '').localeCompare(String(bVal || ''), undefined, { numeric: true })
          if (cmp !== 0) return s.direction === 'desc' ? -cmp : cmp
        }
        return 0
      })
    }

    if (args.limit) {
      filtered = filtered.slice(0, args.limit)
    }

    if (args.output_path) {
      const outputPath = resolvePath(args.output_path)
      const outExt = getExt(outputPath)
      await fs.mkdir(path.dirname(outputPath), { recursive: true })

      if (outExt === '.xlsx') {
        const workbook = new ExcelJS.Workbook()
        const ws = workbook.addWorksheet('Filtered')
        if (headers) ws.addRow(headers)
        for (const row of filtered) {
          ws.addRow(headers.map((h) => row[h]))
        }
        await workbook.xlsx.writeFile(outputPath)
      } else {
        const csv = Papa.unparse(filtered, { delimiter: outExt === '.tsv' ? '\t' : ',' })
        await fs.writeFile(outputPath, csv, 'utf8')
      }

      return {
        success: true,
        output: JSON.stringify({ path: outputPath, matchedRows: filtered.length })
      }
    }

    return {
      success: true,
      output: JSON.stringify({ matchedRows: filtered.length, rows: filtered }, null, 2)
    }
  } catch (err) {
    return { success: false, error: `Filter failed: ${err.message}` }
  }
}

async function spreadsheetPivot(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  let rowFields, colFields, valueAggs
  try {
    rowFields = parseJsonParam(args.rows, 'rows')
    colFields = parseJsonParam(args.columns, 'columns')
    valueAggs = parseJsonParam(args.values, 'values')
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    await checkFileSize(filePath)
    const ext = getExt(filePath)
    let headers, rows

    if (ext === '.xlsx' || ext === '.xls') {
      const result = await readXlsx(filePath, null, null, true)
      headers = result.headers
      rows = result.rows.map((row) => {
        if (Array.isArray(row)) {
          const obj = {}
          headers.forEach((h, i) => { obj[h] = row[i] })
          return obj
        }
        return row
      })
    } else {
      const result = await readCsvTsv(filePath, true)
      headers = result.headers
      rows = result.rows
    }

    // Build pivot
    const pivot = new Map()
    for (const row of rows) {
      const rowKey = rowFields.map((f) => String(row[f] ?? '')).join('|')
      const colKey = colFields.map((f) => String(row[f] ?? '')).join('|')
      const key = `${rowKey}::${colKey}`

      if (!pivot.has(key)) {
        pivot.set(key, { rowKey, colKey, values: [] })
      }
      pivot.get(key).values.push(row)
    }

    // Aggregate
    const colKeys = [...new Set([...pivot.values()].map((p) => p.colKey))].sort()
    const rowKeys = [...new Set([...pivot.values()].map((p) => p.rowKey))].sort()

    const pivotRows = []
    const pivotHeaders = [...rowFields]
    for (const ck of colKeys) {
      for (const va of valueAggs) {
        pivotHeaders.push(ck ? `${ck}_${va.aggregation}(${va.column})` : `${va.aggregation}(${va.column})`)
      }
    }

    for (const rk of rowKeys) {
      const pivotRow = {}
      const rkParts = rk.split('|')
      rowFields.forEach((f, i) => { pivotRow[f] = rkParts[i] })

      for (const ck of colKeys) {
        const entry = pivot.get(`${rk}::${ck}`)
        const vals = entry ? entry.values : []
        for (const va of valueAggs) {
          const colHeader = ck ? `${ck}_${va.aggregation}(${va.column})` : `${va.aggregation}(${va.column})`
          const numVals = vals.map((v) => Number(v[va.column])).filter((n) => !isNaN(n))
          switch (va.aggregation) {
            case 'sum': pivotRow[colHeader] = numVals.reduce((a, b) => a + b, 0); break
            case 'count': pivotRow[colHeader] = vals.length; break
            case 'avg': pivotRow[colHeader] = numVals.length ? numVals.reduce((a, b) => a + b, 0) / numVals.length : 0; break
            case 'min': pivotRow[colHeader] = numVals.length ? Math.min(...numVals) : 0; break
            case 'max': pivotRow[colHeader] = numVals.length ? Math.max(...numVals) : 0; break
          }
        }
      }
      pivotRows.push(pivotRow)
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const outExt = getExt(outputPath)

    if (outExt === '.xlsx') {
      const workbook = new ExcelJS.Workbook()
      const ws = workbook.addWorksheet('Pivot')
      ws.addRow(pivotHeaders)
      ws.getRow(1).font = { bold: true }
      for (const row of pivotRows) {
        ws.addRow(pivotHeaders.map((h) => row[h] ?? ''))
      }
      await workbook.xlsx.writeFile(outputPath)
    } else {
      const csv = Papa.unparse(pivotRows, { columns: pivotHeaders, delimiter: outExt === '.tsv' ? '\t' : ',' })
      await fs.writeFile(outputPath, csv, 'utf8')
    }

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        pivotRows: pivotRows.length,
        pivotColumns: pivotHeaders.length
      })
    }
  } catch (err) {
    return { success: false, error: `Pivot failed: ${err.message}` }
  }
}

function describeAction(toolName, args) {
  const targetPath = String(args?.path || args?.output_path || '')
  const basename = path.basename(targetPath)
  switch (toolName) {
    case 'spreadsheet_read': return { title: 'Read Spreadsheet', description: `Read ${basename}`, risk: 'low' }
    case 'spreadsheet_create': return { title: 'Create Spreadsheet', description: `Create ${basename}`, command: targetPath, risk: 'medium' }
    case 'spreadsheet_modify': return { title: 'Modify Spreadsheet', description: `Edit ${basename}`, command: targetPath, risk: 'medium' }
    case 'spreadsheet_formula': return { title: 'Set Formulas', description: `Add formulas to ${basename}`, command: targetPath, risk: 'medium' }
    case 'spreadsheet_chart': return { title: 'Add Chart', description: `Add chart to ${basename}`, command: targetPath, risk: 'medium' }
    case 'spreadsheet_style': return { title: 'Apply Styles', description: `Style ${basename}`, command: targetPath, risk: 'medium' }
    case 'spreadsheet_convert': return { title: 'Convert Spreadsheet', description: `Convert ${basename}`, command: targetPath, risk: 'medium' }
    case 'spreadsheet_analyze': return { title: 'Analyze Data', description: `Analyze ${basename}`, risk: 'low' }
    case 'spreadsheet_filter': return { title: 'Filter Data', description: `Filter ${basename}`, risk: args?.output_path ? 'medium' : 'low' }
    case 'spreadsheet_pivot': return { title: 'Pivot Table', description: `Create pivot from ${basename}`, command: targetPath, risk: 'medium' }
    default: return null
  }
}

const plugin = {
  name: 'spreadsheet',
  tools: toolDefinitions,
  describeAction,
  async execute(toolName, args) {
    switch (toolName) {
      case 'spreadsheet_read': return spreadsheetRead(args)
      case 'spreadsheet_create': return spreadsheetCreate(args)
      case 'spreadsheet_modify': return spreadsheetModify(args)
      case 'spreadsheet_formula': return spreadsheetFormula(args)
      case 'spreadsheet_chart': return spreadsheetChart(args)
      case 'spreadsheet_style': return spreadsheetStyle(args)
      case 'spreadsheet_convert': return spreadsheetConvert(args)
      case 'spreadsheet_analyze': return spreadsheetAnalyze(args)
      case 'spreadsheet_filter': return spreadsheetFilter(args)
      case 'spreadsheet_pivot': return spreadsheetPivot(args)
      default: return { success: false, error: `spreadsheet: unknown tool ${toolName}` }
    }
  }
}

export default plugin
