---
name: document
description: Read, create, modify, convert, and merge documents (docx, html, markdown, plain text)
triggers:
  - document
  - word
  - docx
  - report
  - letter
  - memo
  - template
  - write document
  - create report
  - fill template
  - convert document
  - markdown to word
  - word to pdf
  - table of contents
  - merge documents
  - compare documents
  - extract text
  - doc
  - rtf
  - html
  - txt
  - plain text
  - rich text
  - formatting
  - heading
  - paragraph
  - header
  - footer
  - page number
  - margin
  - font
  - style
  - image
  - figure
  - contract
  - proposal
  - invoice
  - resume
  - cv
  - cover letter
  - manuscript
  - essay
  - thesis
  - paper
  - article
  - newsletter
  - brochure
  - flyer
  - write a letter
  - write a report
  - write a memo
  - draft a document
  - type up
  - proofread
  - spell check
  - grammar
  - outline
  - summary
  - abstract
  - bibliography
  - citation
  - footnote
  - endnote
  - appendix
  - glossary
  - index
  - watermark
  - track changes
  - revision
  - version history
  - export document
  - print document
  - page layout
  - landscape
  - portrait
  - a4
  - letter size
  - docx to pdf
  - sop
  - handbook
  - policy
  - agreement
  - nda
  - terms
tools:
  - name: document_read
    description: Read any document file and extract content as text, HTML, or Markdown. Supports docx, html, md, txt, rtf.
    parameters:
      path:
        type: string
        description: Absolute path to the document file
      format:
        type: string
        description: Output format for the extracted content
        enum:
          - text
          - html
          - markdown
        required: false
  - name: document_create
    description: Create a professional .docx document with headings, paragraphs, tables, images, lists, headers, footers, and page options.
    parameters:
      output_path:
        type: string
        description: Absolute path for the output .docx file
      content:
        type: string
        description: 'JSON array of content blocks. Types: heading, paragraph, table, image, list, page_break, table_of_contents, header, footer, code_block'
      options:
        type: string
        description: 'Optional JSON object: {page_size: "A4"|"Letter"|"Legal", orientation: "portrait"|"landscape", margins: {top,bottom,left,right}, default_font, default_size, line_spacing, page_numbers: {position, format}, watermark_text}'
        required: false
  - name: document_modify
    description: Edit an existing .docx file — find-and-replace (with regex), insert or append content, change formatting.
    parameters:
      path:
        type: string
        description: Absolute path to the source .docx file
      output_path:
        type: string
        description: Absolute path for the modified output file
      operations:
        type: string
        description: 'JSON array of operations. Types: find_replace {find, replace, regex?}, insert {position, content}, append {content}, format {target, style}'
  - name: document_template
    description: 'Fill a .docx template with data using {{placeholder}} syntax. Supports repeating sections for arrays.'
    parameters:
      template_path:
        type: string
        description: Absolute path to the .docx template file
      output_path:
        type: string
        description: Absolute path for the filled output file
      data:
        type: string
        description: 'JSON object mapping placeholder names to values. Use arrays for repeating sections.'
      options:
        type: string
        description: 'Optional JSON object: {list_separator?: string}'
        required: false
  - name: document_convert
    description: 'Convert between document formats. Supported: docx->html, docx->markdown, docx->text, html->docx, markdown->docx, html->markdown, markdown->html, docx->pdf (requires pdf capability).'
    parameters:
      path:
        type: string
        description: Absolute path to the source document
      output_path:
        type: string
        description: Absolute path for the converted output file (extension determines target format)
  - name: document_merge
    description: Merge multiple documents into a single .docx file with optional page breaks between them.
    parameters:
      paths:
        type: string
        description: 'JSON array of absolute paths to document files to merge'
      output_path:
        type: string
        description: Absolute path for the merged output .docx file
      page_break_between:
        type: string
        description: '"true" to insert page breaks between merged documents (default true)'
        required: false
  - name: document_toc
    description: Generate or update a table of contents for a .docx document based on heading styles.
    parameters:
      path:
        type: string
        description: Absolute path to the source .docx file
      output_path:
        type: string
        description: Absolute path for the output file with TOC
      depth:
        type: number
        description: Maximum heading depth to include (1-6, default 3)
        required: false
      title:
        type: string
        description: Title for the table of contents section (default "Table of Contents")
        required: false
  - name: document_metadata
    description: Read or set document metadata (author, title, subject, keywords, dates).
    parameters:
      path:
        type: string
        description: Absolute path to the .docx file
      action:
        type: string
        description: '"read" to get metadata, "set" to update metadata'
        enum:
          - read
          - set
      output_path:
        type: string
        description: Absolute path for the output file (required for set action)
        required: false
      metadata:
        type: string
        description: 'JSON object with metadata fields to set: {author?, title?, subject?, keywords?, description?}'
        required: false
  - name: document_compare
    description: Compare two documents and return a structured diff with additions, deletions, and modifications.
    parameters:
      path_a:
        type: string
        description: Absolute path to the first document
      path_b:
        type: string
        description: Absolute path to the second document
      format:
        type: string
        description: Output format for the diff
        enum:
          - text
          - html
        required: false
  - name: document_extract_images
    description: Extract all images embedded in a .docx file and save them to a directory.
    parameters:
      path:
        type: string
        description: Absolute path to the .docx file
      output_dir:
        type: string
        description: Absolute path to the directory where images will be saved
requires:
  - pdf
  - node
danger_patterns:
  - pattern: '/(System|Windows|Program Files)/'
    level: destructive
    reason: Writing to system directory
  - pattern: '/usr/(bin|lib|local)/'
    level: destructive
    reason: Writing to system directory
confirm_patterns:
  - pattern: 'document_(create|modify|template|convert|merge|toc|metadata)'
    reason: Writing a document file
---

# Document

## Interface

- Tools: `document_read`, `document_create`, `document_modify`, `document_template`, `document_convert`, `document_merge`, `document_toc`, `document_metadata`, `document_compare`, `document_extract_images`
- Supported input formats: .docx, .html, .md, .txt, .rtf
- Primary output format: .docx (create/modify/merge/template)
- All paths must be absolute. Complex parameters are JSON strings.

## Rules

- Use `mammoth` for reading .docx files (extracts to HTML/text).
- Use `docx` npm package for creating new .docx files programmatically.
- For template filling (`document_template`), unzip the .docx, string-replace `{{placeholders}}` in the XML, and rezip. This preserves original formatting.
- For `document_convert` with docx->pdf output, this capability uses the pdf capability (declared in `requires`).
- Support BiDi/RTL text via the docx package's bidirectional paragraph options.
- Use `os.EOL` for line endings in plain text output.
- Handle EBUSY/EPERM errors gracefully (file open in another app).

## Content Block Types for document_create

- `heading`: { type, text, level (1-6), alignment? }
- `paragraph`: { type, text, alignment?, bold?, italic?, font?, size?, spacing?, indent? }
- `table`: { type, headers: string[], rows: string[][], columnWidths?, style? }
- `image`: { type, path, width?, height?, caption? }
- `list`: { type, items: string[], ordered?, nested? }
- `page_break`: { type }
- `table_of_contents`: { type, depth? }
- `header`: { type, text }
- `footer`: { type, text }
- `code_block`: { type, text, language? }
