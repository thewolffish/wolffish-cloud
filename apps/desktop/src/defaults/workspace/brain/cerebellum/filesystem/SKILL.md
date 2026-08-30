---
name: filesystem
description: Read, write, and edit files on the local system
triggers:
  - file
  - files
  - read
  - write
  - edit
  - create
  - save
  - open
  - patch
  - modify
  - content
  - folder
  - directory
  - rename
  - move
  - copy
  - delete
  - remove
  - path
  - text
  - overwrite
  - append
  - list files
  - show file
  - update file
  - change file
  - what's in
  - replace
  - find and replace
  - look at
  - check file
  - config
  - configuration
  - log
  - document
  - txt
  - json
  - yaml
  - yml
  - xml
  - env
  - dotfile
  - gitignore
  - readme
  - makefile
  - toml
  - ini
  - csv
  - properties
  - source code
  - snippet
  - template
  - backup
  - archive
  - workspace
  - project
  - codebase
  - cat
  - head
  - tail
  - wc
  - line count
  - show contents
  - print file
  - what does this file say
  - read the file
  - write to file
  - save to file
  - create a file
  - new file
  - update config
  - edit config
tools:
  - name: file_read
    description: Read a text file. With startLine/endLine it streams exactly that range — any line depth in a file of any size is reachable. Without a range, large files return only a head preview plus size facts; page through them with explicit ranges, and search them with shell (rg -n) for authoritative match counts.
    parameters:
      path:
        type: string
        description: Absolute path or path starting with ~
      startLine:
        type: number
        description: 1-based first line to include (optional)
      endLine:
        type: number
        description: 1-based last line to include (optional)
  - name: file_write
    description: Create or overwrite a text file. Use mode=append to append instead.
    parameters:
      path:
        type: string
        description: Absolute path or path starting with ~
      content:
        type: string
        description: Text to write
      mode:
        type: string
        description: 'overwrite (default) or append'
        enum:
          - overwrite
          - append
  - name: image_view
    description: View an image file — returns the actual pixels in the tool result. Attached images are never auto-loaded, so this is how you SEE one. You choose the view, and the choice is a real cost/clarity trade — max_dimension sets the long edge (default 1024, which reads scenes, layout and large type; raise to 1600-2048 only when you must resolve small text), region crops in the ORIGINAL pixel grid before any resize, and format png keeps screenshots, UI, charts and text crisp while jpeg suits photographs. Prefer a tight region at a modest max_dimension over a large max_dimension on the whole frame — a crop is sharper AND cheaper, because cost tracks the pixels you send, not the size of the file. Requires a vision-capable model (on text-only models the pixels are stripped — use shell tools like exiftool/sips for metadata instead).
    parameters:
      path:
        type: string
        description: Absolute path or path starting with ~ to the image file
      max_dimension:
        type: integer
        required: false
        description: Long edge of the returned view in pixels (default 1024). Never upscales past the source, so a value larger than the image simply returns it at native size.
      region:
        type: object
        required: false
        description: Crop to inspect, in ORIGINAL image pixels, applied before the resize. Omit to view the whole frame. Out-of-bounds rectangles are clamped and the result says so.
        properties:
          x:
            type: integer
            description: Left edge in original pixels
          y:
            type: integer
            description: Top edge in original pixels
          width:
            type: integer
            description: Crop width in original pixels
          height:
            type: integer
            description: Crop height in original pixels
      format:
        type: string
        required: false
        description: jpeg (default, best for photographs) or png (lossless, best for text and UI)
        enum:
          - jpeg
          - png
      quality:
        type: integer
        required: false
        description: JPEG quality 1-100 (default 75). Ignored for png.
  - name: file_patch
    description: Find a literal string in a file and replace every occurrence.
    parameters:
      path:
        type: string
        description: Absolute path or path starting with ~
      find:
        type: string
        description: Literal text to search for
      replace:
        type: string
        description: Replacement text
requires:
  - node
danger_patterns:
  - pattern: '\.\./'
    level: destructive
    reason: Path traversal attempt
confirm_patterns:
  - pattern: '/etc/'
    reason: Modifying system configuration
  - pattern: '/usr/'
    reason: Modifying system files
  - pattern: '/private/'
    reason: Modifying protected system area
---

# Filesystem

## Interface

- Tools: `file_read`, `file_write`, `file_patch`, `image_view`
- Paths may use `~` for the user's home directory.
- Writes always create parent directories as needed.

## Rules

- **Verify before reading.** Before calling `file_read`, confirm the file
  exists — use a directory listing, `file_read` on the parent dir, or prior
  context that proves the path is real. Skip the check only when you have
  high certainty the file exists (e.g. you just created it, it appeared in
  a recent directory listing, or the user pasted its path). Never guess
  a path and attempt the read blind.
- Read before you write. Use `file_read` to see what's there before editing.
- Prefer `file_patch` for surgical edits — it preserves the rest of the file
  exactly as the user wrote it.
- For `file_patch`, the `find` string must match exactly (whitespace included).
- Never write to system paths (`/etc/`, `/usr/`, `/private/`) without
  asking — the safety gate will prompt the user, but be transparent about
  what you're doing first.
- When showing file contents back to the user, format them as a code block.
