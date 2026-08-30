import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  ImageRun, PageBreak, AlignmentType, WidthType, BorderStyle, Header, Footer,
  TableOfContents, NumberFormat, PageNumber, ExternalHyperlink
} from 'docx'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import AdmZip from 'adm-zip'


const toolDefinitions = [
  {
    name: 'document_read',
    description: 'Read any document file and extract content as text, HTML, or Markdown.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the document' },
        format: { type: 'string', enum: ['text', 'html', 'markdown'] }
      },
      required: ['path']
    }
  },
  {
    name: 'document_create',
    description: 'Create a professional .docx document with headings, paragraphs, tables, images, lists.',
    parameters: {
      type: 'object',
      properties: {
        output_path: { type: 'string', description: 'Absolute path for the output .docx' },
        content: { type: 'string', description: 'JSON array of content blocks' },
        options: { type: 'string', description: 'Optional JSON document options' }
      },
      required: ['output_path', 'content']
    }
  },
  {
    name: 'document_modify',
    description: 'Edit an existing .docx — find-and-replace, insert, append content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source .docx' },
        output_path: { type: 'string', description: 'Absolute path for output' },
        operations: { type: 'string', description: 'JSON array of operations' }
      },
      required: ['path', 'output_path', 'operations']
    }
  },
  {
    name: 'document_template',
    description: 'Fill a .docx template using {{placeholder}} syntax.',
    parameters: {
      type: 'object',
      properties: {
        template_path: { type: 'string', description: 'Absolute path to .docx template' },
        output_path: { type: 'string', description: 'Absolute path for filled output' },
        data: { type: 'string', description: 'JSON object mapping placeholders to values' },
        options: { type: 'string', description: 'Optional JSON: {list_separator?}' }
      },
      required: ['template_path', 'output_path', 'data']
    }
  },
  {
    name: 'document_convert',
    description: 'Convert between document formats (docx, html, markdown, text, pdf).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source document' },
        output_path: { type: 'string', description: 'Absolute path for output (extension sets format)' }
      },
      required: ['path', 'output_path']
    }
  },
  {
    name: 'document_merge',
    description: 'Merge multiple documents into a single .docx.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'string', description: 'JSON array of document paths' },
        output_path: { type: 'string', description: 'Absolute path for merged output' },
        page_break_between: { type: 'string', description: '"true" or "false"' }
      },
      required: ['paths', 'output_path']
    }
  },
  {
    name: 'document_toc',
    description: 'Generate a table of contents for a .docx document.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source .docx' },
        output_path: { type: 'string', description: 'Absolute path for output' },
        depth: { type: 'number', description: 'Max heading depth (1-6, default 3)' },
        title: { type: 'string', description: 'TOC title' }
      },
      required: ['path', 'output_path']
    }
  },
  {
    name: 'document_metadata',
    description: 'Read or set document metadata (author, title, subject, keywords).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx file' },
        action: { type: 'string', enum: ['read', 'set'] },
        output_path: { type: 'string', description: 'Output path (required for set)' },
        metadata: { type: 'string', description: 'JSON metadata object (required for set)' }
      },
      required: ['path', 'action']
    }
  },
  {
    name: 'document_compare',
    description: 'Compare two documents and return a structured diff.',
    parameters: {
      type: 'object',
      properties: {
        path_a: { type: 'string', description: 'First document path' },
        path_b: { type: 'string', description: 'Second document path' },
        format: { type: 'string', enum: ['text', 'html'] }
      },
      required: ['path_a', 'path_b']
    }
  },
  {
    name: 'document_extract_images',
    description: 'Extract all images from a .docx file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx file' },
        output_dir: { type: 'string', description: 'Directory for extracted images' }
      },
      required: ['path', 'output_dir']
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

const HEADING_LEVELS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6
}

const ALIGNMENTS = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED
}

function htmlToMarkdown(html) {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  return td.turndown(html)
}

function markdownToHtml(md) {
  let html = md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')

  // Wrap loose lines in paragraphs
  const lines = html.split('\n')
  const result = []
  for (const line of lines) {
    if (line.trim() === '') {
      result.push('')
    } else if (!line.startsWith('<')) {
      result.push(`<p>${line}</p>`)
    } else {
      result.push(line)
    }
  }
  return result.join('\n')
}

async function documentRead(args) {
  const filePath = resolvePath(args.path)
  const outputFormat = args.format || 'text'

  try {
    await checkFileSize(filePath)
  } catch (err) {
    return { success: false, error: err.message }
  }

  const ext = getExt(filePath)

  try {
    if (ext === '.docx') {
      const buffer = await fs.readFile(filePath)
      if (outputFormat === 'html') {
        const result = await mammoth.convertToHtml({ buffer })
        return { success: true, output: JSON.stringify({ format: 'html', content: result.value, messages: result.messages }) }
      } else if (outputFormat === 'markdown') {
        const result = await mammoth.convertToHtml({ buffer })
        const md = htmlToMarkdown(result.value)
        return { success: true, output: JSON.stringify({ format: 'markdown', content: md }) }
      } else {
        const result = await mammoth.extractRawText({ buffer })
        return { success: true, output: JSON.stringify({ format: 'text', content: result.value }) }
      }
    } else if (ext === '.html' || ext === '.htm') {
      const content = await fs.readFile(filePath, 'utf8')
      if (outputFormat === 'html') {
        return { success: true, output: JSON.stringify({ format: 'html', content }) }
      } else if (outputFormat === 'markdown') {
        return { success: true, output: JSON.stringify({ format: 'markdown', content: htmlToMarkdown(content) }) }
      } else {
        const text = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        return { success: true, output: JSON.stringify({ format: 'text', content: text }) }
      }
    } else if (ext === '.md' || ext === '.markdown') {
      const content = await fs.readFile(filePath, 'utf8')
      if (outputFormat === 'markdown') {
        return { success: true, output: JSON.stringify({ format: 'markdown', content }) }
      } else if (outputFormat === 'html') {
        return { success: true, output: JSON.stringify({ format: 'html', content: markdownToHtml(content) }) }
      } else {
        const text = content.replace(/[#*_`\[\]()]/g, '').trim()
        return { success: true, output: JSON.stringify({ format: 'text', content: text }) }
      }
    } else if (ext === '.txt' || ext === '.rtf') {
      const content = await fs.readFile(filePath, 'utf8')
      return { success: true, output: JSON.stringify({ format: 'text', content }) }
    } else {
      return { success: false, error: `Unsupported format: ${ext}. Supported: .docx, .html, .md, .txt, .rtf` }
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    if (err.code === 'EBUSY' || err.code === 'EPERM') return { success: false, error: 'File is open in another application' }
    return { success: false, error: `Read failed: ${err.message}` }
  }
}

async function documentCreate(args) {
  const outputPath = resolvePath(args.output_path)
  let content, options
  try {
    content = parseJsonParam(args.content, 'content')
  } catch (err) {
    return { success: false, error: err.message }
  }
  try {
    options = args.options ? parseJsonParam(args.options, 'options') : {}
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    const sections = []
    const children = []
    let headerContent = null
    let footerContent = null

    for (const block of content) {
      switch (block.type) {
        case 'heading': {
          children.push(new Paragraph({
            text: block.text || '',
            heading: HEADING_LEVELS[block.level || 1] || HeadingLevel.HEADING_1,
            alignment: ALIGNMENTS[block.alignment] || undefined
          }))
          break
        }
        case 'paragraph': {
          const runs = []
          runs.push(new TextRun({
            text: block.text || '',
            bold: block.bold || false,
            italics: block.italic || false,
            font: block.font || options.default_font,
            size: (block.size || options.default_size || 12) * 2
          }))
          children.push(new Paragraph({
            children: runs,
            alignment: ALIGNMENTS[block.alignment] || undefined,
            spacing: block.spacing ? { after: block.spacing * 20 } : undefined,
            indent: block.indent ? { left: block.indent * 720 } : undefined,
            bidirectional: block.rtl || false
          }))
          break
        }
        case 'table': {
          const headers = block.headers || []
          const rows = block.rows || []
          const tableRows = []

          if (headers.length > 0) {
            tableRows.push(new TableRow({
              children: headers.map((h) => new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: String(h), bold: true })] })],
                width: block.columnWidths ? { size: block.columnWidths[headers.indexOf(h)] || 2000, type: WidthType.DXA } : undefined
              }))
            }))
          }

          for (const row of rows) {
            tableRows.push(new TableRow({
              children: row.map((cell, i) => new TableCell({
                children: [new Paragraph({ text: String(cell ?? '') })],
                width: block.columnWidths ? { size: block.columnWidths[i] || 2000, type: WidthType.DXA } : undefined
              }))
            }))
          }

          if (tableRows.length > 0) {
            children.push(new Table({ rows: tableRows }))
          }
          break
        }
        case 'image': {
          if (block.path) {
            try {
              const imgPath = resolvePath(block.path)
              const imgBuffer = await fs.readFile(imgPath)
              const width = block.width || 400
              const height = block.height || 300
              children.push(new Paragraph({
                children: [new ImageRun({
                  data: imgBuffer,
                  transformation: { width, height },
                  type: getExt(imgPath) === '.png' ? 'png' : 'jpg'
                })]
              }))
              if (block.caption) {
                children.push(new Paragraph({
                  children: [new TextRun({ text: block.caption, italics: true, size: 20 })],
                  alignment: AlignmentType.CENTER
                }))
              }
            } catch (err) {
              children.push(new Paragraph({ text: `[Image error: ${err.message}]` }))
            }
          }
          break
        }
        case 'list': {
          const items = block.items || []
          const ordered = block.ordered || false
          for (let i = 0; i < items.length; i++) {
            children.push(new Paragraph({
              text: ordered ? `${i + 1}. ${items[i]}` : `• ${items[i]}`,
              indent: { left: 720 }
            }))
          }
          break
        }
        case 'page_break': {
          children.push(new Paragraph({ children: [new PageBreak()] }))
          break
        }
        case 'table_of_contents': {
          children.push(new TableOfContents('Table of Contents', {
            hyperlink: true,
            headingStyleRange: `1-${block.depth || 3}`
          }))
          break
        }
        case 'header': {
          headerContent = block.text || ''
          break
        }
        case 'footer': {
          footerContent = block.text || ''
          break
        }
        case 'code_block': {
          const lines = (block.text || '').split('\n')
          for (const line of lines) {
            children.push(new Paragraph({
              children: [new TextRun({
                text: line,
                font: 'Courier New',
                size: 20
              })],
              shading: { fill: 'F0F0F0' }
            }))
          }
          break
        }
      }
    }

    const sectionProps = { children }

    if (options.page_size) {
      const sizes = { A4: { width: 11906, height: 16838 }, Letter: { width: 12240, height: 15840 }, Legal: { width: 12240, height: 20160 } }
      const size = sizes[options.page_size] || sizes.A4
      if (options.orientation === 'landscape') {
        sectionProps.page = { size: { width: size.height, height: size.width, orientation: 'landscape' } }
      } else {
        sectionProps.page = { size }
      }
    }

    if (options.margins) {
      if (!sectionProps.page) sectionProps.page = {}
      sectionProps.page.margin = {
        top: (options.margins.top || 72) * 20,
        bottom: (options.margins.bottom || 72) * 20,
        left: (options.margins.left || 72) * 20,
        right: (options.margins.right || 72) * 20
      }
    }

    if (headerContent) {
      sectionProps.headers = {
        default: new Header({
          children: [new Paragraph({ text: headerContent })]
        })
      }
    }

    if (footerContent || options.page_numbers) {
      const footerChildren = []
      if (footerContent) {
        footerChildren.push(new TextRun({ text: footerContent }))
      }
      if (options.page_numbers) {
        if (footerContent) footerChildren.push(new TextRun({ text: ' — ' }))
        footerChildren.push(new TextRun({ children: [PageNumber.CURRENT] }))
        footerChildren.push(new TextRun({ text: ` of ` }))
        footerChildren.push(new TextRun({ children: [PageNumber.TOTAL_PAGES] }))
      }
      sectionProps.footers = {
        default: new Footer({
          children: [new Paragraph({ children: footerChildren, alignment: AlignmentType.CENTER })]
        })
      }
    }

    const docOptions = { sections: [sectionProps] }
    if (options.watermark_text) {
      // docx package doesn't natively support watermarks via this API
      // but we note it in output
    }

    const doc = new Document(docOptions)
    const buffer = await Packer.toBuffer(doc)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, buffer)

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        size: buffer.length,
        blocks: content.length
      })
    }
  } catch (err) {
    return { success: false, error: `Failed to create document: ${err.message}` }
  }
}

async function documentModify(args) {
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
    const zip = new AdmZip(filePath)
    let documentXml = zip.readAsText('word/document.xml')

    for (const op of operations) {
      switch (op.type) {
        case 'find_replace': {
          const find = op.find
          const replace = op.replace || ''
          if (op.regex) {
            const re = new RegExp(find, 'g')
            documentXml = documentXml.replace(re, replace)
          } else {
            // In docx XML, text runs may be split across tags.
            // Simple case: replace in the raw XML text nodes
            const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            documentXml = documentXml.replace(new RegExp(escaped, 'g'), replace)
          }
          break
        }
        case 'append': {
          // Insert before closing </w:body>
          const text = op.content || op.text || ''
          const paragraph = `<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`
          documentXml = documentXml.replace('</w:body>', `${paragraph}</w:body>`)
          break
        }
        case 'insert': {
          const text = op.content || op.text || ''
          const paragraph = `<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`
          // Insert at beginning of body
          documentXml = documentXml.replace('<w:body>', `<w:body>${paragraph}`)
          break
        }
      }
    }

    zip.updateFile('word/document.xml', Buffer.from(documentXml, 'utf8'))
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    zip.writeZip(outputPath)

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        operationsApplied: operations.length
      })
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    if (err.code === 'EBUSY' || err.code === 'EPERM') return { success: false, error: 'File is open in another application' }
    return { success: false, error: `Modify failed: ${err.message}` }
  }
}

async function documentTemplate(args) {
  const templatePath = resolvePath(args.template_path)
  const outputPath = resolvePath(args.output_path)
  let data, options
  try {
    data = parseJsonParam(args.data, 'data')
  } catch (err) {
    return { success: false, error: err.message }
  }
  try {
    options = args.options ? parseJsonParam(args.options, 'options') : {}
  } catch {
    options = {}
  }

  try {
    await checkFileSize(templatePath)
    const zip = new AdmZip(templatePath)
    let documentXml = zip.readAsText('word/document.xml')

    const listSeparator = options.list_separator || ', '

    for (const [key, value] of Object.entries(data)) {
      const placeholder = `{{${key}}}`
      let replacement
      if (Array.isArray(value)) {
        replacement = value.join(listSeparator)
      } else {
        replacement = String(value)
      }
      // Replace in XML — the placeholder might be split across runs
      // First try simple replacement
      const escapedPlaceholder = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      documentXml = documentXml.replace(new RegExp(escapedPlaceholder, 'g'), escapeXml(replacement))

      // Handle case where {{ and }} are in separate XML runs
      const splitPattern = new RegExp(
        `\\{\\{</w:t></w:r><w:r[^>]*><w:t[^>]*>${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</w:t></w:r><w:r[^>]*><w:t[^>]*>\\}\\}`,
        'g'
      )
      documentXml = documentXml.replace(splitPattern, escapeXml(replacement))
    }

    zip.updateFile('word/document.xml', Buffer.from(documentXml, 'utf8'))
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    zip.writeZip(outputPath)

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        placeholdersFilled: Object.keys(data).length
      })
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `Template not found: ${templatePath}` }
    return { success: false, error: `Template fill failed: ${err.message}` }
  }
}

async function documentConvert(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  const srcExt = getExt(filePath)
  const dstExt = getExt(outputPath)

  try {
    await checkFileSize(filePath)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })

    if (srcExt === '.docx' && dstExt === '.html') {
      const buffer = await fs.readFile(filePath)
      const result = await mammoth.convertToHtml({ buffer })
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Document</title></head><body>${result.value}</body></html>`
      await fs.writeFile(outputPath, html, 'utf8')
    } else if (srcExt === '.docx' && (dstExt === '.md' || dstExt === '.markdown')) {
      const buffer = await fs.readFile(filePath)
      const result = await mammoth.convertToHtml({ buffer })
      const md = htmlToMarkdown(result.value)
      await fs.writeFile(outputPath, md, 'utf8')
    } else if (srcExt === '.docx' && dstExt === '.txt') {
      const buffer = await fs.readFile(filePath)
      const result = await mammoth.extractRawText({ buffer })
      await fs.writeFile(outputPath, result.value, 'utf8')
    } else if ((srcExt === '.html' || srcExt === '.htm') && dstExt === '.docx') {
      const html = await fs.readFile(filePath, 'utf8')
      const textContent = html.replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      const paragraphs = textContent.split('\n').filter((l) => l.trim()).map(
        (line) => new Paragraph({ text: line.trim() })
      )
      const doc = new Document({ sections: [{ children: paragraphs }] })
      const buffer = await Packer.toBuffer(doc)
      await fs.writeFile(outputPath, buffer)
    } else if ((srcExt === '.md' || srcExt === '.markdown') && dstExt === '.docx') {
      const md = await fs.readFile(filePath, 'utf8')
      const lines = md.split('\n')
      const children = []
      for (const line of lines) {
        if (line.startsWith('### ')) {
          children.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 }))
        } else if (line.startsWith('## ')) {
          children.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }))
        } else if (line.startsWith('# ')) {
          children.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }))
        } else if (line.startsWith('- ') || line.startsWith('* ')) {
          children.push(new Paragraph({ text: `• ${line.slice(2)}`, indent: { left: 720 } }))
        } else if (line.trim()) {
          const text = line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1')
          children.push(new Paragraph({ text }))
        }
      }
      const doc = new Document({ sections: [{ children }] })
      const buffer = await Packer.toBuffer(doc)
      await fs.writeFile(outputPath, buffer)
    } else if ((srcExt === '.html' || srcExt === '.htm') && (dstExt === '.md' || dstExt === '.markdown')) {
      const html = await fs.readFile(filePath, 'utf8')
      const md = htmlToMarkdown(html)
      await fs.writeFile(outputPath, md, 'utf8')
    } else if ((srcExt === '.md' || srcExt === '.markdown') && (dstExt === '.html' || dstExt === '.htm')) {
      const md = await fs.readFile(filePath, 'utf8')
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${markdownToHtml(md)}</body></html>`
      await fs.writeFile(outputPath, html, 'utf8')
    } else if (srcExt === '.docx' && dstExt === '.pdf') {
      // docx->pdf: read content, create PDF via the pdf capability
      // Since we can't call another plugin directly, we extract text and create a basic PDF
      return {
        success: false,
        error: 'docx->pdf conversion requires the pdf capability. Use document_read to extract content, then pdf_create to build the PDF.'
      }
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

async function documentMerge(args) {
  let paths
  try {
    paths = parseJsonParam(args.paths, 'paths')
  } catch (err) {
    return { success: false, error: err.message }
  }
  const outputPath = resolvePath(args.output_path)
  const pageBreak = args.page_break_between !== 'false'

  try {
    const allChildren = []

    for (let i = 0; i < paths.length; i++) {
      const filePath = resolvePath(paths[i])
      await checkFileSize(filePath)
      const ext = getExt(filePath)

      let text
      if (ext === '.docx') {
        const buffer = await fs.readFile(filePath)
        const result = await mammoth.extractRawText({ buffer })
        text = result.value
      } else {
        text = await fs.readFile(filePath, 'utf8')
      }

      const lines = text.split('\n')
      for (const line of lines) {
        if (line.trim()) {
          allChildren.push(new Paragraph({ text: line }))
        }
      }

      if (pageBreak && i < paths.length - 1) {
        allChildren.push(new Paragraph({ children: [new PageBreak()] }))
      }
    }

    const doc = new Document({ sections: [{ children: allChildren }] })
    const buffer = await Packer.toBuffer(doc)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, buffer)

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        mergedFiles: paths.length,
        size: buffer.length
      })
    }
  } catch (err) {
    return { success: false, error: `Merge failed: ${err.message}` }
  }
}

async function documentToc(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  const depth = args.depth || 3
  const title = args.title || 'Table of Contents'

  try {
    await checkFileSize(filePath)
    const buffer = await fs.readFile(filePath)
    const htmlResult = await mammoth.convertToHtml({ buffer })
    const html = htmlResult.value

    // Extract headings from HTML
    const headingRegex = /<h([1-6])[^>]*>(.*?)<\/h\1>/gi
    const headings = []
    let match
    while ((match = headingRegex.exec(html)) !== null) {
      const level = parseInt(match[1], 10)
      if (level <= depth) {
        const text = match[2].replace(/<[^>]+>/g, '')
        headings.push({ level, text })
      }
    }

    // Read original text
    const textResult = await mammoth.extractRawText({ buffer })
    const lines = textResult.value.split('\n').filter((l) => l.trim())

    // Build new document with TOC + original content
    const children = []
    children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }))
    children.push(new Paragraph({ text: '' }))

    for (const h of headings) {
      const indent = (h.level - 1) * 360
      children.push(new Paragraph({
        text: `${'  '.repeat(h.level - 1)}${h.text}`,
        indent: { left: indent }
      }))
    }

    children.push(new Paragraph({ children: [new PageBreak()] }))

    for (const line of lines) {
      children.push(new Paragraph({ text: line }))
    }

    const doc = new Document({ sections: [{ children }] })
    const outputBuffer = await Packer.toBuffer(doc)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, outputBuffer)

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        headingsFound: headings.length,
        depth
      })
    }
  } catch (err) {
    return { success: false, error: `TOC generation failed: ${err.message}` }
  }
}

async function documentMetadata(args) {
  const filePath = resolvePath(args.path)

  try {
    await checkFileSize(filePath)
    const zip = new AdmZip(filePath)

    if (args.action === 'read') {
      const coreXml = zip.readAsText('docProps/core.xml') || ''
      const metadata = {}
      const extract = (tag) => {
        const match = coreXml.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's'))
        return match ? match[1].trim() : null
      }
      metadata.title = extract('dc:title')
      metadata.author = extract('dc:creator')
      metadata.subject = extract('dc:subject')
      metadata.description = extract('dc:description')
      metadata.keywords = extract('cp:keywords')
      metadata.created = extract('dcterms:created')
      metadata.modified = extract('dcterms:modified')
      metadata.lastModifiedBy = extract('cp:lastModifiedBy')

      return { success: true, output: JSON.stringify({ metadata }) }
    }

    if (args.action === 'set') {
      if (!args.output_path) return { success: false, error: 'output_path required for set action' }
      if (!args.metadata) return { success: false, error: 'metadata required for set action' }

      let metadata
      try {
        metadata = parseJsonParam(args.metadata, 'metadata')
      } catch (err) {
        return { success: false, error: err.message }
      }

      let coreXml = zip.readAsText('docProps/core.xml') || ''

      const setTag = (xml, tag, value) => {
        const re = new RegExp(`<${tag}[^>]*>.*?</${tag}>`, 's')
        if (re.test(xml)) {
          return xml.replace(re, `<${tag}>${escapeXml(value)}</${tag}>`)
        }
        return xml.replace('</cp:coreProperties>', `<${tag}>${escapeXml(value)}</${tag}></cp:coreProperties>`)
      }

      if (metadata.title) coreXml = setTag(coreXml, 'dc:title', metadata.title)
      if (metadata.author) coreXml = setTag(coreXml, 'dc:creator', metadata.author)
      if (metadata.subject) coreXml = setTag(coreXml, 'dc:subject', metadata.subject)
      if (metadata.description) coreXml = setTag(coreXml, 'dc:description', metadata.description)
      if (metadata.keywords) coreXml = setTag(coreXml, 'cp:keywords', metadata.keywords)

      zip.updateFile('docProps/core.xml', Buffer.from(coreXml, 'utf8'))
      const outputPath = resolvePath(args.output_path)
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      zip.writeZip(outputPath)

      return {
        success: true,
        output: JSON.stringify({ path: outputPath, metadataSet: Object.keys(metadata) })
      }
    }

    return { success: false, error: `Unknown action: ${args.action}` }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    return { success: false, error: `Metadata operation failed: ${err.message}` }
  }
}

async function documentCompare(args) {
  const pathA = resolvePath(args.path_a)
  const pathB = resolvePath(args.path_b)
  const format = args.format || 'text'

  try {
    const getContent = async (filePath) => {
      const ext = getExt(filePath)
      if (ext === '.docx') {
        const buffer = await fs.readFile(filePath)
        const result = await mammoth.extractRawText({ buffer })
        return result.value
      }
      return await fs.readFile(filePath, 'utf8')
    }

    const textA = await getContent(pathA)
    const textB = await getContent(pathB)

    const linesA = textA.split('\n')
    const linesB = textB.split('\n')

    // Simple line-by-line diff
    const additions = []
    const deletions = []
    const modifications = []

    const maxLen = Math.max(linesA.length, linesB.length)
    for (let i = 0; i < maxLen; i++) {
      const a = linesA[i]
      const b = linesB[i]
      if (a === undefined) {
        additions.push({ line: i + 1, content: b })
      } else if (b === undefined) {
        deletions.push({ line: i + 1, content: a })
      } else if (a !== b) {
        modifications.push({ line: i + 1, from: a, to: b })
      }
    }

    const diff = { additions, deletions, modifications, totalChanges: additions.length + deletions.length + modifications.length }

    if (format === 'html') {
      let html = '<div class="diff">'
      for (const d of deletions) html += `<p style="color:red;text-decoration:line-through">- ${escapeXml(d.content)}</p>`
      for (const a of additions) html += `<p style="color:green">+ ${escapeXml(a.content)}</p>`
      for (const m of modifications) html += `<p style="color:orange">~ ${escapeXml(m.from)} → ${escapeXml(m.to)}</p>`
      html += '</div>'
      diff.html = html
    }

    return { success: true, output: JSON.stringify(diff, null, 2) }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found` }
    return { success: false, error: `Compare failed: ${err.message}` }
  }
}

async function documentExtractImages(args) {
  const filePath = resolvePath(args.path)
  const outputDir = resolvePath(args.output_dir)

  try {
    await checkFileSize(filePath)
    const zip = new AdmZip(filePath)
    await fs.mkdir(outputDir, { recursive: true })

    const entries = zip.getEntries()
    const extracted = []

    for (const entry of entries) {
      if (entry.entryName.startsWith('word/media/')) {
        const filename = path.basename(entry.entryName)
        const outPath = path.join(outputDir, filename)
        const data = entry.getData()
        await fs.writeFile(outPath, data)
        extracted.push({ path: outPath, name: filename, size: data.length })
      }
    }

    return {
      success: true,
      output: JSON.stringify({
        outputDir,
        imagesExtracted: extracted.length,
        images: extracted
      })
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    return { success: false, error: `Image extraction failed: ${err.message}` }
  }
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function describeAction(toolName, args) {
  const targetPath = String(args?.path || args?.output_path || args?.template_path || '')
  const basename = path.basename(targetPath)
  switch (toolName) {
    case 'document_read': return { title: 'Read Document', description: `Read ${basename}`, risk: 'low' }
    case 'document_create': return { title: 'Create Document', description: `Create ${basename}`, command: targetPath, risk: 'medium' }
    case 'document_modify': return { title: 'Modify Document', description: `Edit ${basename}`, command: targetPath, risk: 'medium' }
    case 'document_template': return { title: 'Fill Template', description: `Fill template ${basename}`, command: targetPath, risk: 'medium' }
    case 'document_convert': return { title: 'Convert Document', description: `Convert ${basename}`, command: targetPath, risk: 'medium' }
    case 'document_merge': return { title: 'Merge Documents', description: `Merge into ${basename}`, command: targetPath, risk: 'medium' }
    case 'document_toc': return { title: 'Generate TOC', description: `Add TOC to ${basename}`, command: targetPath, risk: 'medium' }
    case 'document_metadata': return { title: args?.action === 'read' ? 'Read Metadata' : 'Set Metadata', description: `${args?.action} metadata for ${basename}`, risk: args?.action === 'read' ? 'low' : 'medium' }
    case 'document_compare': return { title: 'Compare Documents', description: `Compare ${path.basename(String(args?.path_a || ''))} with ${path.basename(String(args?.path_b || ''))}`, risk: 'low' }
    case 'document_extract_images': return { title: 'Extract Images', description: `Extract images from ${basename}`, risk: 'low' }
    default: return null
  }
}

const plugin = {
  name: 'document',
  tools: toolDefinitions,
  describeAction,
  async execute(toolName, args) {
    switch (toolName) {
      case 'document_read': return documentRead(args)
      case 'document_create': return documentCreate(args)
      case 'document_modify': return documentModify(args)
      case 'document_template': return documentTemplate(args)
      case 'document_convert': return documentConvert(args)
      case 'document_merge': return documentMerge(args)
      case 'document_toc': return documentToc(args)
      case 'document_metadata': return documentMetadata(args)
      case 'document_compare': return documentCompare(args)
      case 'document_extract_images': return documentExtractImages(args)
      default: return { success: false, error: `document: unknown tool ${toolName}` }
    }
  }
}

export default plugin
