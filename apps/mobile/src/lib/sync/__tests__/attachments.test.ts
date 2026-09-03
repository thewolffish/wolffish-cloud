/**
 * The send path for a message carrying files.
 *
 * What matters here is not that bytes move — files.ts does that and the
 * simulator run proves it end to end — but the ORDER and the bookkeeping
 * around them, which is where a mobile upload can quietly diverge from a
 * desktop one:
 *
 *  - a message with no conversation yet mints ONE id for the whole batch, so
 *    a five-photo message lands in one folder the desktop will create;
 *  - the path the upload was filed under is what the message references,
 *    with the content hash the desktop fetches the bytes by;
 *  - a file that fails has to cost only itself.
 */

import type { StagedFile } from '@/lib/files/fileCache'
import type { CloudUpload } from '@/lib/sync/files'

const mockUpload = jest.fn<Promise<CloudUpload>, [string, string, string | null]>()
const mockChoose = jest.fn<Promise<string>, [string, string]>()
jest.mock('@/lib/sync/files', () => ({
  uploadFileToCloud: (...args: Parameters<typeof mockUpload>) => mockUpload(...args),
  chooseUploadPath: (...args: Parameters<typeof mockChoose>) => mockChoose(...args)
}))

const mockImport = jest.fn<Promise<string | null>, [string, string, string?]>()
const mockStage = jest.fn<Promise<StagedFile | null>, [string, string, string]>()
const mockDiscard = jest.fn<void, [string]>()
jest.mock('@/lib/files/fileCache', () => ({
  importLocalFile: (...args: Parameters<typeof mockImport>) => mockImport(...args),
  stageOutgoingFile: (...args: Parameters<typeof mockStage>) => mockStage(...args),
  discardStagedFile: (...args: Parameters<typeof mockDiscard>) => mockDiscard(...args)
}))

import type { PickedFile } from '@/lib/files/pickAttachments'
import {
  fileLocally,
  stageForSend,
  stagedAttachment,
  uploadForSend,
  type StagedAttachment
} from '@/lib/sync/attachments'

function picked(name: string, extra: Partial<PickedFile> = {}): PickedFile {
  return {
    id: `pick_${name}`,
    uri: `file:///cache/${name}`,
    name,
    mimeType: 'application/octet-stream',
    sizeBytes: 1234,
    ...extra
  }
}

function staged(name: string, extra: Partial<PickedFile> = {}): StagedAttachment {
  const file = picked(name, extra)
  return {
    picked: file,
    staged: {
      relPath: `uploads/.staging/${file.id}/${name}`,
      uri: `file:///workspace/uploads/.staging/${file.id}/${name}`,
      sizeBytes: file.sizeBytes
    }
  }
}

/** What the org answers once the bytes landed under the chosen path. */
function uploaded(filePath: string): CloudUpload {
  return {
    filePath,
    sha256: 'a'.repeat(64),
    sizeBytes: 999,
    mimeType: 'image/png',
    deduped: false
  }
}

beforeEach(() => {
  mockUpload.mockReset()
  mockChoose.mockReset().mockImplementation(async (dir, name) => `${dir}/${name}`)
  mockImport.mockReset().mockResolvedValue('file:///workspace/landed')
  mockStage.mockReset()
  mockDiscard.mockReset()
})

describe('stageForSend', () => {
  it('keeps the files that landed and drops the ones that did not', async () => {
    mockStage
      .mockResolvedValueOnce({
        relPath: 'uploads/.staging/a/a.png',
        uri: 'file:///a',
        sizeBytes: 10
      })
      .mockResolvedValueOnce(null)
    const out = await stageForSend([picked('a.png'), picked('b.png')])
    expect(out.map((entry) => entry.picked.name)).toEqual(['a.png'])
  })
})

describe('stagedAttachment', () => {
  it('derives the desktop attachment buckets from the name', () => {
    expect(stagedAttachment(staged('photo.png')).type).toBe('image')
    expect(stagedAttachment(staged('clip.mp4')).type).toBe('video')
    expect(stagedAttachment(staged('memo.m4a')).type).toBe('audio')
    expect(stagedAttachment(staged('scan.pdf')).type).toBe('pdf')
    // Everything the desktop stores as `other`: documents, sheets, archives.
    expect(stagedAttachment(staged('sheet.csv')).type).toBe('other')
    expect(stagedAttachment(staged('bundle.zip')).type).toBe('other')
  })

  it('renders from the staging path and carries the phone measurements', () => {
    const attachment = stagedAttachment(staged('photo.png', { width: 400, height: 300 }))
    expect(attachment.filePath).toBe('uploads/.staging/pick_photo.png/photo.png')
    expect(attachment).toMatchObject({ width: 400, height: 300, originalName: 'photo.png' })
  })
})

describe('uploadForSend', () => {
  it('mints one conversation for the whole batch when there is none yet', async () => {
    mockUpload.mockImplementation(async (_uri, filePath) => uploaded(filePath))

    const result = await uploadForSend([staged('a.png'), staged('b.png')], null)

    expect(result.conversationId).toMatch(/^\d{4}-\d{2}-\d{2}_/)
    const dir = `uploads/conv-${result.conversationId}`
    // Every file went into the same folder — the one the desktop will create
    // under this id when the send arrives.
    expect(mockChoose.mock.calls.map(([d]) => d)).toEqual([dir, dir])
    expect(result.attachments.map((a) => a.filePath)).toEqual([`${dir}/a.png`, `${dir}/b.png`])
    expect(result.failed).toEqual([])
  })

  it('files under the existing conversation and carries the content hash', async () => {
    mockUpload.mockImplementation(async (_uri, filePath) => uploaded(filePath))
    const entry = staged('a.png')

    const result = await uploadForSend([entry], 'conv-1')

    expect(result.conversationId).toBe('conv-1')
    expect(result.attachments[0]).toMatchObject({
      filePath: 'uploads/conv-conv-1/a.png',
      sha256: 'a'.repeat(64),
      mimeType: 'image/png',
      sizeBytes: 999
    })
    // The bytes this phone just uploaded become the cache entry for the
    // org's path — opening the conversation later must not re-download it.
    expect(mockImport).toHaveBeenCalledWith(entry.staged.uri, 'uploads/conv-conv-1/a.png', 'conv-1')
    expect(mockDiscard).toHaveBeenCalledWith(entry.staged.relPath)
  })

  it('takes the collision-free path the org check chose', async () => {
    mockChoose.mockResolvedValueOnce('uploads/conv-conv-1/a (1).png')
    mockUpload.mockImplementation(async (_uri, filePath) => uploaded(filePath))

    const result = await uploadForSend([staged('a.png')], 'conv-1')

    expect(mockUpload.mock.calls[0][1]).toBe('uploads/conv-conv-1/a (1).png')
    expect(result.attachments[0].filePath).toBe('uploads/conv-conv-1/a (1).png')
    expect(result.attachments[0].originalName).toBe('a.png')
  })

  it('carries the phone measurements onto the metadata', async () => {
    mockUpload.mockImplementation(async (_uri, filePath) => uploaded(filePath))
    const result = await uploadForSend(
      [staged('clip.mp4', { width: 1920, height: 1080, durationSeconds: 12.5 })],
      'conv-1'
    )
    expect(result.attachments[0]).toMatchObject({
      filePath: 'uploads/conv-conv-1/clip.mp4',
      width: 1920,
      height: 1080,
      durationSeconds: 12.5
    })
  })

  it('lets a broken transfer cost only its own file', async () => {
    mockUpload
      .mockRejectedValueOnce(new Error('upload failed (502)'))
      .mockImplementationOnce(async (_uri, filePath) => uploaded(filePath))

    const result = await uploadForSend([staged('a.png'), staged('b.png')], 'conv-1')

    expect(result.failed).toEqual(['a.png'])
    expect(result.attachments.map((a) => a.originalName)).toEqual(['b.png'])
    // The file that never went does not leave its bytes staged forever.
    expect(mockDiscard).toHaveBeenCalledWith('uploads/.staging/pick_a.png/a.png')
  })
})

describe('fileLocally', () => {
  it('files under the conversation uploads folder, like the desktop would', async () => {
    const entry = staged('photo.png')
    const attachments = await fileLocally([entry], 'conv-7')

    expect(mockImport).toHaveBeenCalledWith(
      entry.staged.uri,
      'uploads/conv-conv-7/photo.png',
      'conv-7'
    )
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      type: 'image',
      filePath: 'uploads/conv-conv-7/photo.png',
      originalName: 'photo.png'
    })
  })

  it('drops a file whose bytes never landed', async () => {
    mockImport.mockResolvedValueOnce(null)
    expect(await fileLocally([staged('photo.png')], 'conv-7')).toEqual([])
  })
})
