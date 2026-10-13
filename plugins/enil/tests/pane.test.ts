import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// 假的 enil daemon：在 $.process.run 底下回答 bridge 的請求，記下送出的指令與寫的檔。
const NOW = Date.UTC(2026, 9, 13, 4, 0) // 台北 12:00
const CHATS = [
  { mid: 'uALICE', type: 'USER', name: 'Alice', unread: 2, lastTime: NOW - 60000, lastText: '明天見', lastFrom: 'Alice' },
  { mid: 'cHIKE', type: 'GROUP', name: '週末爬山團', unread: 0, lastTime: NOW - 3600000, lastText: '七點捷運站', lastFrom: '小安' },
  { mid: 'uBOB', type: 'USER', name: 'Bob', unread: 0, lastTime: NOW - 86400000 * 3, lastText: '好喔', lastFrom: 'Bob' },
]
const HISTORY: Record<string, unknown[]> = {
  uALICE: [
    { id: 'm1', chat: 'uALICE', from: 'uALICE', fromName: 'Alice', text: '明天要不要去爬山？https://example.com/trail', time: NOW - 120000, contentType: 'NONE', reactions: [{ type: 'NICE' }] },
    { id: 'm2', chat: 'uALICE', from: 'uME', fromName: '我', text: '好啊', time: NOW - 90000, contentType: 'NONE', readCount: 1 },
    { id: 'm3', chat: 'uALICE', from: 'uALICE', fromName: 'Alice', text: '明天見', time: NOW - 60000, contentType: 'NONE' },
  ],
  cHIKE: [{ id: 'g1', chat: 'cHIKE', from: 'uAN', fromName: '小安', text: '七點捷運站', time: NOW - 3600000, contentType: 'NONE' }],
  uBOB: [],
}
const ARCHIVE = [
  { id: 'a1', chat: 'cHIKE', fromName: '小安', text: '七點捷運站見', time: NOW - 3600000 },
  { id: 'a2', chat: 'uBOB', fromName: 'Bob', text: '好喔', time: NOW - 86400000 * 3 },
]
  .map(x => JSON.stringify(x))
  .join('\n')

type Daemon = { calls: Record<string, unknown>[]; writes: Record<string, string> }

type Setup = { login?: string; push?: unknown[]; avatars?: boolean }

const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function daemon(on: On, setup: Setup = {}): Daemon {
  const d: Daemon = { calls: [], writes: {} }
  const chats = setup.avatars ? CHATS.map(c => ({ ...c, avatar: `/s/media/avatar-${c.mid}` })) : CHATS
  on('process.run', async ($, e) => {
    const argv = e.argv
    const mode = argv[0] === 'node' ? argv[3] : ''
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (mode === 'info') return out(JSON.stringify({ stateDir: '/s', home: '/h', sock: true }))
    if (mode === 'read') return out(argv[4] === 'archive.jsonl' ? ARCHIVE : (d.writes[argv[4]!] ?? ''))
    if (mode === 'png') {
      const want = JSON.parse(e.init?.stdin ?? '[]') as [string, number][]
      return out(JSON.stringify(Object.fromEntries(want.map(([p, n]) => [`${p}@${n}`, PNG1]))))
    }
    if (mode === 'write') {
      d.writes[argv[4]!] = e.init?.stdin ?? ''
      return out('ok')
    }
    if (mode !== 'req') return { value: { exitCode: 1, stdout: '', stderr: 'nope', isStdoutTruncated: false, isStderrTruncated: false } }
    const req = JSON.parse(e.init?.stdin ?? '{}') as Record<string, unknown>
    d.calls.push(req)
    const ok = (data: unknown) => out(JSON.stringify({ ok: true, data }))
    switch (req.cmd) {
      case 'state':
        return setup.login && setup.login !== 'ok'
          ? ok({ me: null, login: { status: setup.login, error: '這台的登入已被取消' }, chats: [], vip: [] })
          : ok({ me: { mid: 'uME', displayName: '我' }, login: { status: 'ok' }, chats, vip: [] })
      case 'chats':
        return ok(chats)
      case 'history':
        return ok(HISTORY[req.chat as string] ?? [])
      case 'members':
        return ok([
          { mid: 'uAN', name: '小安' },
          { mid: 'uJE', name: '阿哲' },
        ])
      case 'contacts':
        return ok([{ mid: 'uCAROL', name: 'Carol' }])
      case 'stickerPacks':
        return ok([{ pkg: '1', ver: '1', name: '熊大', stickers: ['11', '12'] }])
      default:
        return ok({})
    }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"ok":true,"data":{"subscribed":true}}\n' }
    for (const ev of setup.push ?? []) yield { stream: 'stdout' as const, text: JSON.stringify(ev) + '\n' }
    return { value: { code: 0, signal: null } }
  })
  return d
}

const PANE = {
  component: 'Pane' as const,
  requestId: 'enil',
  props: {
    title: 'LINE',
    isFocused: true,
    bodyColumns: 120,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 36 },
    view: {},
  },
}

async function boot($: Engine, on: On, setup: Setup & { columns?: number } = {}) {
  mock.env(on, { HOME: '/Users/me', PATH: '/usr/bin:/bin' })
  mock.store(on)
  mock.clock(on, { now: NOW })
  const d = daemon(on, setup)
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'enil' } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/tmp' }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'enil', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as never)
  const columns = setup.columns ?? 120
  const ui = await $.ui.mount({ plugin: 'enil', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: columns } })
  await ui.resize({ columns, rows: 36, in: 'app' })
  await ui.redraw()
  const text = async () => JSON.stringify(await ui.drawn({ in: 'app' }))
  // 畫面送出的事在 hooks 那邊是背景做的：推動畫面的時鐘、重畫，等它做完。
  const until = async (ok: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 50 && !(await ok()); i++) {
      await ui.advance(200)
      await ui.redraw()
    }
    return ok()
  }
  const keys = async (...ks: (string | { key: string; ctrl?: true; shift?: true })[]) => {
    for (const k of ks) await ui.key({ ...(typeof k === 'string' ? { key: k } : k), in: 'app' })
    await ui.advance(200)
    await ui.redraw()
  }
  const type = async (s: string) => {
    for (const ch of s) await ui.key({ key: ch, in: 'app' })
  }
  const called = (pred: (c: Record<string, unknown>) => boolean) => until(() => d.calls.some(pred))
  return { d, ui, text, until, keys, type, called, toasts }
}

test('the pane lists chats, opens one and sends a reply', { options: { images: 'off' }, timeoutMs: 20000 }, async ($, on) => {
  const { d, ui, text, until, keys, type } = await boot($, on)
  // 清單：群組在一對一上面，未讀數、預覽都在。
  expect(await text()).toContain('週末爬山團')
  expect(await text()).toContain('Alice')
  expect(await text()).toContain('▾ 群組')

  // ↓↓ 到 Alice（中間隔著「一對一」的標題），Enter 開啟。
  await keys('down', 'down', 'return')
  await until(async () => (await text()).includes('明天要不要去爬山'))
  expect(d.calls.some(c => c.cmd === 'history' && c.chat === 'uALICE' && c.markRead === true)).toBe(true)
  const opened = await text()
  expect(opened).toContain('明天要不要去爬山？')
  expect(opened).toContain('👍')
  expect(opened).toContain('已讀')

  await type('收到')
  expect(await text()).toContain('收到')
  await keys('return')
  await until(() => d.calls.some(c => c.cmd === 'send'))
  expect(d.calls.find(c => c.cmd === 'send')).toMatchObject({ chat: 'uALICE', text: '收到' })

  // ← 在空的輸入框：回清單。
  await keys('left')
  expect(await text()).toContain('先選一個聊天室')
  await ui.unmount()
})

test('VIP, categories and collapsing are written where the TUI reads them', { options: { images: 'off' }, timeoutMs: 20000 }, async ($, on) => {
  const { d, text, until, keys, type } = await boot($, on)
  // 游標在第一個聊天室（週末爬山團）：Ctrl-P 設成 VIP，排到最上面。
  await keys({ key: 'p', ctrl: true })
  expect(await until(() => (d.writes.vip ?? '').includes('cHIKE'))).toBe(true)
  await until(async () => (await text()).includes('★ VIP'))
  expect(await text()).toContain('★ 週末爬山團')

  // c：Bob 放進新分類「家人」。
  await keys('down', 'down', 'down', 'down')
  await keys('c')
  await type('家人')
  expect(await text()).toContain('＋ 新增「家人」')
  await keys('return')
  expect(await until(() => (d.writes.categories ?? '').includes('家人'))).toBe(true)
  expect(d.writes.categories).toMatch(/^u\w+\t家人\n$/)
  await until(async () => (await text()).includes('▾ 家人'))

  // 空白鍵收合游標所在的分區。
  await keys(' ')
  expect(await until(() => (d.writes.collapsed ?? '').includes('家人'))).toBe(true)
})

test('search, select a message, react, unsend, forward and mention', { options: { images: 'off' }, timeoutMs: 30000 }, async ($, on) => {
  const { d, text, until, keys, type, called } = await boot($, on)
  // / 搜尋，連還沒聊過的好友也找得到。
  await keys('/')
  await type('car')
  await until(async () => (await text()).includes('好友・新對話'))
  expect(await text()).toContain('Carol')
  await keys('backspace', 'backspace', 'backspace')
  await type('ali')
  await until(async () => !(await text()).includes('Carol'))
  await keys('return')
  await until(async () => (await text()).includes('明天要不要去爬山'))

  // Tab 選最新的一則，r 1 回 👍。
  await keys('tab', 'r', '1')
  expect(await called(c => c.cmd === 'react')).toBe(true)
  expect(d.calls.find(c => c.cmd === 'react')).toMatchObject({ messageId: 'm3', type: 'NICE' })

  // 再 Tab 一次是自己的「好啊」：d 按兩次才收回。
  await keys('tab', 'd')
  expect(d.calls.some(c => c.cmd === 'unsend')).toBe(false)
  await keys('d')
  expect(await called(c => c.cmd === 'unsend')).toBe(true)
  expect(d.calls.find(c => c.cmd === 'unsend')).toMatchObject({ messageId: 'm2' })

  // 再往上是 Alice 的連結訊息：f 轉傳到群組。
  await keys('tab', 'f')
  await type('爬山')
  await until(async () => (await text()).includes('轉傳到'))
  await keys('return')
  expect(await called(c => c.cmd === 'send' && c.chat === 'cHIKE')).toBe(true)
  expect(String(d.calls.find(c => c.cmd === 'send' && c.chat === 'cHIKE')!.text)).toContain('example.com/trail')

  // 開群組，打 @ 挑人：送出時帶 mentions（UTF-16 位置）。
  await keys('left', 'left')
  await keys('/')
  await type('爬山')
  await until(async () => (await text()).includes('週末爬山團'))
  await keys('return')
  await until(async () => (await text()).includes('七點捷運站'))
  await keys('@')
  await until(async () => (await text()).includes('阿哲'))
  await keys('return')
  await type('早')
  await keys('return')
  expect(await called(c => c.cmd === 'send' && c.text === '@小安 早')).toBe(true)
  expect(d.calls.find(c => c.text === '@小安 早')!.mentions).toEqual([{ mid: 'uAN', start: 0, end: 3 }])
})

test('message search reads the archive and opens the chat', { options: { images: 'off' }, timeoutMs: 20000 }, async ($, on) => {
  const { d, text, until, keys, type } = await boot($, on)
  await keys({ key: 's', ctrl: true })
  await type('捷運')
  await until(async () => (await text()).includes('七點捷運站見'))
  expect(await text()).toContain('存檔共 2 則')
  await keys('return')
  expect(await until(() => d.calls.some(c => c.cmd === 'history' && c.chat === 'cHIKE' && c.markRead === true))).toBe(true)
})

test('sticker picker lists owned packs and sends one', { options: { images: 'off' }, timeoutMs: 20000 }, async ($, on) => {
  const { d, until, keys, text } = await boot($, on)
  await keys('return') // 開第一個聊天室（週末爬山團）
  await until(async () => (await text()).includes('七點捷運站'))
  await keys({ key: 'g', ctrl: true })
  await until(async () => (await text()).includes('熊大'))
  await keys('return')
  expect(await until(() => d.calls.some(c => c.cmd === 'sendSticker'))).toBe(true)
  expect(d.calls.find(c => c.cmd === 'sendSticker')).toMatchObject({ chat: 'cHIKE', sticker: { id: '11', pkg: '1', ver: '1' } })
  expect(await until(() => (d.writes.stickers ?? '').startsWith('11\t1\t1'))).toBe(true)
})

test('a pushed message moves the chat up, counts unread and toasts', { options: { images: 'off', toast: 'all' }, timeoutMs: 20000 }, async ($, on) => {
  const push = [{ event: 'message', data: { id: 'n1', chat: 'uBOB', from: 'uBOB', fromName: 'Bob', text: '在嗎？', time: NOW, contentType: 'NONE' } }]
  const { text, until, toasts } = await boot($, on, { push })
  expect(await until(() => toasts.length > 0)).toBe(true)
  expect(toasts[0]).toBe('Bob：在嗎？')
  await until(async () => (await text()).includes('在嗎？'))
  expect(await text()).toContain('在嗎？')
})

test('avatars are drawn as images over the slots the pane reserved', { options: { images: 'on' }, timeoutMs: 20000 }, async ($, on) => {
  const { ui, until } = await boot($, on, { avatars: true })
  const images = async () => JSON.stringify(await ui.drawn()).split('"type":"Image"').length - 1
  expect(await until(async () => (await images()) >= 3)).toBe(true)
})

test('signed out: the login screen asks the daemon for a QR on Enter', { options: { images: 'off' }, timeoutMs: 20000 }, async ($, on) => {
  const { d, text, until, keys } = await boot($, on, { login: 'idle' })
  await until(async () => (await text()).includes('登入 LINE'))
  expect(await text()).toContain('這台的登入已被取消')
  await keys('return')
  expect(await until(() => d.calls.some(c => c.cmd === 'login'))).toBe(true)
})

test('a narrow pane shows one column at a time', { options: { images: 'off' }, timeoutMs: 20000 }, async ($, on) => {
  const { ui, text, until, keys } = await boot($, on, { columns: 46 })
  expect(await text()).toContain('週末爬山團')
  expect(await text()).not.toContain('選一個聊天室')
  await keys('return')
  await until(async () => (await text()).includes('七點捷運站'))
  expect(await text()).not.toContain('▾ 群組')
  await keys('left')
  expect(await text()).toContain('▾ 群組')
  // 點標題的 ‹ 也回清單。
  await keys('return')
  await until(async () => (await text()).includes('七點捷運站'))
  expect(await text()).toContain(' ‹ ')
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'app' })
  await ui.redraw()
  expect(await text()).toContain('▾ 群組')
})

test('help and theme overlays open and close', { options: { images: 'off' }, timeoutMs: 20000 }, async ($, on) => {
  const { text, keys } = await boot($, on)
  await keys('?')
  expect(await text()).toContain('Claude Code 的規矩')
  await keys('q')
  expect(await text()).not.toContain('Claude Code 的規矩')
  await keys({ key: 'y', ctrl: true })
  expect(await text()).toContain('跟著 Claude Code')
  await keys('q')
  expect(await text()).not.toContain('跟著 Claude Code')
})
