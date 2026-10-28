import { describe, expect, it } from 'vitest'
import { importComments, parseCommentExport, type ParsedComment } from '../../src/commentImport.js'
import { InMemoryCommentStore } from '../../src/comments.js'
import { formatComments } from '../../src/commentFormat.js'
import type { ReviewComment } from '../../src/types.js'

function exportOf(...blocks: string[]): string {
  return ['<code-review-comments>', '<file path="greet.ts">', ...blocks, '</file>', '</code-review-comments>'].join('\n')
}

function commentBlock(line: string, prefix: '+' | '-', code: string, body: string, status?: 'resolved'): string {
  const statusAttr = status ? ` status="${status}"` : ''
  const codeLines = code.split('\n').map((l) => `${prefix} ${l}`).join('\n')
  return [`<comment line="${line}"${statusAttr}>`, `<code>${codeLines}</code>`, body, '</comment>'].join('\n')
}

function makeStoredComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'existing-1',
    filePath: 'greet.ts',
    side: 'additions',
    lineNumber: 2,
    lineContent: "  const message = `Hello, ${name}!`",
    body: 'First comment',
    status: 'open',
    createdAt: Date.now(),
    replies: [],
    ...overrides,
  }
}

describe('parseCommentExport', () => {
  it('reads a single-file, two-comment export', () => {
    const text = exportOf(
      commentBlock('2', '+', "  const message = `Hello, ${name}!`", 'First comment'),
      commentBlock('3', '+', '  return message', 'Second comment'),
    )

    const result = parseCommentExport(text)

    expect(result.unreadable).toBe(0)
    expect(result.comments).toHaveLength(2)
    expect(result.comments[0]).toEqual({
      filePath: 'greet.ts',
      side: 'additions',
      lineNumber: 2,
      startLineNumber: undefined,
      lineContent: "  const message = `Hello, ${name}!`",
      body: 'First comment',
      status: 'open',
    })
    expect(result.comments[1]).toEqual({
      filePath: 'greet.ts',
      side: 'additions',
      lineNumber: 3,
      startLineNumber: undefined,
      lineContent: '  return message',
      body: 'Second comment',
      status: 'open',
    })
  })

  it('round-trips a multi-line comment, keeping its start and end line', () => {
    const text = exportOf(commentBlock('2-3', '+', '  const message = `Hello, ${name}!`\n  return message', 'Multi-line comment'))

    const result = parseCommentExport(text)

    expect(result.unreadable).toBe(0)
    expect(result.comments[0].startLineNumber).toBe(2)
    expect(result.comments[0].lineNumber).toBe(3)
    expect(result.comments[0].lineContent).toBe('  const message = `Hello, ${name}!`\n  return message')
  })

  it('round-trips lineContent that ends in a trailing newline', () => {
    const text = exportOf(commentBlock('2', '+', 'first line\n', 'body'))

    const result = parseCommentExport(text)

    expect(result.unreadable).toBe(0)
    expect(result.comments[0].lineContent).toBe('first line\n')
  })

  it('marks a comment resolved only when the export says so', () => {
    const text = exportOf(commentBlock('2', '+', 'line', 'body', 'resolved'))

    const result = parseCommentExport(text)

    expect(result.comments[0].status).toBe('resolved')
  })

  it('returns unreadable:0 and no comments when the text has no <code-review-comments> block', () => {
    const result = parseCommentExport('First comment\nSecond comment')

    expect(result).toEqual({ comments: [], unreadable: 0 })
  })
})

describe('importComments', () => {
  it('skips a duplicate by path, side, range, and trimmed body', async () => {
    const store = new InMemoryCommentStore()
    await store.add(makeStoredComment())
    const text = exportOf(commentBlock('2', '+', "  const message = `Hello, ${name}!`", 'First comment  '))

    const result = await importComments(store, text)

    expect(result.imported).toBe(0)
    expect(result.duplicates).toBe(1)
    expect(result.unreadable).toBe(0)
    expect(await store.getAll()).toHaveLength(1)
  })

  it('imports a comment edited after export as new, not a duplicate', async () => {
    const store = new InMemoryCommentStore()
    await store.add(makeStoredComment())
    const text = exportOf(commentBlock('2', '+', "  const message = `Hello, ${name}!`", 'First comment, edited'))

    const result = await importComments(store, text)

    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(0)
    expect(await store.getAll()).toHaveLength(2)
  })

  it('assigns a new id and createdAt, and defaults status to open', async () => {
    const store = new InMemoryCommentStore()
    const text = exportOf(commentBlock('2', '+', 'line', 'a new comment'))

    const result = await importComments(store, text)

    expect(result.imported).toBe(1)
    const [created] = result.comments
    expect(created.id).toBeTruthy()
    expect(typeof created.createdAt).toBe('number')
    expect(created.status).toBe('open')
    expect(created.replies).toEqual([])
  })

  it('returns unreadable:0/empty and changes nothing when the text has no comments block', async () => {
    const store = new InMemoryCommentStore()

    const result = await importComments(store, 'not an export')

    expect(result).toEqual({ imported: 0, duplicates: 0, unreadable: 0, comments: [] })
    expect(await store.getAll()).toHaveLength(0)
  })

  it('round-trips a resolved comment through formatAllComments and preserves its status', async () => {
    const store = new InMemoryCommentStore()
    const resolved = await store.add({
      id: 'test-resolved',
      filePath: 'greet.ts',
      side: 'additions',
      lineNumber: 2,
      lineContent: '  const message = `Hello, ${name}!`',
      body: 'This is resolved',
      status: 'resolved',
      createdAt: Date.now(),
      replies: [],
    })

    // Export the resolved comment
    const exported = ['<code-review-comments>', '<file path="greet.ts">', commentBlock('2', '+', "  const message = `Hello, ${name}!`", 'This is resolved', 'resolved'), '</file>', '</code-review-comments>'].join('\n')

    // Parse it back
    const parsed = parseCommentExport(exported)

    expect(parsed.unreadable).toBe(0)
    expect(parsed.comments).toHaveLength(1)
    expect(parsed.comments[0].status).toBe('resolved')
  })
})

describe('reply authors in the export', () => {
  const replies = [
    { id: 'r1', body: 'Fixed it.', createdAt: 1 },
    { id: 'r2', body: 'Still wrong.', createdAt: 2, author: 'reviewer' as const },
  ]

  it('writes each reply with its author, defaulting to agent', () => {
    const text = formatComments([
      makeStoredComment({ replies }),
      makeStoredComment({ id: 'c2', scope: 'file', body: 'file note', replies: [replies[1]] }),
      makeStoredComment({ id: 'c3', scope: 'diff', filePath: '', body: 'diff note', replies: [replies[0]] }),
    ])
    expect(text).toContain('<reply author="agent">\nFixed it.\n</reply>')
    expect(text).toContain('<reply author="reviewer">\nStill wrong.\n</reply>')
    expect(text.match(/<reply author="/g)).toHaveLength(4)
  })

  it('leaves replies out of the imported body', async () => {
    const text = formatComments([
      makeStoredComment({ body: 'line note', replies }),
      makeStoredComment({ id: 'c2', scope: 'file', body: 'file note', replies }),
    ])
    const store = new InMemoryCommentStore()
    const result = await importComments(store, text)
    expect(result.imported).toBe(2)
    expect(result.comments.map((c) => c.body).sort()).toEqual(['file note', 'line note'])
  })
})

function oracleStripReplies(body: string): string {
  return body.replace(/(?:\n<reply author="[^"]*">\n[\s\S]*?\n<\/reply>)+$/, '')
}

function oracleParseCommentBlock(filePath: string, lineLabel: string, statusAttr: string | undefined, inner: string): ParsedComment {
  const codeMatch = inner.match(/^<code>([\s\S]*?)<\/code>\n([\s\S]*)$/)
  if (!codeMatch) throw new Error('malformed')
  const [, code, rawBody] = codeMatch
  const body = oracleStripReplies(rawBody)
  const codeLines = code.split('\n')
  const prefixChar = codeLines[0]?.[0]
  if (prefixChar !== '+' && prefixChar !== '-') throw new Error('malformed')
  const side: 'additions' | 'deletions' = prefixChar === '+' ? 'additions' : 'deletions'
  const lineContent = codeLines.map((line) => line.slice(2)).join('\n')
  let lineNumber: number
  let startLineNumber: number | undefined
  const rangeMatch = lineLabel.match(/^(\d+)-(\d+)$/)
  if (rangeMatch) {
    startLineNumber = parseInt(rangeMatch[1], 10)
    lineNumber = parseInt(rangeMatch[2], 10)
  } else if (/^\d+$/.test(lineLabel)) {
    lineNumber = parseInt(lineLabel, 10)
  } else {
    throw new Error('malformed')
  }
  return { filePath, side, lineNumber, startLineNumber, lineContent, body, status: statusAttr === 'resolved' ? 'resolved' : 'open' }
}

function oracleParseCommentExport(text: string): { comments: ParsedComment[]; unreadable: number } {
  if (!text.includes('<code-review-comments>')) {
    return { comments: [], unreadable: 0 }
  }
  const comments: ParsedComment[] = []
  let unreadable = 0
  const scopedRe = /<comment scope="(file|diff)"(?:\s+status="([^"]*)")?>\n([\s\S]*?)\n<\/comment>/g
  const pushScoped = (filePath: string, text: string) => {
    let m: RegExpExecArray | null
    while ((m = scopedRe.exec(text))) {
      comments.push({
        scope: m[1] as 'file' | 'diff',
        filePath,
        side: 'additions',
        lineNumber: 0,
        lineContent: '',
        body: oracleStripReplies(m[3]),
        status: m[2] === 'resolved' ? 'resolved' : 'open',
      })
    }
  }
  pushScoped('', text.replace(/<file path="[^"]*">\n[\s\S]*?\n<\/file>/g, ''))
  const fileRe = /<file path="([^"]*)">\n([\s\S]*?)\n<\/file>/g
  let fileMatch: RegExpExecArray | null
  while ((fileMatch = fileRe.exec(text))) {
    const filePath = fileMatch[1]
    const fileBody = fileMatch[2]
    pushScoped(filePath, fileBody)
    const commentRe = /<comment line="([^"]*)"(?:\s+status="([^"]*)")?>\n([\s\S]*?)\n<\/comment>/g
    let commentMatch: RegExpExecArray | null
    while ((commentMatch = commentRe.exec(fileBody))) {
      const [, lineLabel, statusAttr, inner] = commentMatch
      try {
        comments.push(oracleParseCommentBlock(filePath, lineLabel, statusAttr, inner))
      } catch {
        unreadable++
      }
    }
  }
  return { comments, unreadable }
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const STRUCTURE_TOKENS = [
  '<code-review-comments>\n',
  '<file path="a">\n',
  '<file path="b c">\n',
  '\n</file>',
  '<comment line="3">\n<code>+ x</code>\n',
  '<comment line="2-4" status="resolved">\n<code>- y</code>\n',
  '<comment scope="file">\n',
  '<comment scope="diff" status="resolved">\n',
  '\n</comment>',
  '\n<reply author="agent">\n',
  '\n</reply>',
]

const FRAGMENT_TOKENS = [
  '<file path="',
  '<file path="a"',
  '<comment line="',
  '<comment line="1">',
  '<comment scope="file"',
  '<comment scope="other">\n',
  '<reply author="',
  '<reply author="a">',
  '</file>',
  '</comment>',
  '</reply>',
  ' status="x"',
  '<code>+ q</code>',
  '"',
  '>',
  '\n',
  ' ',
  'x',
  'ab',
]

function generateInput(random: () => number, tokens: string[], maxTokens: number): string {
  const count = 1 + Math.floor(random() * maxTokens)
  let text = random() < 0.85 ? '<code-review-comments>\n' : ''
  for (let i = 0; i < count; i++) {
    text += tokens[Math.floor(random() * tokens.length)]
  }
  return text
}

describe('linear comment import', () => {
  it('matches the regex implementation on generated exports', () => {
    const random = seededRandom(20260101)
    const tokens = [...STRUCTURE_TOKENS, ...FRAGMENT_TOKENS]
    for (let i = 0; i < 4000; i++) {
      const input = generateInput(random, random() < 0.5 ? STRUCTURE_TOKENS : tokens, 40)
      expect(parseCommentExport(input), `case ${i}: ${JSON.stringify(input)}`).toEqual(oracleParseCommentExport(input))
    }
  })

  it('matches the regex implementation on reply-heavy comment bodies', () => {
    const random = seededRandom(7)
    const bodyTokens = [
      '\n<reply author="a">\n',
      '\n<reply author="">\n',
      '\n</reply>',
      '</reply>',
      '<reply author="a">',
      'r',
      'text',
      '\n',
      '"',
      '>',
    ]
    for (let i = 0; i < 4000; i++) {
      const count = Math.floor(random() * 24)
      let body = 'b'
      for (let j = 0; j < count; j++) body += bodyTokens[Math.floor(random() * bodyTokens.length)]
      if (random() < 0.7) body += '\n</reply>'
      const input = exportOf(`<comment line="1">\n<code>+ x</code>\n${body}\n</comment>`)
      expect(parseCommentExport(input), `case ${i}: ${JSON.stringify(body)}`).toEqual(oracleParseCommentExport(input))
    }
  })

  it('parses a megabyte of unclosed file openings quickly', () => {
    const input = '<code-review-comments>\n' + '<file path="a">\n'.repeat(65_000)
    const started = performance.now()
    const result = parseCommentExport(input)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(result).toEqual({ comments: [], unreadable: 0 })
  })

  it('parses a megabyte of unclosed comment openings inside one file block quickly', () => {
    const opening = '<comment line="1">\n'
    const input = '<code-review-comments>\n<file path="a">\n' + opening.repeat(Math.ceil(1_000_000 / opening.length)) + '\n</file>'
    const started = performance.now()
    const result = parseCommentExport(input)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(result).toEqual({ comments: [], unreadable: 0 })
  })

  it('parses a megabyte of unclosed scoped openings quickly', () => {
    const opening = '<comment scope="file">\n'
    const input = '<code-review-comments>\n<file path="a">\n' + opening.repeat(Math.ceil(1_000_000 / opening.length)) + '\n</file>'
    const started = performance.now()
    const result = parseCommentExport(input)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(result).toEqual({ comments: [], unreadable: 0 })
  })

  it('strips a comment body with many reply blocks and trailing text quickly', () => {
    const replies = '\n<reply author="a">\nr\n</reply>'.repeat(40)
    const input = exportOf(`<comment line="1">\n<code>+ x</code>\nbody${replies}\ntrailing\n</comment>`)
    const started = performance.now()
    const result = parseCommentExport(input)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(result.comments[0].body).toBe(`body${replies}\ntrailing`)
  })

  it('strips trailing reply blocks from a comment body', () => {
    const replies = '\n<reply author="a">\nr1\n</reply>\n<reply author="b">\nr2\n</reply>'
    const input = exportOf(`<comment line="1">\n<code>+ x</code>\nbody${replies}\n</comment>`)
    expect(parseCommentExport(input).comments[0].body).toBe('body')
  })
})
