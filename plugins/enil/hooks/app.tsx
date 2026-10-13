// enil 的畫面：tui/src/main.rs 的移植，跑在 Claude Code 面板裡的一個 Client。
//
// 畫法跟 ratatui 一樣：先畫進一張格子（每格一個字、一個樣式），再一列一列交出去。
// 資料（聊天室、訊息、成員…）是 hooks 模組給的 props；要做的事（開聊天室、送出…）
// 用 post 交回去。圖片（大頭貼、照片、貼圖）由 hooks 模組疊在這裡算好的位置上。

import type { ClientKeyEvent, ClientPointerEvent, ClientSurface, RenderElement } from 'claude-code'

import type { AppProps, Chat, Msg, Op, Palette, Post, Slot, Sticker } from '../types'

// ------------------------------------------------------------------ 字寬

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter() : undefined
const PICTO = /\p{Extended_Pictographic}/u

function graphemes(s: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(s), x => x.segment)
  return Array.from(s)
}

function cpWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0x20d0 && cp <= 0x20ff)
  )
    return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2
  return 1
}

/** 一個字（grapheme）佔幾格。表情符號（含 ❤️ 這種靠 VS16 變成圖的）算兩格。 */
function gw(g: string): number {
  if (g.length > 1 && (PICTO.test(g) || g.includes('️'))) return 2
  const cp = g.codePointAt(0) ?? 0
  return cpWidth(cp)
}

function width(s: string): number {
  let w = 0
  for (const g of graphemes(s)) w += gw(g)
  return w
}

/** 截到顯示寬度 max 以內（寬字元算兩格），放不下就補 … */
function fit(s: string, max: number): string {
  if (max <= 0) return ''
  if (width(s) <= max) return s
  let out = ''
  let used = 0
  for (const g of graphemes(s)) {
    const w = gw(g)
    if (used + w + 1 > max) break
    out += g
    used += w
  }
  return out + '…'
}

// ------------------------------------------------------------------ 格子

type Sty = { fg?: string; bg?: string; b?: boolean; d?: boolean; i?: boolean; u?: boolean; r?: boolean }
type Rect = { x: number; y: number; w: number; h: number }
type Span = [string, Sty?]

class Grid {
  g: string[][]
  s: Sty[][]
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.g = Array.from({ length: h }, () => Array(w).fill(' '))
    this.s = Array.from({ length: h }, () => Array.from({ length: w }, () => ({})))
  }
  /** 從 (x, y) 寫一段字，最多寫到 x + max（不含）。回傳寫到哪一格。 */
  put(x: number, y: number, text: string, sty: Sty = {}, max = this.w - x): number {
    if (y < 0 || y >= this.h) return x
    const end = Math.min(this.w, x + Math.max(0, max))
    for (const ch of graphemes(text)) {
      const cw = gw(ch)
      if (cw === 0) continue
      if (x + cw > end) break
      if (x >= 0) this.cell(x, y, ch, sty)
      if (cw === 2 && x + 1 >= 0 && x + 1 < this.w) this.cell(x + 1, y, '', sty)
      x += cw
    }
    return x
  }
  private cell(x: number, y: number, ch: string, sty: Sty) {
    const row = this.g[y]!
    // 蓋到寬字元的一半：另一半補成空白，不然整列會錯位。
    if (row[x] === '' && x > 0) row[x - 1] = ' '
    if (row[x] !== '' && gw(row[x]!) === 2 && x + 1 < this.w && ch !== '') row[x + 1] = ' '
    row[x] = ch
    const under = this.s[y]![x]!
    this.s[y]![x] = { ...sty, bg: sty.bg ?? under.bg }
  }
  spans(x: number, y: number, parts: Span[], max = this.w - x): number {
    const end = x + max
    for (const [t, sty] of parts) x = this.put(x, y, t, sty, end - x)
    return x
  }
  fill(r: Rect, sty: Sty) {
    for (let y = Math.max(0, r.y); y < Math.min(this.h, r.y + r.h); y++)
      for (let x = Math.max(0, r.x); x < Math.min(this.w, r.x + r.w); x++) {
        if (this.g[y]![x] === '' && x === r.x && x > 0) this.g[y]![x - 1] = ' '
        this.g[y]![x] = ' '
        this.s[y]![x] = { ...sty }
      }
  }
  /** 圓角外框；標題在上框左邊，bottom 在下框右邊，bottomLeft 在下框左邊。 */
  frame(r: Rect, color: Sty, title: Span[] = [], bottom: Span[] = [], bottomLeft: Span[] = []) {
    if (r.w < 2 || r.h < 2) return
    const right = r.x + r.w - 1
    const bot = r.y + r.h - 1
    this.put(r.x, r.y, '╭' + '─'.repeat(r.w - 2) + '╮', color)
    this.put(r.x, bot, '╰' + '─'.repeat(r.w - 2) + '╯', color)
    for (let y = r.y + 1; y < bot; y++) {
      this.put(r.x, y, '│', color)
      this.put(right, y, '│', color)
    }
    if (title.length) this.spans(r.x + 1, r.y, title, r.w - 2)
    if (bottomLeft.length) this.spans(r.x + 1, bot, bottomLeft, r.w - 2)
    if (bottom.length) {
      const w = bottom.reduce((n, [t]) => n + width(t), 0)
      this.spans(Math.max(r.x + 1, right - w), bot, bottom, r.w - 2)
    }
  }
}

const inner = (r: Rect): Rect => ({ x: r.x + 1, y: r.y + 1, w: Math.max(0, r.w - 2), h: Math.max(0, r.h - 2) })
const centered = (area: Rect, w: number, h: number): Rect => {
  const ww = Math.min(w, area.w)
  const hh = Math.min(h, area.h)
  return { x: area.x + Math.floor((area.w - ww) / 2), y: area.y + Math.floor((area.h - hh) / 2), w: ww, h: hh }
}
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const contains = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h

// ------------------------------------------------------------------ 時間（台北，跟 TUI 一樣）

const TZ = 8 * 3600 * 1000
const dayIndex = (ms: number) => Math.floor((ms + TZ) / 86400000)
const clock = (ms: number) => {
  const d = new Date(ms + TZ)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
const dayLabel = (ms: number) => {
  const d = new Date(ms + TZ)
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`
}
const dayLabelLong = (ms: number) => `${dayLabel(ms)} 週${'日一二三四五六'[new Date(ms + TZ).getUTCDay()]}`

// ------------------------------------------------------------------ 樣式

const SENDER = ['cyan', 'magenta', 'yellow', 'blue', 'redBright', 'cyanBright', 'magentaBright', 'blueBright']
function senderColor(name: string): string {
  let h = 0
  for (const b of new TextEncoder().encode(name)) h = (Math.imul(h, 31) + b) >>> 0
  return SENDER[h % SENDER.length]!
}

const REACT: [string, string][] = [
  ['1', 'NICE'],
  ['2', 'LOVE'],
  ['3', 'FUN'],
  ['4', 'AMAZING'],
  ['5', 'SAD'],
  ['6', 'OMG'],
  ['0', 'UNDO'],
]
const glyph = (k: string) => ({ NICE: '👍', LOVE: '❤️', FUN: '😆', AMAZING: '😮', SAD: '😢', OMG: '😱' })[k] ?? '✨'
function reactionSummary(kinds: string[]): string {
  const counts: [string, number][] = []
  for (const k of kinds.filter(k => k !== 'UNDO')) {
    const g = glyph(k)
    const c = counts.find(x => x[0] === g)
    if (c) c[1] += 1
    else counts.push([g, 1])
  }
  counts.sort((a, b) => b[1] - a[1])
  return counts.map(([g, n]) => (n > 1 ? `${g} ${n}` : g)).join('  ')
}

function humanSize(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${Math.ceil(b / 1024)} KB`
  return `${(b / 1048576).toFixed(1)} MB`
}

// ------------------------------------------------------------------ 狀態

type Fwd = { kind: 'text'; text: string } | { kind: 'sticker'; sticker: Sticker } | { kind: 'file'; id: string }

type Overlay =
  | { t: 'search'; q: string; pick: number; forward?: Fwd }
  | { t: 'msgsearch'; q: string; pick: number }
  | { t: 'react' }
  | { t: 'mention'; q: string; pick: number }
  | { t: 'cat'; mid: string; name: string; q: string; pick: number }
  | { t: 'path'; text: string; matches: string[] }
  | { t: 'help'; scroll: number }
  | { t: 'theme'; pick: number; original: string }
  | { t: 'stickers'; pick: number; tab: number }
  | { t: 'viewer'; id: string }

type Hit = { r: Rect; kind: 'chat' | 'header' | 'msg' | 'back'; id: string }

type S = {
  props: AppProps
  sel: string
  onHeader: string | null
  open: string
  openName: string
  input: string
  caret: number
  drafts: Record<string, string>
  peek: boolean
  scroll: number
  cursor: string | null
  sidebar: 'full' | 'names' | 'hidden'
  ov: Overlay | null
  attach: { path: string; name: string; size: number } | null
  mentions: [string, string][]
  unsendArmed: string | null
  status: { text: string; at: number; warn: boolean }
  seq: number
  outbox: Op[]
  lastPost: number
  lastReply: number
  lastEsc: number
  dwell: { mid: string; at: number }
  asked: string
  themePreview: string | null
  helpMax: number
  narrow: boolean
  hits: Hit[]
  listOffset: number
  sig: string
  want: string[]
  slots: Slot[]
  askedStickers: Record<string, true>
}

function initial(props: AppProps): S {
  return {
    props,
    sel: '',
    onHeader: null,
    open: '',
    openName: '',
    input: '',
    caret: 0,
    drafts: {},
    peek: false,
    scroll: 0,
    cursor: null,
    sidebar: 'full',
    ov: null,
    attach: null,
    mentions: [],
    unsendArmed: null,
    status: { text: '', at: 0, warn: false },
    seq: 0,
    outbox: [],
    lastPost: 0,
    lastReply: props.replies.reduce((n, r) => Math.max(n, r.seq), 0),
    lastEsc: props.esc,
    dwell: { mid: '', at: 0 },
    asked: '',
    themePreview: null,
    helpMax: 0,
    narrow: false,
    hits: [],
    listOffset: 0,
    sig: '',
    want: [],
    slots: [],
    askedStickers: {},
  }
}

function op(st: S, name: string, args: Record<string, unknown> = {}) {
  st.seq += 1
  st.outbox.push({ seq: Date.now() * 1000 + (st.seq % 1000), op: name, ...args })
}

function note(st: S, text: string, warn = true) {
  st.status = { text, at: Date.now(), warn }
}

// ------------------------------------------------------------------ 清單、分區

const VIP = '★ VIP'
const GROUPS = '群組'
const DIRECT = '一對一'
const reserved = (n: string) => [VIP, GROUPS, DIRECT, 'VIP'].includes(n.trim())

function catNames(st: S): string[] {
  const out: string[] = []
  for (const [, c] of st.props.prefs.cats) if (!out.includes(c)) out.push(c)
  return out
}

function catOf(st: S, mid: string): string | undefined {
  return st.props.prefs.cats.find(([m]) => m === mid)?.[1]
}

function section(st: S, mid: string): [string, number] {
  if (st.props.prefs.vip.includes(mid)) return [VIP, 0]
  const cat = catOf(st, mid)
  if (cat) return [cat, 1 + catNames(st).indexOf(cat)]
  return mid.startsWith('u') ? [DIRECT, 1e9] : [GROUPS, 1e9 - 1]
}

/** 照分區排（VIP → 自己的分類 → 群組 → 一對一），區內維持最近活動的順序。 */
function sorted(st: S): Chat[] {
  return st.props.chats
    .map((c, i) => ({ c, i, r: section(st, c.mid)[1] }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(x => x.c)
}

type Row = { kind: 'chat'; chat: Chat } | { kind: 'header'; name: string }

function visibleRows(st: S, list: Chat[]): Row[] {
  const out: Row[] = []
  let last: string | null = null
  for (const c of list) {
    const s = section(st, c.mid)[0]
    if (s !== last) {
      out.push({ kind: 'header', name: s })
      last = s
    }
    if (!st.props.prefs.collapsed.includes(s)) out.push({ kind: 'chat', chat: c })
  }
  return out
}

function moveSelection(st: S, delta: number) {
  const rows = visibleRows(st, sorted(st))
  const here = rows.findIndex(r => (r.kind === 'header' ? st.onHeader === r.name : st.onHeader === null && r.chat.mid === st.sel))
  const next = here < 0 ? (delta < 0 ? rows.length - 1 : 0) : here + delta
  const row = rows[next]
  if (!row) return
  if (row.kind === 'chat') {
    st.sel = row.chat.mid
    st.onHeader = null
  } else st.onHeader = row.name
}

function toggleSection(st: S, name: string) {
  const collapsing = !st.props.prefs.collapsed.includes(name)
  op(st, 'collapse', { section: name })
  // 游標所在的聊天室被收起來時，游標停到那一區的標題上 —— 再按一次就展開回來。
  if (collapsing && st.onHeader === null && st.sel && section(st, st.sel)[0] === name) st.onHeader = name
}

function selectedChat(st: S): Chat | undefined {
  return st.props.chats.find(c => c.mid === st.sel)
}

/** 開著聊天室，但右邊正在預覽清單上選中的另一個。輸入框這時不收字。 */
function peeking(st: S): Chat | undefined {
  if (!st.open || !st.peek || st.narrow || st.onHeader !== null) return undefined
  const c = selectedChat(st)
  return c && c.mid !== st.open ? c : undefined
}

function endPeek(st: S) {
  st.peek = false
  if (st.open) st.sel = st.open
}

/** 畫面上的那個聊天室：預覽中的、開著的，或清單選中的。 */
function target(st: S): [string, string] | undefined {
  const p = peeking(st)
  if (p) return [p.mid, p.name]
  if (st.open) return [st.open, st.openName]
  const c = selectedChat(st)
  return c ? [c.mid, c.name] : undefined
}

function stashDraft(st: S) {
  if (st.open) {
    if (st.input.trim()) st.drafts[st.open] = st.input
    else delete st.drafts[st.open]
  }
  st.input = ''
  st.caret = 0
}

function openChat(st: S, mid: string, name: string) {
  stashDraft(st)
  st.onHeader = null
  st.peek = false
  if (st.props.chats.some(c => c.mid === mid)) st.sel = mid
  st.open = mid
  st.openName = name
  st.input = st.drafts[mid] ?? ''
  delete st.drafts[mid]
  st.caret = graphemes(st.input).length
  st.cursor = null
  // 附件是掛給「剛才那個聊天室」的。帶到下一個聊天室，一個 Enter 就送錯人。
  st.attach = null
  st.mentions = []
  st.unsendArmed = null
  st.scroll = 0
  if (st.ov && st.ov.t !== 'help') st.ov = null
  note(st, `載入 ${name}…`, false)
  op(st, 'open', { mid, name })
}

function leaveChat(st: S) {
  stashDraft(st)
  st.open = ''
  st.attach = null
  st.cursor = null
  st.scroll = 0
  st.asked = ''
  op(st, 'leave')
}

function openNextUnread(st: S) {
  const list = sorted(st)
  const n = list.length
  const openAt = list.findIndex(c => c.mid === st.open)
  const selAt = list.findIndex(c => c.mid === st.sel)
  const [start, first] = openAt >= 0 ? [openAt, 1] : [Math.max(0, selAt), st.onHeader !== null ? 1 : 0]
  for (let k = first; k < first + n; k++) {
    const c = list[(start + k) % n]!
    if (c.unread > 0 && c.mid !== st.open) {
      op(st, 'expand', { section: section(st, c.mid)[0] })
      st.sel = c.mid
      st.onHeader = null
      return openChat(st, c.mid, c.name)
    }
  }
  note(st, '沒有未讀了')
}

// ------------------------------------------------------------------ 訊息

function shownMsgs(st: S): { msgs: Msg[]; busy: boolean; mid: string; name: string; preview: boolean } {
  const p = peeking(st)
  const pk = st.props.peek
  if (p) return { msgs: pk.mid === p.mid ? pk.msgs : [], busy: pk.mid !== p.mid || pk.loading, mid: p.mid, name: p.name, preview: true }
  if (st.open) {
    const v = st.props.view
    return v.mid === st.open
      ? { msgs: v.msgs, busy: v.busy, mid: st.open, name: st.openName, preview: false }
      : { msgs: [], busy: true, mid: st.open, name: st.openName, preview: false }
  }
  const c = selectedChat(st)
  if (!c || st.narrow) return { msgs: [], busy: false, mid: '', name: '', preview: true }
  return { msgs: pk.mid === c.mid ? pk.msgs : [], busy: pk.mid !== c.mid || pk.loading, mid: c.mid, name: c.name, preview: true }
}

function openMsgs(st: S): Msg[] {
  return st.open && st.props.view.mid === st.open ? st.props.view.msgs : []
}

function cursorMsg(st: S): Msg | undefined {
  return st.cursor ? openMsgs(st).find(m => m.id === st.cursor) : undefined
}

const openable = (m: Msg) => m.hasMedia || !!m.link

function moveCursor(st: S, older: boolean) {
  const msgs = openMsgs(st)
  const len = msgs.length
  const at = st.cursor ? msgs.findIndex(m => m.id === st.cursor) : -1
  const ok = (i: number) => msgs[i]!.kind !== 'UNSENT'
  let next = -1
  if (older) {
    for (let i = (at < 0 ? len : at) - 1; i >= 0; i--) if (ok(i)) { next = i; break }
  } else if (at >= 0) {
    for (let i = at + 1; i < len; i++) if (ok(i)) { next = i; break }
  }
  st.cursor = next >= 0 ? msgs[next]!.id : null
  // 選到畫面外的就捲過去，放在最底下。
  if (next >= 0 && !st.hits.some(h => h.kind === 'msg' && h.id === msgs[next]!.id)) st.scroll = len - 1 - next
}

function onScrolled(st: S) {
  const v = st.props.view
  const len = openMsgs(st).length
  st.scroll = Math.max(0, Math.min(st.scroll, len - 1))
  // 接近最舊時預先往前抓一頁，不然捲到頂就停住。
  if (st.open && st.scroll + 5 >= len && !v.busy && !v.exhausted && len > 0) op(st, 'older', { mid: st.open })
}

function openMsg(st: S, m: Msg) {
  if (m.sticker) return note(st, '貼圖（s 跟著貼一張一樣的）', false)
  if (m.kind === 'IMAGE' && m.hasMedia) {
    st.ov = { t: 'viewer', id: m.id }
    return op(st, 'view', { id: m.id })
  }
  if (m.hasMedia || m.link) op(st, 'openMsg', { id: m.id })
}

function startForward(st: S) {
  const m = cursorMsg(st)
  if (!m) return
  let item: Fwd
  if (m.sticker) item = { kind: 'sticker', sticker: m.sticker }
  else if (m.hasMedia) item = { kind: 'file', id: m.id }
  else if (m.kind === 'NONE' && m.text) item = { kind: 'text', text: m.text }
  else return note(st, `這種訊息（${m.kind}）還不能轉傳`)
  st.ov = { t: 'search', q: '', pick: 0, forward: item }
  op(st, 'search')
}

function unsendSelected(st: S) {
  const m = cursorMsg(st)
  if (!m) return
  if (!m.mine) return note(st, '只能收回自己的訊息')
  // 收回是送不回來的：第一下只提示，同一則再按一次才送。
  if (st.unsendArmed !== m.id) {
    st.unsendArmed = m.id
    return note(st, '再按一次 d 收回這則（LINE 只能收回 24 小時內的）')
  }
  st.unsendArmed = null
  op(st, 'unsend', { id: m.id })
}

function sendInput(st: S) {
  const text = st.input.trim()
  if (!st.open || (!text && !st.attach)) return
  op(st, 'send', { mid: st.open, text, mentions: st.mentions, attach: st.attach?.path ?? '' })
  st.input = ''
  st.caret = 0
  st.attach = null
  st.mentions = []
  st.scroll = 0
  note(st, '傳送中…', false)
}

function sendSticker(st: S, sticker: Sticker) {
  if (!st.open) return
  op(st, 'sticker', { mid: st.open, sticker })
  st.scroll = 0
}

// ------------------------------------------------------------------ 輸入框

function edit(st: S, kind: string) {
  const chars = graphemes(st.input)
  const len = chars.length
  const at = Math.min(st.caret, len)
  const isSpace = (i: number) => /\s/.test(chars[i] ?? '')
  const wordLeft = (i: number) => {
    while (i > 0 && isSpace(i - 1)) i--
    while (i > 0 && !isSpace(i - 1)) i--
    return i
  }
  const wordRight = (i: number) => {
    while (i < len && isSpace(i)) i++
    while (i < len && !isSpace(i)) i++
    return i
  }
  const cut = (from: number, to: number) => {
    st.input = [...chars.slice(0, from), ...chars.slice(to)].join('')
    st.caret = from
  }
  switch (kind) {
    case 'left': st.caret = Math.max(0, at - 1); break
    case 'right': st.caret = Math.min(len, at + 1); break
    case 'wordLeft': st.caret = wordLeft(at); break
    case 'wordRight': st.caret = wordRight(at); break
    case 'home': st.caret = 0; break
    case 'end': st.caret = len; break
    case 'backspace': if (at > 0) cut(at - 1, at); break
    case 'delete': if (at < len) cut(at, at + 1); break
    case 'deleteWord': cut(wordLeft(at), at); break
    case 'deleteToStart': cut(0, at); break
    case 'deleteToEnd': cut(at, len); break
  }
}

function insert(st: S, text: string) {
  const chars = graphemes(st.input)
  const at = Math.min(st.caret, chars.length)
  st.input = [...chars.slice(0, at), text, ...chars.slice(at)].join('')
  st.caret = at + graphemes(text).length
}

/** 輸入框只有一行：決定要顯示哪一段，回傳（顯示的字, 游標前面那段的寬度）。 */
function inputWindow(text: string, caret: number, room: number): [string, number] {
  const chars = graphemes(text).map(c => (c === '\n' ? '⏎' : c))
  caret = Math.min(caret, chars.length)
  const after = chars.slice(caret).reduce((n, c) => n + gw(c), 0)
  const budget = room - Math.min(after, Math.floor(room / 3))
  let start = caret
  let used = 0
  while (start > 0 && used + gw(chars[start - 1]!) <= budget) {
    start -= 1
    used += gw(chars[start]!)
  }
  let end = caret
  let total = used
  while (end < chars.length && total + gw(chars[end]!) <= room) {
    total += gw(chars[end]!)
    end += 1
  }
  return [chars.slice(start, end).join(''), used]
}

// ------------------------------------------------------------------ Esc

function escapable(st: S): boolean {
  return !!(st.ov || peeking(st) || st.cursor || st.attach || st.open)
}

function escape(st: S) {
  if (st.ov) {
    if (st.ov.t === 'theme') st.themePreview = null
    if (st.ov.t === 'viewer') op(st, 'closeViewer')
    st.ov = null
    return
  }
  if (peeking(st)) return endPeek(st)
  if (st.cursor) {
    st.cursor = null
    return
  }
  if (st.attach) {
    st.attach = null
    return
  }
  if (st.open) leaveChat(st)
}

// ------------------------------------------------------------------ 按鍵

const NAMED = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete', 'pageup', 'pagedown',
  'home', 'end', 'escape', 'space', 'insert', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
])

function key(st: S, ev: ClientKeyEvent) {
  let k = ev.key
  if (k === 'enter') k = 'return'
  if (k === 'space') k = ' '
  const ctrl = !!ev.ctrl
  // 一次來好幾個字：貼上（終端機把貼上的整段當成一個事件）。
  if (!ctrl && !NAMED.has(k) && graphemes(k).length > 1) return paste(st, k)
  if (k !== 'd') st.unsendArmed = null
  if (k === 'escape') return escape(st)

  const props = st.props
  if (props.conn.checked && !props.conn.loggedIn) {
    if (k === 'return') op(st, 'login')
    else if (k === 'q') op(st, 'close')
    return
  }

  const ov = st.ov
  if (ov) return overlayKey(st, ov, k, ctrl, !!ev.shift)

  if (ctrl && k === 'y') {
    const names = props.themes.names
    st.ov = { t: 'theme', pick: Math.max(0, names.indexOf(props.themes.chosen)), original: props.themes.chosen }
    return
  }
  if (ctrl && k === 'b') {
    st.sidebar = st.sidebar === 'full' ? 'names' : st.sidebar === 'names' ? 'hidden' : 'full'
    return
  }
  if (k === 'f1') {
    st.ov = { t: 'help', scroll: 0 }
    return
  }
  if (ctrl && k === 's') {
    st.ov = { t: 'msgsearch', q: '', pick: 0 }
    op(st, 'msgSearch')
    return
  }
  if (ctrl && k === 'g') {
    endPeek(st)
    if (!st.open) return note(st, '先打開一個聊天室，再按 Ctrl-G 選貼圖')
    st.ov = { t: 'stickers', pick: 0, tab: props.prefs.stickers.length === 0 && props.packs.length ? 1 : 0 }
    op(st, 'packs')
    return
  }
  if (ctrl && k === 'n') return openNextUnread(st)
  if (ctrl && k === 'p') {
    const t = target(st)
    if (t) op(st, 'vip', { mid: t[0], name: t[1] })
    return
  }
  // 預覽別的聊天室時：只認移動、進入、回去。打字、貼上、附檔、送出都屬於開著的那個。
  if (peeking(st)) {
    if (k === 'return') {
      const c = selectedChat(st)
      if (c) openChat(st, c.mid, c.name)
    } else if (k === 'left') endPeek(st)
    else if (k === 'up') moveSelection(st, -1)
    else if (k === 'down') moveSelection(st, 1)
    else if (ctrl && k === 't') startCat(st)
    else if (!ctrl && graphemes(k).length === 1) note(st, '預覽中：Enter 進入，← 回到原本的聊天室')
    return
  }
  if (ctrl && st.open) {
    if (k === 'v') return op(st, 'paste')
    if (k === 'f') {
      st.ov = { t: 'path', text: '~/', matches: [] }
      op(st, 'complete', { text: '~/' })
      return
    }
    if (k === 't') return startCat(st)
    const editKey = { a: 'home', e: 'end', w: 'deleteWord', u: 'deleteToStart', k: 'deleteToEnd' }[k]
    if (editKey) return edit(st, editKey)
    if (k === 'left') return edit(st, 'wordLeft')
    if (k === 'right') return edit(st, 'wordRight')
  }
  if (ctrl) return

  switch (k) {
    case 'return':
      // 輸入框有字時 Enter 永遠是送出，不管有沒有選中訊息。
      if (st.onHeader !== null && !st.input && !st.attach) return toggleSection(st, st.onHeader)
      if (st.open && (st.input || st.attach)) return sendInput(st)
      if (st.cursor) {
        const m = cursorMsg(st)
        if (m) openMsg(st, m)
        return
      }
      {
        const c = selectedChat(st)
        if (c) openChat(st, c.mid, c.name)
      }
      return
    case 'tab':
      if (st.open) moveCursor(st, !ev.shift)
      return
    case 'backspace':
      if (!st.open) return
      if (!st.input && st.attach) {
        st.attach = null
        return
      }
      return edit(st, 'backspace')
    case 'left':
      // 輸入框空著、游標在最前面：當成 Esc（Esc 本身會把鍵盤交回 Claude Code）。
      if (st.open && st.caret === 0 && !st.input) return escape(st)
      if (st.open) edit(st, 'left')
      return
    case 'right':
    case 'home':
    case 'end':
    case 'delete':
      if (st.open) edit(st, k)
      return
    case 'up':
      moveSelection(st, -1)
      st.peek = !!st.open
      return
    case 'down':
      moveSelection(st, 1)
      st.peek = !!st.open
      return
    case 'pageup':
      st.scroll += 10
      return onScrolled(st)
    case 'pagedown':
      st.scroll = Math.max(0, st.scroll - 10)
      return
  }
  if (st.cursor && !st.input) {
    if (k === 'r') {
      st.ov = { t: 'react' }
      return
    }
    if (k === 'd') return unsendSelected(st)
    if (k === 'f') return startForward(st)
    if (k === 's') {
      const m = cursorMsg(st)
      if (!m?.sticker) return note(st, '選中的不是貼圖')
      st.cursor = null
      return sendSticker(st, m.sticker)
    }
  }
  // 群組裡打 @：挑人。一對一沒有要提及的對象。
  if (k === '@' && st.open && !st.open.startsWith('u')) {
    insert(st, '@')
    st.ov = { t: 'mention', q: '', pick: 0 }
    op(st, 'members', { mid: st.open })
    return
  }
  if (graphemes(k).length !== 1) return
  if (!st.open) {
    // 清單模式：字母一律是快捷鍵。
    switch (k) {
      case 'j': return moveSelection(st, 1)
      case 'k': return moveSelection(st, -1)
      case ' ': return toggleSection(st, st.onHeader ?? section(st, st.sel)[0])
      case 'c': return startCat(st)
      case 'n': return openNextUnread(st)
      case 'r':
        note(st, '重整清單…', false)
        return op(st, 'chats')
      case '/':
        st.ov = { t: 'search', q: '', pick: 0 }
        return op(st, 'search')
      case '?':
        st.ov = { t: 'help', scroll: 0 }
        return
      case 'q': return op(st, 'close')
    }
    return
  }
  if (!st.input && k === 'g') return onScrolledOlder(st)
  if (!st.input && k === '/') {
    st.ov = { t: 'search', q: '', pick: 0 }
    return op(st, 'search')
  }
  if (!st.input && k === '?') {
    st.ov = { t: 'help', scroll: 0 }
    return
  }
  insert(st, k)
}

function onScrolledOlder(st: S) {
  const v = st.props.view
  if (v.busy) return
  if (v.exhausted) return note(st, '沒有更舊的了')
  op(st, 'older', { mid: st.open })
}

function startCat(st: S) {
  const t = target(st)
  if (t) st.ov = { t: 'cat', mid: t[0], name: t[1], q: '', pick: 0 }
}

type CatChoice = { kind: 'existing' | 'new' | 'clear'; name: string }

function catChoices(st: S, ov: Extract<Overlay, { t: 'cat' }>): CatChoice[] {
  const q = ov.q.trim()
  const names = catNames(st)
  const out: CatChoice[] = names.filter(n => n.toLowerCase().includes(q.toLowerCase())).map(n => ({ kind: 'existing', name: n }))
  if (q && !names.includes(q) && !reserved(q)) out.unshift({ kind: 'new', name: q })
  if (catOf(st, ov.mid)) out.push({ kind: 'clear', name: '' })
  return out
}

const catLabel = (c: CatChoice) => (c.kind === 'new' ? `＋ 新增「${c.name}」` : c.kind === 'clear' ? '（不分類）' : c.name)

function mentionHits(st: S, q: string): [string, string][] {
  const m = st.props.members
  if (m.mid !== st.open) return []
  const ql = q.toLowerCase()
  return m.list.filter(([, n]) => n.toLowerCase().includes(ql))
}

function stickerPage(st: S, tab: number): Sticker[] {
  return tab === 0 ? st.props.prefs.stickers : (st.props.packs[tab - 1]?.stickers ?? [])
}

function msgHits(st: S) {
  const ov = st.ov
  const ms = st.props.msgSearch
  return ov && ov.t === 'msgsearch' && ms.q === ov.q ? ms.hits : ov && ov.t === 'msgsearch' && !ov.q ? [] : ms.hits
}

function overlayKey(st: S, ov: Overlay, k: string, ctrl: boolean, shift: boolean) {
  const typed = !ctrl && graphemes(k).length === 1 ? k : ''
  switch (ov.t) {
    case 'stickers': {
      const page = stickerPage(st, ov.tab)
      const n = page.length
      const perRow = 6
      const tabs = st.props.packs.length + 1
      if (k === 'tab') {
        ov.tab = (ov.tab + (shift ? tabs - 1 : 1)) % tabs
        ov.pick = 0
      } else if (k === 'left') ov.pick = Math.max(0, ov.pick - 1)
      else if (k === 'right') ov.pick = Math.min(Math.max(0, n - 1), ov.pick + 1)
      else if (k === 'up') ov.pick = Math.max(0, ov.pick - perRow)
      else if (k === 'down') ov.pick = Math.min(Math.max(0, n - 1), ov.pick + perRow)
      else if (k === 'return' || k === ' ') {
        st.ov = null
        const s = page[ov.pick]
        if (s) sendSticker(st, s)
      } else if (k === 'q' || k === 'backspace' || (ctrl && k === 'g')) st.ov = null
      return
    }
    case 'viewer': {
      const msgs = openMsgs(st)
      const here = msgs.findIndex(m => m.id === ov.id)
      const isImage = (m: Msg) => m.kind === 'IMAGE' && m.hasMedia
      if (k === 'left' || k === 'h' || k === 'k' || k === 'right' || k === 'l' || k === 'j') {
        const older = k === 'left' || k === 'h' || k === 'k'
        let next = -1
        if (older) {
          for (let i = here - 1; i >= 0; i--) if (isImage(msgs[i]!)) { next = i; break }
        } else {
          for (let i = here + 1; i < msgs.length; i++) if (isImage(msgs[i]!)) { next = i; break }
        }
        if (next < 0) return note(st, older ? '這是最早的一張' : '這是最新的一張')
        ov.id = msgs[next]!.id
        st.cursor = ov.id
        return op(st, 'view', { id: ov.id })
      }
      if (k === 'o') return op(st, 'openOriginal', { id: ov.id })
      if (k === 'q' || k === 'return' || k === 'backspace') {
        st.ov = null
        op(st, 'closeViewer')
      }
      return
    }
    case 'theme': {
      const names = st.props.themes.names
      if (k === 'up' || k === 'k') ov.pick = Math.max(0, ov.pick - 1)
      else if (k === 'down' || k === 'j') ov.pick = Math.min(names.length - 1, ov.pick + 1)
      else if (k === 'return') {
        st.ov = null
        st.themePreview = null
        return op(st, 'theme', { name: names[ov.pick] })
      } else if (k === 'q' || k === 'backspace' || (ctrl && k === 'y')) {
        st.ov = null
        st.themePreview = null
        return
      }
      st.themePreview = names[ov.pick] ?? null
      return
    }
    case 'help': {
      const max = st.helpMax
      if (k === 'j' || k === 'down') ov.scroll += 1
      else if (k === 'k' || k === 'up') ov.scroll -= 1
      else if (k === 'pagedown' || k === ' ') ov.scroll += 10
      else if (k === 'pageup') ov.scroll -= 10
      else if (k === 'home' || k === 'g') ov.scroll = 0
      else if (k === 'end' || k === 'G') ov.scroll = max
      else if (k === 'return' || k === 'f1' || k === 'q' || k === '?' || k === 'backspace') st.ov = null
      ov.scroll = Math.max(0, Math.min(max, ov.scroll))
      return
    }
    case 'react': {
      const pick = REACT.find(([d]) => d === k)
      const m = cursorMsg(st)
      st.ov = null
      if (pick && m) op(st, 'react', { id: m.id, type: pick[1] })
      return
    }
    case 'mention': {
      const hits = mentionHits(st, ov.q)
      if (k === 'up') ov.pick = Math.max(0, ov.pick - 1)
      else if (k === 'down') ov.pick = Math.min(Math.max(0, hits.length - 1), ov.pick + 1)
      else if (k === 'left') st.ov = null
      else if (k === 'backspace' && !ov.q) {
        st.ov = null
        edit(st, 'backspace') // 連那個 @ 一起刪
      } else if (k === 'backspace') {
        ov.q = graphemes(ov.q).slice(0, -1).join('')
        ov.pick = 0
      } else if (k === 'return') {
        const h = hits[ov.pick]
        if (h) {
          insert(st, `${h[1]} `) // 輸入框裡已經有那個 @
          st.mentions.push(h)
        }
        st.ov = null
      } else if (typed) {
        ov.q += typed
        ov.pick = 0
      }
      return
    }
    case 'msgsearch': {
      const hits = msgHits(st)
      if (k === 'up') ov.pick = Math.max(0, ov.pick - 1)
      else if (k === 'down') ov.pick = Math.min(Math.max(0, hits.length - 1), ov.pick + 1)
      else if (k === 'left' || (k === 'backspace' && !ov.q) || (ctrl && k === 's')) st.ov = null
      else if (k === 'backspace') {
        ov.q = graphemes(ov.q).slice(0, -1).join('')
        ov.pick = 0
        op(st, 'msgQuery', { q: ov.q })
      } else if (k === 'return') {
        const h = hits[ov.pick]
        if (h) {
          st.ov = null
          openChat(st, h.chat, h.chatName)
        }
      } else if (typed) {
        ov.q += typed
        ov.pick = 0
        op(st, 'msgQuery', { q: ov.q })
      }
      return
    }
    case 'search': {
      const hits = st.props.search.hits
      if (k === 'up') ov.pick = Math.max(0, ov.pick - 1)
      else if (k === 'down') ov.pick = Math.min(Math.max(0, hits.length - 1), ov.pick + 1)
      else if (k === 'left' || (k === 'backspace' && !ov.q)) st.ov = null
      else if (k === 'backspace') {
        ov.q = graphemes(ov.q).slice(0, -1).join('')
        ov.pick = 0
        op(st, 'searchQuery', { q: ov.q })
      } else if (k === 'return') {
        const h = hits[ov.pick]
        if (!h) return
        st.ov = null
        if (ov.forward) return op(st, 'forward', { item: ov.forward, mid: h.mid, name: h.name })
        openChat(st, h.mid, h.name)
      } else if (typed) {
        ov.q += typed
        ov.pick = 0
        op(st, 'searchQuery', { q: ov.q })
      }
      return
    }
    case 'cat': {
      const choices = catChoices(st, ov)
      if (k === 'up') ov.pick = Math.max(0, ov.pick - 1)
      else if (k === 'down') ov.pick = Math.min(Math.max(0, choices.length - 1), ov.pick + 1)
      else if (k === 'left' || (k === 'backspace' && !ov.q)) st.ov = null
      else if (k === 'backspace') {
        ov.q = graphemes(ov.q).slice(0, -1).join('')
        ov.pick = 0
      } else if (k === 'return') {
        const c = choices[ov.pick]
        if (!c) return
        st.ov = null
        op(st, 'cat', { mid: ov.mid, name: ov.name, cat: c.kind === 'clear' ? '' : c.name })
      } else if (typed) {
        ov.q += typed
        ov.pick = 0
      }
      return
    }
    case 'path': {
      if (k === 'left' || (k === 'backspace' && !ov.text)) st.ov = null
      else if (k === 'tab') op(st, 'complete', { text: ov.text })
      else if (k === 'backspace') {
        ov.text = graphemes(ov.text).slice(0, -1).join('')
        op(st, 'complete', { text: ov.text })
      } else if (k === 'return') op(st, 'attach', { path: ov.text })
      else if (typed) {
        ov.text += typed
        op(st, 'complete', { text: ov.text })
      }
      return
    }
  }
}

function paste(st: S, raw: string) {
  const text = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const first = text.split('\n')[0] ?? ''
  const ov = st.ov
  if (ov) {
    if (ov.t === 'cat') ov.q += first.trim()
    else if (ov.t === 'path') {
      ov.text += first.trim()
      op(st, 'complete', { text: ov.text })
    } else if (ov.t === 'msgsearch') {
      ov.q += first
      op(st, 'msgQuery', { q: ov.q })
    } else if (ov.t === 'search') {
      ov.q += first
      op(st, 'searchQuery', { q: ov.q })
    } else if (ov.t === 'mention') ov.q += first.trim()
    return
  }
  if (!st.open || peeking(st)) return
  // 一行、看起來像路徑（把檔案拖進終端機就是貼路徑）：讓 hooks 那邊確認是不是檔案。
  const t = text.trim()
  if (!t.includes('\n') && /^(['"]?(\/|~\/|file:\/\/))/.test(t)) return op(st, 'pasteText', { text })
  insert(st, text.replace(/\n+$/, ''))
}

// ------------------------------------------------------------------ 指標

function pointer(st: S, ev: ClientPointerEvent) {
  if (ev.type !== 'down' || ev.button !== 'left') return
  if (st.ov) {
    if (st.ov.t === 'viewer') {
      st.ov = null
      op(st, 'closeViewer')
    }
    return
  }
  const hit = st.hits.find(h => contains(h.r, ev.x, ev.y))
  if (!hit) return
  if (hit.kind === 'back') return escape(st)
  if (hit.kind === 'header') return toggleSection(st, hit.id)
  if (hit.kind === 'chat') {
    const c = st.props.chats.find(x => x.mid === hit.id)
    st.sel = hit.id
    st.onHeader = null
    if (c) openChat(st, c.mid, c.name)
    return
  }
  const m = openMsgs(st).find(x => x.id === hit.id)
  if (m) {
    st.cursor = m.id
    openMsg(st, m)
  }
}

// ------------------------------------------------------------------ 每一輪（tick）

function tick(st: S): boolean {
  let changed = false
  // 游標停下來 200ms 才抓預覽，快速掃過時不必每個都打一次 LINE。
  const p = peeking(st)
  const want = st.narrow ? '' : p ? p.mid : !st.open ? st.sel : ''
  if (want && st.props.peek.mid !== want && st.asked !== want) {
    if (st.dwell.mid !== want) st.dwell = { mid: want, at: Date.now() }
    else if (Date.now() - st.dwell.at >= 200) {
      st.asked = want
      op(st, 'peek', { mid: want })
      changed = true
    }
  }
  if (st.status.text && Date.now() - st.status.at > 12000) {
    st.status = { text: '', at: 0, warn: false }
    changed = true
  }
  if (st.outbox.length && Date.now() - st.lastPost > 800) {
    st.sig = ''
    changed = true
  }
  return changed
}

// ------------------------------------------------------------------ 畫

const AVATAR_W = 4
const NARROW_COLS = 50
const IMAGE_ROWS = 12
const STICKER_ROWS = 6
const STICKER_CELL: [number, number] = [12, 6]

type Theme = Palette & { dim: Sty }

function theme(st: S): Theme {
  const t = st.props.themes
  const p = t.palettes[st.themePreview ?? t.chosen] ?? t.palettes['Claude Code'] ?? { accent: 'green', onAccent: 'black', warning: 'yellow', error: 'red', ok: 'green' }
  return { ...p, dim: p.muted ? { fg: p.muted } : { d: true } }
}

/** 一則訊息的字：網址標成底線＋強調色。回傳每個字與它的樣式。 */
function richChars(text: string, accent: string, base: Sty): [string, Sty][] {
  const out: [string, Sty][] = []
  const link: Sty = { ...base, fg: accent, u: true }
  const re = /https?:\/\/\S+/g
  let last = 0
  for (const m of text.matchAll(re)) {
    for (const g of graphemes(text.slice(last, m.index))) out.push([g, base])
    for (const g of graphemes(m[0])) out.push([g, link])
    last = (m.index ?? 0) + m[0].length
  }
  for (const g of graphemes(text.slice(last))) out.push([g, base])
  return out
}

/** 折行：每列最多 w 格，能在空白處斷就在空白處斷，中文隨處可斷。 */
function wrap(chars: [string, Sty][], w: number): [string, Sty][][] {
  const rows: [string, Sty][][] = []
  let row: [string, Sty][] = []
  let used = 0
  const flush = () => {
    rows.push(row)
    row = []
    used = 0
  }
  for (const c of chars) {
    if (c[0] === '\n') {
      flush()
      continue
    }
    const cw = gw(c[0])
    if (used + cw > w) {
      // 在最後一個空白處斷（那個字詞整個搬到下一列），斷點太前面就硬斷。
      const sp = row.map(x => x[0]).lastIndexOf(' ')
      if (sp > row.length / 2 && /[\x21-\x7e]/.test(c[0])) {
        const carry = row.slice(sp + 1)
        row = row.slice(0, sp + 1)
        flush()
        row = carry
        used = carry.reduce((n, x) => n + gw(x[0]), 0)
      } else flush()
    }
    row.push(c)
    used += cw
  }
  rows.push(row)
  return rows
}

function draw(st: S, cols: number, rows: number): { grid: Grid; slots: Slot[]; want: string[] } {
  const g = new Grid(cols, rows)
  const t = theme(st)
  const props = st.props
  const slots: Slot[] = []
  const want: string[] = []
  const images = props.images
  st.hits = []

  if (t.bg) g.fill({ x: 0, y: 0, w: cols, h: rows }, { bg: t.bg, fg: t.text })
  const base: Sty = t.text ? { fg: t.text } : {}
  const accentSty: Sty = { fg: t.accent }
  const chip: Sty = { fg: t.onAccent, bg: t.accent, b: true }
  const frameSty = (active: boolean): Sty => (active ? { fg: t.accent } : t.border ? { fg: t.border } : t.dim)

  /** 要一張圖：dims 已知就回傳它，否則記下來跟 hooks 要。 */
  const media = (key: string): [number, number] | 0 | undefined => {
    if (!images) return 0
    const d = props.media[key]
    if (d === undefined && !want.includes(key)) want.push(key)
    return d
  }

  if (cols < 24 || rows < 8) {
    g.put(0, 0, 'LINE：面板太小', t.dim)
    return { grid: g, slots, want }
  }

  // 還沒登入：登入畫面（QR、PIN）。
  if (props.conn.checked && !props.conn.loggedIn) {
    drawLogin(st, g, t, slots, media)
    return { grid: g, slots, want }
  }

  const main = rows - 1
  const inChat = !!st.open
  const tight = cols <= NARROW_COLS
  const narrow = tight || st.sidebar === 'hidden'
  st.narrow = narrow
  const compact = st.sidebar === 'names' && !narrow
  const listW = narrow ? (inChat ? 0 : cols) : compact ? 22 : 34
  const listR: Rect = { x: 0, y: 0, w: listW, h: main }
  const rightR: Rect = { x: listW, y: 0, w: cols - listW, h: main }
  const msgR: Rect = { x: rightR.x, y: 0, w: rightR.w, h: Math.max(3, main - 3) }
  const inputR: Rect = { x: rightR.x, y: msgR.h, w: rightR.w, h: main - msgR.h }

  // ---------------------------------------------------------------- 聊天室清單
  const list = sorted(st)
  if (!st.sel || !list.some(c => c.mid === st.sel)) st.sel = list[0]?.mid ?? ''
  if (listW > 0) {
    if (t.sidebarBg) g.fill(listR, { bg: t.sidebarBg, fg: t.text })
    const unreadAll = list.reduce((n, c) => n + Math.max(0, c.unread), 0)
    const title: Span[] = [[' LINE ', { ...base, b: true }]]
    if (unreadAll > 0) title.push([compact ? `· ${unreadAll} ` : `· 未讀 ${unreadAll} `, accentSty])
    if (!props.conn.checked) title.push(['連線中… ', t.dim])
    g.frame(listR, frameSty(!inChat), title)
    const lin = inner(listR)
    const lead = compact ? 0 : AVATAR_W
    const today = dayIndex(Date.now())
    const sectionUnread = new Map<string, number>()
    for (const c of list) {
      const s = section(st, c.mid)[0]
      sectionUnread.set(s, (sectionUnread.get(s) ?? 0) + Math.max(0, c.unread))
    }
    const vr = visibleRows(st, list)
    const heights = vr.map(r => (r.kind === 'header' || compact ? 1 : 2))
    const selAt = vr.findIndex(r => (r.kind === 'header' ? st.onHeader === r.name : st.onHeader === null && r.chat.mid === st.sel))
    // 跟 ratatui 的 List 一樣：選取項要看得到，offset 只在必要時動。
    if (selAt >= 0) {
      if (selAt < st.listOffset) st.listOffset = selAt
      let used = 0
      for (let i = st.listOffset; i <= selAt; i++) used += heights[i]!
      while (used > lin.h && st.listOffset < selAt) {
        used -= heights[st.listOffset]!
        st.listOffset += 1
      }
    }
    st.listOffset = Math.min(st.listOffset, Math.max(0, vr.length - 1))
    let y = lin.y
    const w = lin.w
    for (let i = st.listOffset; i < vr.length; i++) {
      const r = vr[i]!
      const h = heights[i]!
      if (y + h > lin.y + lin.h) break
      if (r.kind === 'header') {
        const collapsed = props.prefs.collapsed.includes(r.name)
        const unread = sectionUnread.get(r.name) ?? 0
        const count = unread > 0 ? ` ${unread} ` : ''
        const on = st.onHeader === r.name
        if (on) g.fill({ x: lin.x, y, w, h: 1 }, t.selection ? { bg: t.selection } : { r: true })
        const head = fit(`${collapsed ? '▸' : '▾'} ${r.name}`, w - 1 - width(count))
        g.put(lin.x, y, head, { fg: t.accent, b: true, ...(on && !t.selection ? { r: true } : {}) })
        g.put(lin.x + w - width(count), y, count, chip)
        st.hits.push({ r: { x: lin.x, y, w, h: 1 }, kind: 'header', id: r.name })
      } else {
        const c = r.chat
        const selected = c.mid === st.sel && st.onHeader === null
        if (selected && t.selection) g.fill({ x: lin.x, y, w, h }, { bg: t.selection })
        const bar: Span = selected ? ['▌', accentSty] : [' ']
        const when = !c.lastTime ? '' : dayIndex(c.lastTime) === today ? clock(c.lastTime) : dayLabel(c.lastTime)
        const label = props.prefs.vip.includes(c.mid) ? `★ ${c.name}` : c.name
        const nameSty: Sty = selected ? { fg: t.accent, b: true } : c.unread > 0 ? { ...base, b: true } : base
        const badge = c.unread <= 0 ? '' : c.unread > 99 ? ' 99+ ' : ` ${c.unread} `
        if (compact) {
          const name = fit(label, w - 3 - width(badge))
          g.spans(lin.x, y, [bar, [' '], [name, nameSty]])
          g.put(lin.x + w - width(badge), y, badge, chip)
        } else {
          const name = fit(label, w - 3 - lead - width(when))
          g.spans(lin.x, y, [bar, [' '.repeat(1 + lead)], [name, nameSty]])
          g.put(lin.x + w - width(when), y, when, t.dim)
          // 群組的預覽帶上是誰說的；一對一時發話者就是聊天室名稱，不重複。
          const pv = !c.lastFrom || c.lastFrom === c.name ? c.lastText : `${c.lastFrom}：${c.lastText}`
          g.spans(lin.x, y + 1, [bar, [' '.repeat(1 + lead)], [fit(pv, w - 3 - lead - width(badge)), t.dim]])
          g.put(lin.x + w - width(badge), y + 1, badge, chip)
          avatar(g, slots, media, { x: lin.x + 1, y, w: AVATAR_W, h: 2 }, c.avatar, c.name, senderColor(c.name), t)
        }
        st.hits.push({ r: { x: lin.x, y, w, h }, kind: 'chat', id: c.mid })
      }
      y += h
    }
    if (list.length === 0) g.put(lin.x + 1, lin.y, props.conn.checked ? '（還沒有聊天室）' : '連線中…', t.dim)
  }

  // ---------------------------------------------------------------- 訊息
  const shown = shownMsgs(st)
  const peek = peeking(st)
  if (msgR.w > 0) {
    const msgs = shown.msgs
    const title: Span[] = !shown.mid
      ? []
      : shown.preview
        ? [[` ${shown.name} `, { ...t.dim, b: true }], ['· Enter 進入 ', t.dim]]
        : [[' ‹ ', { fg: t.accent, b: true }], [`${shown.name} `, { ...base, b: true }]]
    // 標題的 ‹：點一下回清單（Esc 在面板裡不一定送得進來，滑鼠一定可以）。
    if (inChat && !shown.preview) st.hits.push({ r: { x: msgR.x + 1, y: msgR.y, w: 3 + width(shown.name), h: 1 }, kind: 'back', id: '' })
    const scroll = shown.preview ? 0 : Math.min(st.scroll, Math.max(0, msgs.length - 1))
    g.frame(msgR, frameSty(inChat), title, scroll > 0 ? [[` ↓ 下面還有 ${scroll} 則 `]] : [])
    const mi = inner(msgR)
    if (msgs.length === 0) {
      const text = shown.busy ? '載入中…' : !inChat && !shown.mid ? '選一個聊天室' : '沒有訊息（LINE 只保留約兩週）'
      g.put(mi.x + Math.max(0, Math.floor((mi.w - width(text)) / 2)), mi.y + Math.floor(mi.h / 2), text, t.dim)
    }
    // 由下往上排：聊天室看的是最新的，捲動就是「從底往上跳過幾則」。
    const maxW = Math.max(1, mi.w - (AVATAR_W + 6))
    const end = msgs.length - scroll
    type Lay = { i: number; sep: boolean; head: boolean; gap: number; img: [number, number]; imgKey: string; text: [string, Sty][][]; tw: number; skip: number }
    const stack: [Lay, number][] = []
    let y = mi.y + mi.h
    for (let i = end - 1; i >= 0; i--) {
      const m = msgs[i]!
      const prev = msgs[i - 1]
      const sep = !prev || dayIndex(prev.time) !== dayIndex(m.time)
      // 同一個人五分鐘內連續發的，只有第一則顯示名字與時間。
      const head = sep || !prev || prev.mine !== m.mine || prev.fromName !== m.fromName || m.time - prev.time > 5 * 60000
      const gap = head && !sep ? 1 : 0
      let img: [number, number] = [0, 0]
      let imgKey = ''
      let text = m.text
      if (m.media) {
        const isSticker = m.kind === 'STICKER'
        imgKey = `${m.media}@${isSticker ? 200 : 320}`
        const d = media(imgKey)
        const maxRows = isSticker ? STICKER_ROWS : IMAGE_ROWS
        const boxW = Math.min(maxW, 60)
        if (d === 0) {
          if (!text) text = images ? '[圖片讀不到]' : isSticker ? '[貼圖]' : '[圖片]'
          imgKey = ''
        } else if (d === undefined || d[0] === 0) {
          img = [Math.min(boxW, isSticker ? 12 : 24), maxRows] // 還在轉：先留位置
        } else {
          img = fitCells(d, boxW, maxRows)
        }
      }
      let tw = 0
      let wrapped: [string, Sty][][] = []
      if (text) {
        const longest = Math.max(...text.split('\n').map(width))
        tw = Math.max(1, Math.min(longest + 1, maxW))
        const sty = m.kind === 'UNSENT' ? t.dim : base
        wrapped = wrap(m.kind === 'UNSENT' ? graphemes(text).map(c => [c, sty] as [string, Sty]) : richChars(text, t.accent, base), tw)
      }
      const react = m.reactions.length ? 1 : 0
      const full = (sep ? 1 : 0) + gap + (head ? 1 : 0) + img[1] + wrapped.length + react
      const room = y - mi.y
      if (full === 0 || room <= 0) break
      if (full <= room) {
        y -= full
        stack.push([{ i, sep, head, gap, img, imgKey, text: wrapped, tw, skip: 0 }, full])
        continue
      }
      // 放不下：最底下那則畫開頭，其餘畫尾端 —— 視覺上都是從下往上接。
      const skip = stack.length === 0 ? 0 : full - room
      y = mi.y
      stack.push([{ i, sep, head, gap, img, imgKey, text: wrapped, tw, skip }, room])
      break
    }
    if (stack.length < msgs.length && msgs.length > 0) {
      // 捲軸：右邊框上畫一段。
      const track = msgR.h - 2
      const pos = Math.max(0, end - 1) / Math.max(1, msgs.length - 1)
      const thumb = Math.max(1, Math.round((track * stack.length) / msgs.length))
      const top = msgR.y + 1 + Math.round(pos * (track - thumb))
      for (let k = 0; k < thumb; k++) g.put(msgR.x + msgR.w - 1, top + k, '┃', t.dim)
    }
    const oneToOne = shown.mid.startsWith('u')
    for (let s = stack.length - 1; s >= 0; s--) {
      const [L, h] = stack[s]!
      const m = msgs[L.i]!
      const area: Rect = { x: mi.x, y, w: mi.w, h }
      y += h
      let cy = area.y - L.skip
      const whole = (yy: number, hh: number) => yy >= area.y && yy + hh <= area.y + area.h
      if (L.sep && whole(cy, 1)) {
        const line = `──────  ${dayLabelLong(m.time)}  ──────`
        g.put(mi.x + Math.max(0, Math.floor((mi.w - width(line)) / 2)), cy, line, t.dim)
      }
      cy += (L.sep ? 1 : 0) + L.gap
      const selected = !shown.preview && st.cursor === m.id
      const color = m.mine ? t.accent : senderColor(m.fromName)
      const x = mi.x + 3 + AVATAR_W
      const top = Math.max(cy, area.y)
      const body: Rect = { x: area.x, y: top, w: area.w, h: area.y + area.h - top }
      if (!shown.preview) st.hits.push({ r: body, kind: 'msg', id: m.id })
      if (selected) for (let yy = body.y; yy < body.y + body.h; yy++) g.put(area.x, yy, '┃', accentSty)
      if (L.head) {
        if (whole(cy, 2)) avatar(g, slots, media, { x: mi.x + 2, y: cy, w: AVATAR_W, h: 2 }, m.avatar ?? props.avatars[m.from], m.fromName, color, t)
        if (whole(cy, 1)) g.spans(x, cy, [[fit(m.mine ? '我' : m.fromName, maxW - 7), { fg: color, b: true }], ['  '], [clock(m.time), { ...t.dim, i: true }]])
        cy += 1
      }
      // ↗：這則點得開（附件或連結）。放在內容第一行的外側。
      if (openable(m) && whole(cy, 1)) {
        const firstW = L.img[1] > 0 ? L.img[0] : L.tw
        g.put(x + firstW + 1, cy, props.playing === m.id ? '▶' : '↗', selected ? { fg: t.accent, r: true } : accentSty)
      }
      // 自己發的顯示已讀（一對一只說「已讀」，群組帶人數）；別人 @ 了我就標「@你」。
      const tag: Span | undefined =
        m.mine && m.readCount > 0
          ? [oneToOne ? '已讀' : `已讀 ${m.readCount}`, t.dim]
          : !m.mine && m.mentions.some(x => x === props.conn.me || x === 'all')
            ? ['@你', { fg: t.accent, b: true }]
            : undefined
      const tagY = cy
      if (L.img[1] > 0) {
        if (whole(cy, L.img[1])) {
          const r: Rect = { x, y: cy, w: L.img[0], h: L.img[1] }
          const label = m.kind === 'STICKER' ? '[貼圖]' : '[圖片]'
          g.put(r.x, r.y, fit(label, r.w), t.dim)
          if (L.imgKey) slots.push({ k: L.imgKey, ...r, a: label })
        }
        cy += L.img[1]
      }
      if (tag && whole(tagY, 1)) g.put(mi.x + mi.w - width(tag[0]) - 2, tagY, tag[0], tag[1])
      for (const row of L.text) {
        if (whole(cy, 1)) {
          let xx = x
          for (const [ch, sty] of row) xx = g.put(xx, cy, ch, sty)
        }
        cy += 1
      }
      if (m.reactions.length && whole(cy, 1)) g.put(x, cy, reactionSummary(m.reactions), base, mi.x + mi.w - x)
    }

    // ---------------------------------------------------------------- 輸入列
    g.frame(inputR, frameSty(inChat))
    const ii = inner(inputR)
    const chipText = st.attach ? ` ${fit(st.attach.name, 28)} · ${humanSize(st.attach.size)} ` : ''
    const chipW = chipText ? width(chipText) + 1 : 0
    const room = Math.max(1, ii.w - 3 - chipW)
    let x = g.put(ii.x, ii.y, '› ', inChat ? accentSty : t.dim)
    if (chipText) x = g.put(x, ii.y, chipText, chip) + 1
    if (peek) g.put(x, ii.y, `Enter 進入 ${fit(peek.name, 20)}　← 回到 ${fit(st.openName, 20)}`, t.dim)
    else if (!inChat) g.put(x, ii.y, '先選一個聊天室', t.dim)
    else if (!st.input && chipText) g.put(x, ii.y, 'Enter 送出　Backspace 取消附件', t.dim)
    else if (!st.input) {
      g.put(x, ii.y, `傳訊息給 ${fit(st.openName, room - 12)}…`, t.dim)
      if (props.focused) g.put(x, ii.y, ' ', { r: true })
    } else {
      const [vis, used] = inputWindow(st.input, st.caret, room)
      g.put(x, ii.y, vis, base)
      // 游標：反白一格（Client 沒有真的終端機游標）。
      const cx = x + used
      const chars = graphemes(vis)
      let wsum = 0
      let at = ''
      for (const c of chars) {
        if (wsum === used) {
          at = c
          break
        }
        wsum += gw(c)
      }
      g.put(cx, ii.y, at || ' ', { ...base, r: true })
    }
  }

  // ---------------------------------------------------------------- 狀態列
  const [mode, hints] = modeHints(st, tight, !!peek)
  const sy = rows - 1
  let sx = g.put(0, sy, ` ${mode} `, chip) + 1
  if (st.open && !narrow) sx = g.put(sx, sy, `${fit(st.openName, 24)}  `, base)
  const status = [st.status, props.status].sort((a, b) => b.at - a.at)[0]!
  const statusLive = status.text && Date.now() - status.at < 12000
  // 右：VIP 的未讀、跟 daemon 的連線。
  const right: Span[] = []
  const waiting = list.filter(c => c.unread > 0 && props.prefs.vip.includes(c.mid))
  if (waiting.length) {
    const total = waiting.reduce((n, c) => n + c.unread, 0)
    const text = tight ? ` ★ ${total} ` : waiting.length === 1 ? ` ★ ${fit(waiting[0]!.name, 16)} ${total} ` : ` ★ ${fit(waiting[0]!.name, 12)} 等 ${waiting.length} 個 · ${total} `
    right.push([text, chip])
  }
  right.push([' ●', { fg: props.conn.online ? t.ok : t.error }])
  right.push([tight ? ' ' : props.conn.online ? ` 已連線 ` : ` 離線 `, t.dim])
  const rw = right.reduce((n, [s]) => n + width(s), 0)
  const leftRoom = cols - rw - sx
  if (statusLive) g.put(sx, sy, fit(status.text, leftRoom), status.warn ? { fg: t.warning } : base)
  else if (!props.focused) g.put(sx, sy, fit('點一下面板開始操作（滑鼠點進來，鍵盤才會送進這裡）', leftRoom), t.dim)
  else {
    let hx = sx
    for (const [k, what] of hints) {
      const piece = width(k) + width(what) + 4
      if (hx + piece > sx + leftRoom) break
      hx = g.put(hx, sy, k, { ...base, b: true })
      hx = g.put(hx, sy, ` ${what}   `, t.dim)
    }
  }
  g.spans(cols - rw, sy, right)

  drawOverlays(st, g, t, slots, media)
  return { grid: g, slots, want }
}

function fitCells(d: [number, number], maxW: number, maxRows: number): [number, number] {
  const [pw, ph] = d
  // 格子大約 1:2（寬:高）。只縮不放：小圖就照原本大小（以一格 8×16 像素估）。
  const natW = Math.max(1, Math.ceil(pw / 8))
  const natH = Math.max(1, Math.ceil(ph / 16))
  let h = Math.min(maxRows, natH)
  let w = Math.round((h * 2 * pw) / ph)
  if (w > maxW) {
    w = maxW
    h = Math.max(1, Math.round((w * ph) / (2 * pw)))
  }
  return [Math.max(1, Math.min(w, natW, maxW)), Math.max(1, h)]
}

function avatar(
  g: Grid,
  slots: Slot[],
  media: (k: string) => [number, number] | 0 | undefined,
  r: Rect,
  path: string | undefined,
  name: string,
  color: string,
  t: Theme,
) {
  const initial = graphemes(name)[0] ?? '?'
  g.fill(r, { bg: color })
  g.put(r.x + 1, r.y, initial, { fg: t.onAccent, bg: color, b: true })
  if (!path) return
  const key = `${path}@64`
  const d = media(key)
  if (d && d[0] > 0) slots.push({ k: key, ...r, a: ` ${initial}` })
}

function modeHints(st: S, tight: boolean, isPeek: boolean): [string, [string, string][]] {
  const ov = st.ov
  if (ov?.t === 'theme') return ['主題', [['↑↓', '預覽'], ['Enter', '套用'], ['q', '還原']]]
  if (ov?.t === 'cat') return ['分類', [['↑↓', '選擇'], ['Enter', '確定'], ['←', '取消']]]
  if (ov?.t === 'path') return ['附檔', [['Tab', '補完'], ['Enter', '附加'], ['←', '取消']]]
  if (ov?.t === 'search' && ov.forward) return ['轉傳', [['↑↓', '選擇'], ['Enter', '送過去'], ['←', '取消']]]
  if (ov?.t === 'search') return ['搜尋', [['↑↓', '選擇'], ['Enter', '開啟'], ['←', '取消']]]
  if (isPeek) return ['預覽', [['↑↓', '選擇'], ['Enter', '進入'], ['←', '回到這個聊天室']]]
  if (st.cursor) return ['選取', [['r', '表情'], ['f', '轉傳'], ['s', '跟著貼'], ['d', '收回'], ['Enter', '開啟'], ['←', '取消']]]
  if (st.open) {
    if (tight) return ['對話', [['←', '清單'], ['Enter', '送出'], ['F1', '按鍵']]]
    return ['對話', [['Enter', '送出'], ['^V', '貼上'], ['^F', '附檔'], ['Tab', '選訊息'], ['^G', '貼圖'], ['F1', '按鍵'], ['←', '返回']]]
  }
  if (tight) return ['清單', [['Enter', '開啟'], ['/', '搜尋'], ['?', '按鍵']]]
  return ['清單', [['↑↓', '選擇'], ['Enter', '開啟'], ['n', '下一個未讀'], ['/', '搜尋'], ['?', '按鍵'], ['q', '關閉']]]
}

function drawLogin(st: S, g: Grid, t: Theme, slots: Slot[], media: (k: string) => [number, number] | 0 | undefined) {
  const c = st.props.conn
  const l = c.login
  const h = Math.min(g.h - 2, 46)
  const area = centered({ x: 0, y: 0, w: g.w, h: g.h }, h * 2, h)
  g.frame(area, { fg: t.accent }, [[' 登入 LINE ', { b: true }]], [[' Enter 登入   q 關閉 ']])
  const i = inner(area)
  const ii: Rect = { x: i.x + 2, y: i.y + 1, w: Math.max(0, i.w - 4), h: Math.max(0, i.h - 2) }
  const lines: Span[][] =
    !c.online && !l.status
      ? [[[`連不上 daemon（${c.where}）`, { fg: t.warning }]], [['daemon 要在跑：systemctl --user start enil', t.dim]]]
      : l.status === 'qr'
        ? [[['用手機的 LINE 掃這個 QR', { b: true }]], [[l.url ?? '', t.dim]]]
        : l.status === 'pin'
          ? [[['到手機的 LINE 輸入這組數字']], [[l.pin ?? '', { fg: t.accent, b: true }]]]
          : l.status === 'starting'
            ? [[['登入中…']]]
            : [[[l.error || '還沒登入', { fg: t.warning }]], [['Enter', { b: true }], [' 產生登入用的 QR（會讓 daemon 那台登入；別台的 enil 會被踢掉）']]]
  let y = ii.y
  for (const line of lines) {
    // 長網址要折行。
    const chars: [string, Sty][] = []
    for (const [text, sty] of line) for (const ch of graphemes(text)) chars.push([ch, sty ?? {}])
    for (const row of wrap(chars, Math.max(1, ii.w))) {
      if (y >= ii.y + 4) break
      let x = ii.x
      for (const [ch, sty] of row) x = g.put(x, y, ch, sty)
      y += 1
    }
  }
  if (l.status === 'qr' && l.qrPng) {
    const key = `${l.qrPng}@600`
    const d = media(key)
    const rest: Rect = { x: ii.x, y: ii.y + 4, w: ii.w, h: Math.max(0, ii.h - 4) }
    if (d && d[0] > 0 && rest.h > 2) {
      const side = Math.min(rest.h, Math.floor(rest.w / 2))
      const r: Rect = { x: rest.x + Math.floor((rest.w - side * 2) / 2), y: rest.y, w: side * 2, h: side }
      slots.push({ k: key, ...r, a: 'QR（終端機畫不出圖：看上面那行網址）' })
    } else if (d === 0) g.put(rest.x, rest.y, 'QR 畫不出來：看上面那行網址', t.dim)
  }
}

// ------------------------------------------------------------------ 浮層

function drawOverlays(st: S, g: Grid, t: Theme, slots: Slot[], media: (k: string) => [number, number] | 0 | undefined) {
  const ov = st.ov
  if (!ov) return
  const full: Rect = { x: 0, y: 0, w: g.w, h: g.h }
  const accent: Sty = { fg: t.accent }
  const bold: Sty = { b: true }
  const base: Sty = t.text ? { fg: t.text } : {}
  const clear = (r: Rect) => {
    g.fill(r, t.bg ? { bg: t.bg, fg: t.text } : {})
    // 浮層底下的圖要拿掉，不然會蓋在浮層上面。
    for (let i = slots.length - 1; i >= 0; i--) if (overlaps(slots[i]!, r)) slots.splice(i, 1)
  }
  const pickRow = (r: Rect, y: number, picked: boolean) => {
    if (picked && t.selection) g.fill({ x: r.x, y, w: r.w, h: 1 }, { bg: t.selection })
  }
  const props = st.props

  if (ov.t === 'search') {
    const hits = props.search.hits
    const area = centered(full, 56, 18)
    clear(area)
    g.frame(area, accent, [[ov.forward ? ' 轉傳到… ' : ' 搜尋聊天室 ', bold]], [[` ${hits.length} 筆 `]])
    const i = inner(area)
    const x = g.put(i.x, i.y, '/ ', accent)
    const qx = g.put(x, i.y, ov.q, base)
    g.put(qx, i.y, ' ', { r: true })
    const rows = i.h - 1
    const start = Math.max(0, ov.pick + 1 - rows)
    if (hits.length === 0) g.put(i.x, i.y + 1, props.search.loading ? '  載入中…' : '  沒有符合的聊天室', t.dim)
    hits.slice(start, start + rows).forEach((c, k) => {
      const y = i.y + 1 + k
      const picked = start + k === ov.pick
      pickRow(i, y, picked)
      const badge = c.unread > 0 ? ` ${Math.min(999, c.unread)} ` : ''
      const nt = c.isNew ? '好友・新對話' : ''
      g.spans(i.x, y, [[picked ? '▌ ' : '  ', accent], [fit(c.name, i.w - 3 - width(badge) - width(nt)), picked ? { fg: t.accent, b: true } : base]])
      g.put(i.x + i.w - width(badge) - width(nt), y, nt, t.dim)
      g.put(i.x + i.w - width(badge), y, badge, { fg: t.onAccent, bg: t.accent })
    })
  }

  if (ov.t === 'react') {
    const parts: Span[] = REACT.flatMap(([k, kind]) => [[` ${k} `, { fg: t.accent, b: true }] as Span, [`${kind === 'UNDO' ? '取消回應' : glyph(kind)}  `] as Span])
    const w = parts.reduce((n, [s]) => n + width(s), 0)
    const area = centered(full, w + 4, 3)
    clear(area)
    g.frame(area, accent, [[' 表情 ', bold]])
    g.spans(area.x + 1, area.y + 1, parts, area.w - 2)
  }

  if (ov.t === 'mention') {
    const hits = mentionHits(st, ov.q)
    const loaded = props.members.mid === st.open
    const area = centered(full, 40, 12)
    clear(area)
    g.frame(area, accent, [[' 提及 ', bold]], [[' Enter 選　← 只打 @ ']])
    const i = inner(area)
    g.spans(i.x, i.y, [['@', accent], [ov.q, base], [' ', { r: true }]])
    let y = i.y + 1
    if (!loaded) g.put(i.x, y++, ' 載入成員…', t.dim)
    const rows = i.h - 1
    const start = Math.max(0, ov.pick + 1 - rows)
    for (const [k, [, name]] of hits.slice(start, start + rows).entries()) {
      if (y >= i.y + i.h) break
      const picked = start + k === ov.pick
      g.spans(i.x, y++, [[picked ? '▌ ' : '  ', accent], [fit(name, i.w - 3), picked ? { fg: t.accent, b: true } : base]])
    }
  }

  if (ov.t === 'msgsearch') {
    const ms = props.msgSearch
    const hits = msgHits(st)
    const area = centered(full, 100, 26)
    clear(area)
    g.frame(area, accent, [[' 搜尋訊息 ', bold]], [[` ${ms.total} 筆 · 存檔共 ${ms.archived} 則 · Enter 開聊天室 · ← 關閉 `]])
    const i = inner(area)
    g.spans(i.x, i.y, [['⌕ ', accent], [ov.q, base], [' ', { r: true }]])
    const rows = Math.floor((i.h - 1) / 2)
    const start = Math.max(0, ov.pick + 1 - rows)
    const first = (ov.q.split(/\s+/).find(Boolean) ?? '').toLowerCase()
    if (hits.length === 0) g.put(i.x, i.y + 1, ms.loading ? '  讀取存檔…' : ov.q.trim() ? '  沒有符合的訊息' : '  打字開始搜尋（空白分開的詞都要出現）', t.dim)
    hits.slice(start, start + rows).forEach((h, k) => {
      const y = i.y + 1 + k * 2
      const picked = start + k === ov.pick
      const bar: Span = [picked ? '▌ ' : '  ', accent]
      const who = h.fromName === h.chatName ? '' : ` · ${h.fromName}`
      g.spans(i.x, y, [bar, [`${dayLabel(h.time)} ${clock(h.time)}  `, t.dim], [fit(`${h.chatName}${who}`, i.w - 16), picked ? { fg: t.accent, b: true } : { ...base, b: true }]])
      g.spans(i.x, y + 1, [bar, ...snippet(h.text, first, i.w - 4, t.accent, base)])
    })
  }

  if (ov.t === 'viewer') {
    clear(full)
    const v = props.viewer
    const status = [st.status, props.status].sort((a, b) => b.at - a.at)[0]!
    g.frame(full, accent, [[' 圖片 ', bold]], [[' ←→ 上一張／下一張   o 用外部程式開   q 關閉 ']], status.text && Date.now() - status.at < 12000 ? [[` ${status.text} `, { fg: t.warning }]] : [])
    const i = inner(full)
    const d = v.id === ov.id && v.key ? media(v.key) : undefined
    if (v.id === ov.id && v.error) g.put(i.x + 1, i.y + Math.floor(i.h / 2), fit(v.error, i.w - 2), { fg: t.warning })
    else if (d && d[0] > 0) {
      const [w, h] = fitCells(d, i.w, i.h)
      const r: Rect = { x: i.x + Math.floor((i.w - w) / 2), y: i.y + Math.floor((i.h - h) / 2), w, h }
      slots.push({ k: v.key, ...r, a: '[圖片：這個終端機畫不出圖，按 o 用外部程式開]' })
      g.put(r.x, r.y, fit('[圖片：這個終端機畫不出圖，按 o 用外部程式開]', r.w), t.dim)
    } else {
      const text = '載入中…'
      g.put(i.x + Math.floor((i.w - width(text)) / 2), i.y + Math.floor(i.h / 2), text, t.dim)
    }
    return
  }

  if (ov.t === 'stickers') {
    const [cw, ch] = STICKER_CELL
    const area = centered(full, cw * 6 + 2, ch * 4 + 4)
    clear(area)
    g.frame(area, accent, [[' 貼圖 ', bold]], [[' Tab 換一組   方向鍵選   Enter 送出   q 取消 ']])
    const i = inner(area)
    const names = ['最近', ...props.packs.map(p => fit(p.name, 14))]
    let x = i.x
    for (let k = Math.max(0, ov.tab - 2); k < names.length; k++) {
      x = g.put(x, i.y, ` ${names[k]} `, k === ov.tab ? { fg: t.onAccent, bg: t.accent, b: true } : t.dim) + 1
    }
    const grid: Rect = { x: i.x, y: i.y + 2, w: i.w, h: Math.max(0, i.h - 2) }
    const page = stickerPage(st, ov.tab)
    if (page.length === 0) {
      const text = ov.tab === 0 ? '還沒有最近用過的貼圖。按 Tab 看你擁有的貼圖組。' : '載入中…'
      g.put(grid.x + Math.max(0, Math.floor((grid.w - width(text)) / 2)), grid.y + 2, text, t.dim)
    }
    const perRow = Math.max(1, Math.floor(grid.w / cw))
    const rows = Math.max(1, Math.floor(grid.h / ch))
    const firstRow = Math.max(0, Math.floor(ov.pick / perRow) + 1 - rows)
    const ask: string[] = []
    page.slice(firstRow * perRow, firstRow * perRow + perRow * rows).forEach((s, k) => {
      const idx = firstRow * perRow + k
      const cell: Rect = { x: grid.x + (k % perRow) * cw, y: grid.y + Math.floor(k / perRow) * ch, w: cw, h: ch }
      if (idx === ov.pick) g.frame(cell, accent)
      const img: Rect = { x: cell.x + 1, y: cell.y + (idx === ov.pick ? 1 : 0), w: cw - 2, h: ch - 2 }
      const key = props.stickerKeys[s.id]
      if (key === undefined) {
        if (!st.askedStickers[s.id]) ask.push(s.id)
        g.put(img.x, img.y, '…', t.dim)
      } else if (key === '' || !props.images) g.put(img.x, img.y, '[貼圖]', t.dim)
      else {
        const d = media(key)
        if (d && d[0] > 0) {
          const [w, h] = fitCells(d, img.w, img.h)
          slots.push({ k: key, x: img.x + Math.floor((img.w - w) / 2), y: img.y, w, h, a: '[貼圖]' })
        } else g.put(img.x, img.y, d === 0 ? '[貼圖]' : '…', t.dim)
      }
    })
    if (ask.length && props.images) {
      for (const id of ask) st.askedStickers[id] = true
      op(st, 'stickerImages', { ids: ask })
    }
  }

  if (ov.t === 'theme') {
    const names = props.themes.names
    const h = Math.max(5, Math.min(names.length + 2, g.h - 2))
    const area = centered(full, 44, h)
    clear(area)
    g.frame(area, accent, [[' 主題 ', bold]], [[' ↑↓ 預覽   Enter 套用   q 還原 ']])
    const i = inner(area)
    const start = Math.max(0, ov.pick + 1 - i.h)
    names.slice(start, start + i.h).forEach((n, k) => {
      const picked = start + k === ov.pick
      pickRow(i, i.y + k, picked)
      const nt = n === 'Claude Code' ? '  跟著 Claude Code' : n === 'Omarchy' ? '  跟著系統主題' : n === '終端機' ? '  用終端機的配色' : ''
      g.spans(i.x, i.y + k, [[picked ? '▌ ' : '  ', accent], [n, picked ? { fg: t.accent, b: true } : base], [nt, t.dim]])
    })
  }

  if (ov.t === 'cat') {
    const choices = catChoices(st, ov)
    const area = centered(full, 48, Math.max(6, Math.min(16, choices.length + 4)))
    clear(area)
    g.frame(area, accent, [[` ${fit(ov.name, 24)} 的分類 `, bold]], [[' 打字篩選或新增   Enter 確定   ← 取消 ']])
    const i = inner(area)
    const now = catOf(st, ov.mid)
    g.spans(i.x, i.y, [['› ', accent], [ov.q, base], [' ', { r: true }]])
    if (choices.length === 0) g.put(i.x, i.y + 1, '  打一個名字來建立第一個分類', t.dim)
    choices.slice(0, i.h - 1).forEach((c, k) => {
      const picked = k === ov.pick
      pickRow(i, i.y + 1 + k, picked)
      g.spans(i.x, i.y + 1 + k, [[picked ? '▌ ' : '  ', accent], [catLabel(c), picked ? { fg: t.accent, b: true } : base], [c.kind === 'existing' && c.name === now ? '  ✓' : '', t.dim]])
    })
  }

  if (ov.t === 'path') {
    const area = centered(full, 72, 14)
    clear(area)
    g.frame(area, accent, [[' 附加檔案 ', bold]], [[' Tab 補完   Enter 附加   ← 取消 ']])
    const i = inner(area)
    const room = i.w - 3
    let shown = ''
    let used = 0
    for (const c of graphemes(ov.text).reverse()) {
      if (used + gw(c) > room) break
      shown = c + shown
      used += gw(c)
    }
    g.spans(i.x, i.y, [['› ', accent], [shown, base], [' ', { r: true }]])
    ov.matches.slice(0, i.h - 1).forEach((m, k) => g.put(i.x, i.y + 1 + k, `  ${fit(m, room)}`, t.dim))
  }

  if (ov.t === 'help') {
    const groups = HELP
    const COL_W = 58
    const lines = (grp: (typeof HELP)[number]): Span[][] => [
      [[` ${grp[0]}`, { fg: t.accent, b: true }]],
      ...grp[1].map(([k, what]) => [[`   ${k}${' '.repeat(Math.max(0, 12 - width(k)))}`, { ...base, b: true }], [what, base]] as Span[]),
    ]
    const total = groups.reduce((n, grp) => n + grp[1].length + 1, 0) + groups.length - 1
    const two = total + 2 > g.h && g.w >= COL_W * 2 + 3
    const colsOut: Span[][][] = [[]]
    const half = Math.ceil(total / 2)
    for (const grp of groups) {
      if (two && colsOut.length === 1 && colsOut[0]!.length >= half) colsOut.push([])
      const last = colsOut[colsOut.length - 1]!
      if (last.length) last.push([])
      last.push(...lines(grp))
    }
    const height = Math.max(...colsOut.map(c => c.length))
    const area = centered(full, COL_W * colsOut.length + 2, height + 2)
    const max = Math.max(0, height - (area.h - 2))
    st.helpMax = max
    const scroll = Math.min(ov.scroll, max)
    clear(area)
    g.frame(area, accent, [[' 按鍵 ', bold]], [[max > 0 ? ' j/k 捲動　q 關閉 ' : ' q 關閉 ']], scroll < max ? [[' ↓ 下面還有 ', accent]] : [])
    const i = inner(area)
    colsOut.forEach((col, ci) => {
      const x = i.x + ci * COL_W
      col.slice(scroll, scroll + i.h).forEach((line, k) => g.spans(x, i.y + k, line, Math.min(COL_W, i.x + i.w - x)))
    })
  }
}

function snippet(text: string, term: string, max: number, accent: string, base: Sty): Span[] {
  const lower = text.toLowerCase()
  const at = term && lower.length === text.length ? lower.indexOf(term) : -1
  if (at < 0) return [[fit(text, max), base]]
  const lead = Array.from(text.slice(0, at)).slice(-8).join('')
  const prefix = lead.length < at ? `…${lead}` : lead
  const hit = text.slice(at, at + term.length)
  const rest = fit(text.slice(at + term.length), max - width(prefix) - width(hit))
  return [[prefix, base], [hit, { fg: accent, b: true, u: true }], [rest, base]]
}

const HELP: [string, [string, string][]][] = [
  ['開始', [
    ['點一下面板', '鍵盤才會送進這裡（Claude Code 的規矩）'],
    ['Esc', '退一層：關浮層 → 取消選取 → 回清單；退到底關掉面板'],
    ['點標題的 ‹', '回清單'],
    ['←', '跟 Esc 一樣（輸入框空的時候；浮層裡也是）'],
    ['/enil', '打開這個面板；/enil close 關掉'],
  ]],
  ['VIP', [
    ['Ctrl-P', '把這個聊天室設為 VIP／取消（跟 TUI 共用名單）'],
    ['', 'VIP 置頂；狀態列顯示他們的未讀'],
  ]],
  ['清單', [
    ['↑ ↓  j k', '選聊天室（右邊直接預覽，不標已讀）'],
    ['Enter', '開啟聊天室'],
    ['/', '搜尋全部聊天室（也找得到還沒聊過的好友）'],
    ['Ctrl-S', '搜尋訊息內容（daemon 的存檔，比兩週更早的也找得到）'],
    ['r', '重整清單'],
    ['c', '幫選中的聊天室選分類（聊天室裡用 Ctrl-T）'],
    ['n', '打開下一個有未讀的聊天室（任何時候都可以按 Ctrl-N）'],
    ['空白鍵', '收合／展開游標所在的分區'],
    ['q', '關閉面板'],
  ]],
  ['對話', [
    ['Enter', '送出（輸入框有字時）'],
    ['← →  ^← ^→', '輸入框：移一個字／跳一個詞'],
    ['Home End', '輸入框：開頭／結尾（也可 Ctrl-A、Ctrl-E）'],
    ['^W ^U ^K', '刪前一個詞／刪到開頭／刪到結尾'],
    ['PgUp PgDn', '捲動訊息'],
    ['g', '載入更舊的訊息（輸入框空的時候）'],
    ['/  ?', '搜尋聊天室／這個說明（輸入框空的時候）'],
  ]],
  ['訊息', [
    ['Tab ⇧Tab', '選一則訊息，選中後：'],
    ['  r', '表情回應（1–6 選，0 取消回應）'],
    ['  d', '收回自己的訊息（按兩次）'],
    ['  f', '轉傳到別的聊天室'],
    ['  s', '選中的是貼圖：送一張一樣的'],
    ['  Enter', '開附件或連結（標 ↗ 的）；圖片在面板裡看，語音再按一次停'],
    ['@', '群組裡打 @ 挑人提及'],
  ]],
  ['附件', [
    ['Ctrl-V', '貼上：剪貼簿的圖片或複製的檔案變附件'],
    ['Ctrl-F', '附加檔案（輸入路徑，Tab 補完）'],
    ['Ctrl-G', '貼圖（最近用過的、你擁有的貼圖組）'],
    ['拖檔案進來', '附加那個檔案'],
  ]],
  ['任何時候', [
    ['Ctrl-B', '清單：展開 → 只有名稱 → 隱藏'],
    ['Ctrl-Y', '換主題（Claude Code、Omarchy、終端機、內建、自訂）'],
    ['? 或 F1', '這個說明（聊天時 ? 是字，用 F1）'],
  ]],
  ['滑鼠', [
    ['點聊天室', '開啟'],
    ['點分區標題', '收合／展開'],
    ['點 ↗ 訊息', '開啟附件或連結'],
  ]],
]

// ------------------------------------------------------------------ 交出去

function emit(g: Grid, Box: (p: never) => RenderElement, Text: (p: never) => RenderElement): RenderElement {
  const B = Box as unknown as (p: Record<string, unknown>) => RenderElement
  const T = Text as unknown as (p: Record<string, unknown>) => RenderElement
  const rows: RenderElement[] = []
  for (let y = 0; y < g.h; y++) {
    const parts: RenderElement[] = []
    let run = ''
    let key = ''
    let sty: Sty = {}
    const flush = () => {
      if (!run) return
      const p: Record<string, unknown> = { children: run }
      if (sty.fg) p.color = sty.fg
      if (sty.bg) p.backgroundColor = sty.bg
      if (sty.b) p.bold = true
      if (sty.d) p.dimColor = true
      if (sty.i) p.italic = true
      if (sty.u) p.underline = true
      if (sty.r) p.inverse = true
      parts.push(T(p))
      run = ''
    }
    for (let x = 0; x < g.w; x++) {
      const ch = g.g[y]![x]!
      if (ch === '') continue
      const s = g.s[y]![x]!
      const k = `${s.fg ?? ''}|${s.bg ?? ''}|${s.b ? 1 : 0}${s.d ? 1 : 0}${s.i ? 1 : 0}${s.u ? 1 : 0}${s.r ? 1 : 0}`
      if (k !== key) {
        flush()
        key = k
        sty = s
      }
      run += ch
    }
    flush()
    rows.push(T({ wrap: 'truncate-end', children: parts }))
  }
  return B({ flexDirection: 'column', width: g.w, height: g.h, children: rows })
}

// ------------------------------------------------------------------ 進入點

export default function App(props: AppProps, surface: ClientSurface<S>): RenderElement {
  let st = surface.state
  const fresh = !st
  if (!st) {
    st = initial(props)
    const get = () => surface.state ?? st!
    const after = (s: S) => {
      flushPost(s, surface)
      surface.setState({ ...s })
    }
    surface.onKey(ev => {
      const s = get()
      key(s, ev)
      after(s)
    })
    surface.onPointer(ev => {
      if (ev.type !== 'down') return
      const s = get()
      pointer(s, ev)
      after(s)
    })
    surface.every(150, () => {
      const s = get()
      if (tick(s)) after(s)
    })
  }
  st.props = props
  absorb(st)

  const cols = surface.columns || 100
  const rows = surface.rows || 30
  const { grid, slots, want } = draw(st, cols, rows)
  st.slots = slots
  st.want = want
  // 第一次畫時 surface 還沒量好大小，先不送位置。
  if (!fresh || surface.columns) flushPost(st, surface)
  const { Box, Text } = surface.elements
  return emit(grid, Box as never, Text as never)
}

/** props 裡 hooks 送來的回應、Esc、確認收到的事。 */
function absorb(st: S) {
  const p = st.props
  st.outbox = st.outbox.filter(o => o.seq > p.ack)
  for (const r of p.replies) {
    if (r.seq <= st.lastReply) continue
    st.lastReply = r.seq
    if (r.kind === 'attach') {
      st.attach = { path: r.path, name: r.name, size: r.size }
      if (st.ov?.t === 'path') st.ov = null
    } else if (r.kind === 'text') {
      if (st.open && !st.ov) insert(st, r.text)
    } else if (r.kind === 'complete' && st.ov?.t === 'path') {
      st.ov.text = r.text
      st.ov.matches = r.matches
    }
  }
  if (p.esc > st.lastEsc) {
    st.lastEsc = p.esc
    escape(st)
  }
  // 「最近」是空的、擁有的貼圖組剛載入：直接跳到第一組。
  if (st.ov?.t === 'stickers' && st.ov.tab === 0 && p.prefs.stickers.length === 0 && p.packs.length > 0) {
    st.ov.tab = 1
    st.ov.pick = 0
  }
  // 看圖時圖片載入失敗：關掉空白的看圖畫面，錯誤顯示在狀態列（跟 TUI 一樣）。
  if (st.ov?.t === 'viewer' && p.viewer.id === st.ov.id && p.viewer.error) {
    note(st, p.viewer.error)
    st.ov = null
  }
}

function flushPost(st: S, surface: ClientSurface<S>) {
  const ui = { open: st.open, scrolled: st.scroll > 0, cursor: !!st.cursor, escapable: escapable(st) }
  const post: Post = { ops: st.outbox, want: st.want, slots: st.slots, ui }
  const sig = JSON.stringify(post)
  if (sig === st.sig) return
  st.sig = sig
  st.lastPost = Date.now()
  surface.post(post as never)
}
