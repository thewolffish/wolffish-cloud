---
name: spreadsheet
description: Read, create, modify, analyze, and convert spreadsheet files (xlsx, csv, tsv)
triggers:
  - spreadsheet
  - excel
  - xlsx
  - csv
  - tsv
  - table
  - data
  - workbook
  - cells
  - formula
  - chart
  - pivot
  - analyze data
  - import csv
  - export csv
  - columns
  - rows
  - filter data
  - xls
  - worksheet
  - cell
  - range
  - sum
  - average
  - count
  - sort
  - vlookup
  - calculate
  - computation
  - statistics
  - graph
  - plot
  - bar chart
  - line chart
  - pie chart
  - data analysis
  - report
  - tabular
  - matrix
  - grid
  - merge cells
  - split cells
  - conditional formatting
  - budget
  - financial
  - accounting
  - invoice
  - inventory
  - metrics
  - dashboard
  - revenue
  - expense
  - profit
  - loss
  - sales
  - forecast
  - projection
  - trend
  - growth
  - percentage
  - ratio
  - margin
  - kpi
  - roi
  - total
  - subtotal
  - grand total
  - lookup
  - hlookup
  - index match
  - countif
  - sumif
  - min
  - max
  - median
  - variance
  - std deviation
  - histogram
  - scatter plot
  - heatmap
  - sparkline
  - data validation
  - dropdown list
  - freeze panes
  - hide column
  - hide row
  - number format
  - currency
  - date format
  - open spreadsheet
  - read spreadsheet
  - edit spreadsheet
  - create spreadsheet
  - parse csv
  - load csv
  - export excel
tools:
  - name: spreadsheet_read
    description: Read any spreadsheet file (xlsx, csv, tsv) and return structured JSON data. Auto-detects format from extension.
    parameters:
      path:
        type: string
        description: Absolute path to the spreadsheet file
      sheet:
        type: string
        description: Sheet name or 1-based index number (for xlsx). Defaults to first sheet.
        required: false
      range:
        type: string
        description: 'Excel-style range like "A1:D50". Omit to read all data.'
        required: false
      headers:
        type: string
        description: '"true" to treat first row as headers (default true for csv/tsv), "false" to return raw rows'
        required: false
  - name: spreadsheet_create
    description: Create a new spreadsheet file from scratch with multiple sheets, columns, rows, and styles.
    parameters:
      output_path:
        type: string
        description: 'Absolute path for the output file. Extension determines format: .xlsx, .csv, .tsv'
      sheets:
        type: string
        description: 'JSON array of sheet definitions. Each: {name, columns: [{header, width?, type?, format?}], rows: [[values...]], styles?: {}}'
  - name: spreadsheet_modify
    description: Edit an existing spreadsheet — add/remove/rename sheets, insert/delete rows/columns, update cells, apply formatting.
    parameters:
      path:
        type: string
        description: Absolute path to the source spreadsheet
      output_path:
        type: string
        description: Absolute path for the modified output file
      operations:
        type: string
        description: 'JSON array of operations. Types: add_sheet, remove_sheet, rename_sheet, insert_rows, delete_rows, insert_columns, delete_columns, set_cell, set_range'
  - name: spreadsheet_formula
    description: Add or set formulas in spreadsheet cells.
    parameters:
      path:
        type: string
        description: Absolute path to the source spreadsheet
      output_path:
        type: string
        description: Absolute path for the output file
      formulas:
        type: string
        description: 'JSON array of formula operations: [{cell: "A1", sheet?: "Sheet1", formula: "=SUM(B1:B10)"}]'
  - name: spreadsheet_chart
    description: Add a chart to a spreadsheet (bar, line, pie, scatter, area).
    parameters:
      path:
        type: string
        description: Absolute path to the source spreadsheet
      output_path:
        type: string
        description: Absolute path for the output file
      chart:
        type: string
        description: 'JSON chart definition: {type: "bar"|"line"|"pie"|"scatter"|"area", data_range: "A1:D10", title?, x_axis?, y_axis?, sheet?}'
  - name: spreadsheet_style
    description: Apply formatting — conditional formatting, borders, colors, fonts, merge cells, freeze panes.
    parameters:
      path:
        type: string
        description: Absolute path to the source spreadsheet
      output_path:
        type: string
        description: Absolute path for the output file
      styles:
        type: string
        description: 'JSON array of style operations: [{type: "format_cells"|"merge"|"freeze"|"border"|"conditional", range, sheet?, ...options}]'
  - name: spreadsheet_convert
    description: 'Convert between spreadsheet formats: xlsx to csv, csv to xlsx, tsv to xlsx, etc.'
    parameters:
      path:
        type: string
        description: Absolute path to the source file
      output_path:
        type: string
        description: Absolute path for the output file (extension determines target format)
      options:
        type: string
        description: 'Optional JSON object: {delimiter?, encoding?, sheet? (which sheet to export for xlsx->csv)}'
        required: false
  - name: spreadsheet_analyze
    description: Quick data analysis — summary statistics per column (min, max, avg, median, count, sum), detect types, find duplicates, identify blanks.
    parameters:
      path:
        type: string
        description: Absolute path to the spreadsheet file
      sheet:
        type: string
        description: Sheet name or index (for xlsx)
        required: false
      columns:
        type: string
        description: 'Optional JSON array of column names/letters to analyze. Omit for all columns.'
        required: false
  - name: spreadsheet_filter
    description: Filter and sort rows by criteria. Output to a new file or return JSON.
    parameters:
      path:
        type: string
        description: Absolute path to the spreadsheet file
      output_path:
        type: string
        description: Optional output file path. If omitted, returns filtered data as JSON.
        required: false
      filters:
        type: string
        description: 'JSON array of filter operations: [{column, operator: "eq"|"neq"|"gt"|"lt"|"gte"|"lte"|"contains"|"startsWith"|"endsWith"|"empty"|"notEmpty", value?}]'
      sort:
        type: string
        description: 'Optional JSON array of sort operations: [{column, direction: "asc"|"desc"}]'
        required: false
      limit:
        type: number
        description: Maximum number of rows to return
        required: false
  - name: spreadsheet_pivot
    description: Create a pivot table from spreadsheet data.
    parameters:
      path:
        type: string
        description: Absolute path to the source spreadsheet
      output_path:
        type: string
        description: Absolute path for the output file with the pivot table
      rows:
        type: string
        description: 'JSON array of column names to use as row groupings'
      columns:
        type: string
        description: 'JSON array of column names to use as column groupings'
      values:
        type: string
        description: 'JSON array of value aggregations: [{column, aggregation: "sum"|"count"|"avg"|"min"|"max"}]'
requires:
  - node
danger_patterns:
  - pattern: '/(System|Windows|Program Files)/'
    level: destructive
    reason: Writing to system directory
  - pattern: '/usr/(bin|lib|local)/'
    level: destructive
    reason: Writing to system directory
confirm_patterns:
  - pattern: 'spreadsheet_(create|modify|formula|chart|style|convert|filter|pivot)'
    reason: Writing a spreadsheet file
---

# Spreadsheet

## Interface

- Tools: `spreadsheet_read`, `spreadsheet_create`, `spreadsheet_modify`, `spreadsheet_formula`, `spreadsheet_chart`, `spreadsheet_style`, `spreadsheet_convert`, `spreadsheet_analyze`, `spreadsheet_filter`, `spreadsheet_pivot`
- Supported formats: .xlsx, .csv, .tsv
- All complex parameters are passed as JSON strings.
- All paths must be absolute.

## Rules

- Auto-detect file format from the extension.
- For CSV/TSV, handle BOM detection, quoted fields, escaped quotes, multiline values.
- Default encoding is UTF-8. Detect and handle UTF-16 and Windows-1252.
- For files > 10MB, use streaming where available.
- Hard limit: reject files > 100MB with a clear error.
- Normalize dates to ISO 8601 in output.
- Handle Excel serial date numbers correctly.
- Return structured JSON results.
- Handle EBUSY/EPERM errors gracefully (file open in another app).

## Column Reference

- Columns can be referenced by letter (A, B, C...) or by header name when headers=true.
- Ranges use Excel notation: "A1:D50", "B:B" (whole column), "3:5" (whole rows).
