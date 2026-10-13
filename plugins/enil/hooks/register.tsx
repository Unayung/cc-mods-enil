// enil：在 Claude Code 裡用 LINE。enil TUI 的移植，畫面在 app.tsx（一個 Client），
// 這裡是它的後台：跟 enil daemon 講話、保存狀態、推送、通知、狀態列。
//
// daemon 可以在本機或別台（ssh）。mod 的環境沒有 socket，所以每個請求起一個小行程
// （bridge.ts 的 node -e），推送用一個常駐的同款行程。登入、E2EE、輪詢全在 daemon。

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, ProcessRunResult, Register } from 'claude-code'

import type {
  AppProps,
  Chat,
  Conn,
  Draft,
  MediaDims,
  Members,
  Msg,
  MsgHit,
  MsgSearch,
  Op,
  Pack,
  Palette,
  Peek,
  Post,
  Prefs,
  Reply,
  Search,
  Slot,
  Status,
  Sticker,
  Themes,
  View,
  Viewer,
} from '../types'
import { BRIDGE } from './bridge'
import { mentionSpans, parseChats, parseMsg, parseMsgs } from './model'
import { builtins, CLAUDE, claudeCode, OMARCHY, parseOmarchy, parseOmarchyBundle, parseSlk, TERMINAL, terminal, themeKey } from './themes'

type $ = EngineInterface

const PANE = 'enil'

const conn = atom({ plugin: 'enil', key: 'conn' } as const, {
  online: false,
  checked: false,
  loggedIn: false,
  me: '',
  login: { status: '' },
  where: '',
} as Conn)
const chats = atom({ plugin: 'enil', key: 'chats' } as const, [] as Chat[])
const view = atom({ plugin: 'enil', key: 'view' } as const, { mid: '', name: '', msgs: [], busy: false, exhausted: false } as View)
const peek = atom({ plugin: 'enil', key: 'peek' } as const, { mid: '', msgs: [], loading: false } as Peek)
const status = atom({ plugin: 'enil', key: 'status' } as const, { text: '', at: 0, warn: false } as Status)
const prefs = atom({ plugin: 'enil', key: 'prefs' } as const, { vip: [], cats: [], collapsed: [], stickers: [] } as Prefs)
const search = atom({ plugin: 'enil', key: 'search' } as const, { q: '', hits: [], loading: false } as Search)
const msgSearch = atom({ plugin: 'enil', key: 'msgSearch' } as const, {
  q: '',
  hits: [],
  total: 0,
  archived: 0,
  loading: false,
} as MsgSearch)
const members = atom({ plugin: 'enil', key: 'members' } as const, { mid: '', list: [] } as Members)
const packs = atom({ plugin: 'enil', key: 'packs' } as const, [] as Pack[])
const media = atom({ plugin: 'enil', key: 'media' } as const, {} as MediaDims)
const slots = atom({ plugin: 'enil', key: 'slots' } as const, [] as Slot[])
const replies = atom({ plugin: 'enil', key: 'replies' } as const, [] as Reply[])
const viewer = atom({ plugin: 'enil', key: 'viewer' } as const, { id: '', key: '', error: '' } as Viewer)
const themes = atom({ plugin: 'enil', key: 'themes' } as const, {
  names: [CLAUDE],
  palettes: { [CLAUDE]: claudeCode },
  chosen: CLAUDE,
} as Themes)
const ack = atom({ plugin: 'enil', key: 'ack' } as const, 0)
const esc = atom({ plugin: 'enil', key: 'esc' } as const, 0)
const escapable = atom({ plugin: 'enil', key: 'escapable' } as const, false)
const playing = atom({ plugin: 'enil', key: 'playing' } as const, '')
const stickerKeys = atom({ plugin: 'enil', key: 'stickerKeys' } as const, {} as Record<string, string>)
const draft = atom({ plugin: 'enil', key: 'draft' } as const, { seq: 0, mid: '', name: '', text: '' } as Draft)

// ------------------------------------------------------------------ 這個 session 的工作狀態
// 都是可以重抓的東西：hot reload 會清掉，session.start 重新來過。

type Opts = { host: string; toast: string; toastSeconds: number; notify: string; box: string; images: boolean }

let opts: Opts = { host: '', toast: 'vip', toastSeconds: 6, notify: 'vip', box: 'statusline', images: true }
let stateDir = ''
let home = ''
let isMac = true
let pathEnv = ''
let lastSeq = 0
let paneOpen = false
let paneFocused = false
let ui = { open: '', scrolled: false, cursor: false, escapable: false }
let viewing: string | null | undefined
const peekCache = new Map<string, Msg[]>()
const png = new Map<string, string>()
const mediaPending = new Set<string>()
let allChats: Chat[] = []
let contacts: Chat[] = []
let archive: { chat: string; fromName: string; text: string; time: number }[] = []
let replySeq = 0
let reloadTimer: { cancel: () => void } | undefined
let stopPlayer: (() => void) | undefined
let lastChatsAt = 0

// ------------------------------------------------------------------ 跟 daemon 講話

const SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=6',
  '-o', 'ControlMaster=auto',
  '-o', 'ControlPath=/tmp/enil-mod-%C',
  '-o', 'ControlPersist=10m',
  // 睡眠醒來時舊的共用連線會卡住；20 秒內判死，下一個請求重開。
  '-o', 'ServerAliveInterval=10',
  '-o', 'ServerAliveCountMax=2',
]

/** 給遠端 shell 的單引號字串。 */
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

function bridgeArgv(mode: string, ...args: string[]): string[] {
  if (!opts.host) return ['node', '-e', BRIDGE, mode, ...args]
  const remote = ['node', '-e', shq(BRIDGE), shq(mode), ...args.map(shq)].join(' ')
  return ['ssh', ...SSH_OPTS, opts.host, remote]
}

async function run($: $, argv: string[], init: { stdin?: string; timeoutMs?: number } = {}): Promise<ProcessRunResult> {
  const go = () => $.process.run(argv, { env: { PATH: pathEnv }, timeoutMs: init.timeoutMs ?? 30000, ...(init.stdin !== undefined ? { stdin: init.stdin } : {}) })
  const res = await go()
  // ssh 自己失敗（255）：多半是睡眠後的共用連線死了。關掉它再試一次。
  if (opts.host && res.exitCode === 255) {
    await $.process.run(['ssh', ...SSH_OPTS, '-O', 'exit', opts.host], { env: { PATH: pathEnv }, timeoutMs: 5000 }).catch(() => undefined)
    return go()
  }
  return res
}

async function bridge($: $, mode: string, args: string[] = [], stdin?: string, timeoutMs?: number): Promise<string> {
  const res = await run($, bridgeArgv(mode, ...args), { stdin, timeoutMs })
  if (res.exitCode !== 0) throw new Error(res.stderr.trim().split('\n').pop() || `連不上 ${opts.host || 'daemon'}`)
  return res.stdout
}

async function rpc($: $, req: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
  const raw = await bridge($, 'req', [], JSON.stringify(req) + '\n', timeoutMs)
  let res: { ok?: boolean; data?: unknown; error?: string }
  try {
    res = JSON.parse(raw)
  } catch {
    throw new Error('daemon 回了看不懂的東西')
  }
  if (res.ok) return res.data
  throw new Error(res.error || '未知錯誤')
}

// ------------------------------------------------------------------ 小工具

async function say($: $, text: string, warn = true) {
  await update($, status, () => ({ text, at: Date.now(), warn }))
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function readRemote($: $, file: string): Promise<string> {
  return bridge($, 'read', [file]).catch(() => '')
}

async function writeRemote($: $, file: string, text: string) {
  await bridge($, 'write', [file], text)
}

function sectionSave(p: Prefs): Record<string, string> {
  return {
    vip: p.vip.slice().sort().join('\n') + '\n',
    categories: p.cats.map(([m, c]) => `${m}\t${c}\n`).join(''),
    collapsed: p.collapsed.slice().sort().map(c => `${c}\n`).join(''),
    stickers: p.stickers.map(s => `${s.id}\t${s.pkg}\t${s.ver}\n`).join(''),
  }
}

async function savePrefs($: $, which: (keyof ReturnType<typeof sectionSave>)[]) {
  const p = await read($, prefs)
  const files = sectionSave(p)
  for (const f of which) await writeRemote($, f, files[f]!).catch(e => say($, `存不了 ${f}：${errText(e)}`))
}

const RESERVED = ['★ VIP', '群組', '一對一', 'VIP']

function parsePrefs(vip: string, cats: string, collapsed: string, stickers: string): Prefs {
  const lines = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean)
  const seen = new Set<string>()
  return {
    vip: lines(vip),
    cats: cats
      .split('\n')
      .map(l => l.split('\t').map(x => x.trim()))
      .filter((p): p is [string, string] => p.length >= 2 && !!p[0] && !!p[1] && !RESERVED.includes(p[1]!))
      .filter(([m]) => !seen.has(m) && (seen.add(m), true))
      .map(([m, c]) => [m, c]),
    collapsed: lines(collapsed),
    stickers: lines(stickers)
      .map(l => l.split('\t'))
      .filter(f => f.length >= 3 && f.slice(0, 3).every(v => /^\d+$/.test(v)))
      .map(([id, pkg, ver]) => ({ id: id!, pkg: pkg!, ver: ver! })),
  }
}

const STICKERS_MAX = 48

// ------------------------------------------------------------------ 載入

async function loadState($: $, sendViewing = false) {
  try {
    const req: Record<string, unknown> = { cmd: 'state' }
    if (sendViewing) req.viewing = viewing ?? null
    const s = (await rpc($, req, 15000)) as {
      me?: { mid?: string } | null
      login?: Conn['login']
      chats?: unknown
    }
    const me = s.login?.status === 'ok' ? (s.me?.mid ?? '') : ''
    await update($, conn, c => ({ ...c, checked: true, loggedIn: me !== '', me: me || c.me, login: s.login ?? { status: '' } }))
    // 面板沒開時不打 LINE 拿清單：daemon 的快照（最近 50 個）就夠狀態列用。
    if (!paneOpen && Array.isArray(s.chats)) await update($, chats, () => parseChats(s.chats))
    await refreshStatusLine($)
  } catch (e) {
    await update($, conn, c => ({ ...c, checked: true, online: false }))
  }
}

async function loadChats($: $) {
  lastChatsAt = Date.now()
  try {
    const list = parseChats(await rpc($, { cmd: 'chats', limit: 60 }))
    // 開著的那個不算未讀（daemon 已標已讀，清單晚一拍）。
    const open = (await read($, view)).mid
    await update($, chats, () => list.map(c => (c.mid === open && ui.open === open ? { ...c, unread: 0 } : c)))
    await refreshStatusLine($)
  } catch (e) {
    await say($, errText(e))
  }
}

async function loadPrefs($: $) {
  const [vip, cats, collapsed, stickers] = await Promise.all(
    ['vip', 'categories', 'collapsed', 'stickers'].map(f => readRemote($, f)),
  )
  await update($, prefs, () => parsePrefs(vip!, cats!, collapsed!, stickers!))
}

async function loadThemes($: $) {
  const palettes: Record<string, Palette> = { [CLAUDE]: claudeCode, [TERMINAL]: terminal }
  const names = [CLAUDE, OMARCHY, TERMINAL]
  // Omarchy：daemon 那台的主題 —— 目前用的那個，加上每一個裝著的主題（官方的與自己裝的）。
  const script =
    'for d in ~/.local/share/omarchy/themes/* ~/.config/omarchy/themes/*; do ' +
    '[ -f "$d/colors.toml" ] && printf "@@@ %s\\n" "${d##*/}" && cat "$d/colors.toml" && echo; done; ' +
    'printf "@@@ current\\n"; cat ~/.local/state/omarchy/current/theme/colors.toml 2>/dev/null; true'
  const raw = await run($, opts.host ? ['ssh', ...SSH_OPTS, opts.host, script] : ['sh', '-c', script], { timeoutMs: 15000 })
    .then(r => (r.exitCode === 0 ? r.stdout : ''))
    .catch(() => '')
  const bundle = parseOmarchyBundle(raw)
  palettes[OMARCHY] = parseOmarchy(bundle.current)
  // daemon 那台的 omarchy 主題用原本的名字；內建的同一個主題（Tokyo Night、Catppuccin Mocha…）
  // 就不再列，以 omarchy 那份為準。兩邊合起來照字母排。
  const renamed: Record<string, string> = {}
  const omarchyKeys = new Map(bundle.themes.map(([n]) => [themeKey(n), n]))
  const listed: [string, Palette][] = [...bundle.themes]
  for (const [name, palette] of Object.entries(builtins())) {
    const same = omarchyKeys.get(themeKey(name))
    if (same) renamed[name] = same
    else listed.push([name, palette])
  }
  for (const [raw, palette] of listed.sort((x, y) => x[0].localeCompare(y[0]))) {
    // 有個 omarchy 主題就叫「omarchy」：跟上面「目前的 Omarchy 主題」那項撞名，改個名字留著。
    const name = raw === OMARCHY || raw === CLAUDE || raw === TERMINAL ? `${raw} 主題` : raw
    if (palettes[name]) continue
    palettes[name] = palette
    names.push(name)
  }
  for (const dir of [`${home}/.config/enil/themes`, `${home}/.config/slk/themes`]) {
    const files = await $.fs.list(dir).catch(() => [])
    for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!f.name.endsWith('.toml')) continue
      const parsed = parseSlk(await $.fs.read(`${dir}/${f.name}`).catch(() => ''))
      if (parsed && !palettes[parsed[0]]) {
        palettes[parsed[0]] = parsed[1]
        names.push(parsed[0])
      }
    }
  }
  // 存著的是舊名字（0.3.0 的「Omarchy · 名稱」、或被合併掉的內建主題）就換成現在對應的那個。
  const stored = await $.store.get('theme')
  const saved = typeof stored === 'string' ? (renamed[stored] ?? stored.replace(/^Omarchy · /, '')) : ''
  const chosen = palettes[saved] ? saved : CLAUDE
  await update($, themes, () => ({ names, palettes, chosen }))
}

async function refreshStatusLine($: $) {
  if (opts.box !== 'statusline') return
  const c = await read($, conn)
  if (!c.loggedIn) return $.ui.status(c.checked && c.login.status && c.login.status !== 'ok' ? 'LINE 未登入' : undefined)
  const list = await read($, chats)
  const vip = new Set((await read($, prefs)).vip)
  const total = list.reduce((n, x) => n + Math.max(0, x.unread), 0)
  const waiting = list.filter(x => x.unread > 0 && vip.has(x.mid))
  if (total === 0) return $.ui.status(undefined)
  const vipText = waiting.length === 0 ? '' : waiting.length === 1 ? ` · ★ ${waiting[0]!.name} ${waiting[0]!.unread}` : ` · ★ ${waiting[0]!.name} 等 ${waiting.length} 個`
  $.ui.status(`LINE ${total}${vipText}`)
}

// ------------------------------------------------------------------ 聊天室

async function openChat($: $, mid: string, name: string) {
  viewing = paneFocused ? mid : null
  ui.open = mid
  await update($, view, () => ({ mid, name, msgs: [], busy: true, exhausted: false }))
  await update($, chats, list => list.map(c => (c.mid === mid ? { ...c, unread: 0 } : c)))
  void loadState($, true)
  await reloadOpen($, true)
  await refreshStatusLine($)
}

async function reloadOpen($: $, first = false) {
  const v = await read($, view)
  if (!v.mid) return
  const me = (await read($, conn)).me
  try {
    const msgs = parseMsgs(await rpc($, { cmd: 'history', chat: v.mid, count: 40, markRead: true }), me)
    await update($, view, cur => (cur.mid === v.mid ? { ...cur, msgs, busy: false } : cur))
    peekCache.delete(v.mid)
    await collectStickers($, msgs)
    if (first) await say($, '', false)
  } catch (e) {
    await update($, view, cur => (cur.mid === v.mid ? { ...cur, busy: false } : cur))
    await say($, errText(e))
  }
}

async function loadOlder($: $, mid: string) {
  const v = await read($, view)
  if (v.mid !== mid || v.busy || v.msgs.length === 0) return
  await update($, view, cur => ({ ...cur, busy: true }))
  const me = (await read($, conn)).me
  try {
    const got = parseMsgs(await rpc($, { cmd: 'history', chat: mid, count: 40, before: v.msgs[0]!.id }), me)
    await update($, view, cur => {
      if (cur.mid !== mid) return cur
      const known = new Set(cur.msgs.map(m => m.id))
      const fresh = got.filter(m => !known.has(m.id))
      return { ...cur, busy: false, exhausted: fresh.length === 0, msgs: [...fresh, ...cur.msgs] }
    })
    if ((await read($, view)).exhausted) await say($, '沒有更舊的了')
  } catch (e) {
    await update($, view, cur => ({ ...cur, busy: false }))
    await say($, errText(e))
  }
}

async function peekChat($: $, mid: string) {
  const cached = peekCache.get(mid)
  if (cached) return update($, peek, () => ({ mid, msgs: cached, loading: false }))
  await update($, peek, () => ({ mid, msgs: [], loading: true }))
  const me = (await read($, conn)).me
  try {
    const msgs = parseMsgs(await rpc($, { cmd: 'history', chat: mid, count: 30 }), me)
    peekCache.set(mid, msgs)
    await update($, peek, cur => (cur.mid === mid ? { mid, msgs, loading: false } : cur))
  } catch (e) {
    await update($, peek, cur => (cur.mid === mid ? { ...cur, loading: false } : cur))
    await say($, errText(e))
  }
}

async function collectStickers($: $, msgs: Msg[]) {
  const p = await read($, prefs)
  const have = new Set(p.stickers.map(s => s.id))
  const seen = msgs.map(m => m.sticker).filter((s): s is Sticker => !!s && !have.has(s.id) && (have.add(s.id), true))
  if (seen.length === 0) return
  await update($, prefs, cur => ({ ...cur, stickers: [...cur.stickers, ...seen].slice(0, STICKERS_MAX) }))
  await savePrefs($, ['stickers'])
}

// ------------------------------------------------------------------ 推送

async function onEvent($: $, event: string, data: Record<string, unknown>) {
  if (event === 'message') return onIncoming($, data)
  const chat = typeof data.chat === 'string' ? data.chat : ''
  peekCache.delete(chat)
  const v = await read($, view)
  const isOpen = v.mid === chat && ui.open === chat
  if ((await read($, peek)).mid === chat && !isOpen) void peekChat($, chat)
  if (event === 'chat-read') {
    await update($, chats, list => list.map(c => (c.mid === chat ? { ...c, unread: 0 } : c)))
    await refreshStatusLine($)
  } else if (event === 'unsend') {
    // 收回：馬上換掉，不等重讀 —— 收回常常是「送錯了」，越快消失越好。
    const id = String(data.messageId ?? '')
    await update($, view, cur => ({
      ...cur,
      msgs: cur.msgs.map(m =>
        m.id === id ? { ...m, text: '[已收回]', kind: 'UNSENT', media: undefined, hasMedia: false, link: undefined, reactions: [] } : m,
      ),
    }))
  } else if (isOpen) {
    // 已讀、表情、編輯：過一下重讀，一次收齊（大群組不要每有人讀一次就打一次 LINE）。
    if (!reloadTimer) {
      reloadTimer = $.clock.after(1500, () => {
        reloadTimer = undefined
        if (!ui.scrolled && !ui.cursor) void reloadOpen($)
      })
    }
  }
}

async function onIncoming($: $, data: Record<string, unknown>) {
  const chat = typeof data.chat === 'string' ? data.chat : ''
  const me = (await read($, conn)).me
  const msg = parseMsg(data, me)
  const v = await read($, view)
  const isOpen = v.mid === chat && ui.open === chat && paneOpen
  let name = chat
  const list = await read($, chats)
  const at = list.findIndex(c => c.mid === chat)
  if (at >= 0) {
    const c = { ...list[at]! }
    c.lastText = msg.text.replaceAll('\n', ' ') || (msg.kind === 'STICKER' ? '[貼圖]' : msg.kind === 'IMAGE' ? '[圖片]' : '')
    c.lastFrom = msg.fromName
    c.lastTime = msg.time
    if (!msg.mine && !isOpen) c.unread += 1
    name = c.name
    await update($, chats, cur => [c, ...cur.filter(x => x.mid !== chat)])
  } else if (paneOpen) {
    void loadChats($)
  }
  peekCache.delete(chat)
  if ((await read($, peek)).mid === chat && !isOpen) void peekChat($, chat)
  if (isOpen && !ui.scrolled) {
    // 重讀而不是直接接上：推送的訊息沒有縮圖路徑，重讀才有，也順便標已讀。
    void reloadOpen($)
  } else if (v.mid === chat && !v.msgs.some(m => m.id === msg.id)) {
    await update($, view, cur => (cur.mid === chat ? { ...cur, msgs: [...cur.msgs, msg] } : cur))
  }
  await refreshStatusLine($)
  if (!msg.mine && !(isOpen && paneFocused)) await alert($, chat, name, msg)
}

async function alert($: $, chat: string, name: string, msg: Msg) {
  const vip = (await read($, prefs)).vip.includes(chat)
  const who = !msg.fromName || msg.fromName === name ? name : `${name}｜${msg.fromName}`
  const body = (msg.text || (msg.kind === 'STICKER' ? '[貼圖]' : msg.kind === 'IMAGE' ? '[圖片]' : `[${msg.kind}]`)).replaceAll('\n', ' ')
  const short = body.length > 80 ? body.slice(0, 79) + '…' : body
  if (opts.toast === 'all' || (opts.toast === 'vip' && vip)) {
    $.ui.toast(`${vip ? '★ ' : ''}${who}：${short}`, { timeoutMs: opts.toastSeconds * 1000 })
  }
  if (opts.notify === 'all' || (opts.notify === 'vip' && vip)) {
    // 好幾個 session 都開著時只發一次：共用的 store 記最近發過的訊息 id。
    const sent = ((await $.store.get('notified')) as string[] | undefined) ?? []
    if (sent.includes(msg.id)) return
    await $.store.set('notified', [msg.id, ...sent].slice(0, 50))
    await $.ui.notify(short, { title: `${vip ? '★ ' : ''}${who}` }).catch(() => undefined)
  }
}

function subscribe($: $) {
  let alive = true
  const loop = async () => {
    while (alive) {
      const stream = $.process.spawn({ argv: bridgeArgv('sub'), env: { PATH: pathEnv }, input: '' })
      let buf = ''
      try {
        for await (const chunk of stream) {
          if (chunk.stream !== 'stdout') continue
          buf += chunk.text
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            let v: { ok?: boolean; event?: string; data?: unknown }
            try {
              v = JSON.parse(line)
            } catch {
              continue
            }
            if (v.ok && !v.event) {
              await update($, conn, c => ({ ...c, online: true }))
              // 重新接上的可能是剛重啟、還沒登入的 daemon —— 馬上問一次，順便補上斷線期間的。
              void loadState($)
              if (paneOpen) void loadChats($)
              continue
            }
            if (v.event) await onEvent($, v.event, (v.data ?? {}) as Record<string, unknown>).catch(() => undefined)
          }
        }
      } catch {
        // 起不來（ssh 連不上）：當成斷線，等一下再試。
      }
      await update($, conn, c => ({ ...c, online: false }))
      if (!alive) return
      await new Promise<void>(resolve => $.clock.after(5000, resolve))
    }
  }
  void loop()
  return () => {
    alive = false
  }
}

// ------------------------------------------------------------------ 圖片

/** PNG 的 IHDR：寬高在第 16–24 個位元組。 */
function pngSize(b64: string): [number, number] | 0 {
  const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  let acc = 0
  let bits = 0
  for (const ch of b64.slice(0, 44)) {
    const v = ABC.indexOf(ch)
    if (v < 0) break
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 255)
    }
  }
  if (bytes.length < 24) return 0
  const u32 = (i: number) => ((bytes[i]! << 24) >>> 0) + (bytes[i + 1]! << 16) + (bytes[i + 2]! << 8) + bytes[i + 3]!
  const w = u32(16)
  const h = u32(20)
  return w > 0 && h > 0 ? [w, h] : 0
}

async function want($: $, keys: string[]) {
  const fresh = [...new Set(keys)].filter(k => !png.has(k) && !mediaPending.has(k)).slice(0, 60)
  if (fresh.length === 0) return
  for (const k of fresh) mediaPending.add(k)
  const size = (k: string) => Number(k.slice(k.lastIndexOf('@') + 1)) || 160
  // 一次 ssh 的輸出上限 4 MB：小圖（大頭貼）一批多張，照片幾張一批，看圖用的大圖一張一批。
  const batches: string[][] = []
  for (const group of [fresh.filter(k => size(k) <= 100), fresh.filter(k => size(k) > 100 && size(k) <= 320), fresh.filter(k => size(k) > 320)]) {
    const per = group[0] && size(group[0]) <= 100 ? 20 : group[0] && size(group[0]) <= 320 ? 6 : 1
    for (let i = 0; i < group.length; i += per) batches.push(group.slice(i, i + per))
  }
  await Promise.all(
    batches.map(async batch => {
      let got: Record<string, string | null> = {}
      try {
        const pairs = batch.map(k => [k.slice(0, k.lastIndexOf('@')), size(k)])
        got = JSON.parse(await bridge($, 'png', [], JSON.stringify(pairs), 60000))
      } catch {
        // 整批失敗：都記成轉不出來，不要一直重要。
      }
      const dims: MediaDims = {}
      for (const k of batch) {
        mediaPending.delete(k)
        const b64 = got[k]
        if (b64) png.set(k, b64)
        dims[k] = b64 ? pngSize(b64) : 0
      }
      await update($, media, cur => ({ ...cur, ...dims }))
    }),
  )
}

// ------------------------------------------------------------------ 附件、下載、播放

const basename = (p: string) => p.split('/').pop() || 'file'

function localPath(raw: string): string {
  let p = raw.trim()
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(p.slice(7))
    } catch {
      p = p.slice(7)
    }
  }
  // 拖進終端機的路徑可能帶反斜線跳脫或引號。
  if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith('"') && p.endsWith('"'))) p = p.slice(1, -1)
  p = p.replace(/\\(.)/g, '$1')
  if (p.startsWith('~/')) p = `${home}/${p.slice(2)}`
  return p
}

async function fileInfo($: $, raw: string): Promise<{ path: string; size: number } | undefined> {
  const path = localPath(raw)
  if (!path.startsWith('/')) return undefined
  const st = await $.fs.stat(path).catch(() => undefined)
  return st && st.kind === 'file' ? { path, size: st.size } : undefined
}

type ReplyBody = Reply extends infer R ? (R extends Reply ? Omit<R, 'seq'> : never) : never

async function reply($: $, r: ReplyBody) {
  replySeq += 1
  const one = { ...r, seq: replySeq } as Reply
  await update($, replies, cur => [...cur, one].slice(-6))
}

/** 本機的檔案交給 daemon：daemon 在別台時先傳過去。回傳 daemon 那邊看得到的路徑。 */
async function upload($: $, local: string): Promise<string> {
  if (!opts.host) return local
  const res = await $.process.run(['sh', '-c', 'exec "$@" < "$0"', local, ...bridgeArgv('put', `${Date.now()}-${basename(local)}`)], {
    env: { PATH: pathEnv },
    timeoutMs: 120000,
  })
  if (res.exitCode !== 0) throw new Error(`傳不過去：${res.stderr.trim() || res.exitCode}`)
  return res.stdout.trim()
}

/** daemon 那邊的檔案拿到本機（快取目錄），回傳本機路徑。 */
async function fetchLocal($: $, remote: string, name: string): Promise<string> {
  if (!opts.host) return remote
  const dir = isMac ? `${home}/Library/Caches/enil-mod` : `${home}/.cache/enil-mod`
  const local = `${dir}/${name}`
  if (await $.fs.exists(local)) return local
  const res = await $.process.run(
    ['sh', '-c', 'mkdir -p "$(dirname "$0")" && "$@" > "$0.part" && mv "$0.part" "$0"', local, ...bridgeArgv('cat', remote)],
    { env: { PATH: pathEnv }, timeoutMs: 120000 },
  )
  if (res.exitCode !== 0) throw new Error('下載失敗')
  return local
}

async function systemOpen($: $, target: string) {
  const res = await $.process.run([isMac ? 'open' : 'xdg-open', target], { env: { PATH: pathEnv }, timeoutMs: 10000 }).catch(() => undefined)
  await say($, res?.exitCode === 0 ? `已開啟 ${target.length > 70 ? target.slice(0, 69) + '…' : target}` : `開不了 ${target}`, res?.exitCode !== 0)
}

async function download($: $, id: string): Promise<string> {
  const d = (await rpc($, { cmd: 'download', messageId: id, preview: false }, 120000)) as { path?: string }
  if (!d?.path) throw new Error('daemon 沒回路徑')
  return d.path
}

async function play($: $, id: string, remote: string) {
  stopPlayer?.()
  const local = await fetchLocal($, remote, `${id}-${basename(remote)}`)
  const argv = isMac ? ['afplay', local] : ['mpv', '--no-video', '--really-quiet', '--', local]
  const stream = $.process.spawn({ argv, env: { PATH: pathEnv } })
  let stopped = false
  stopPlayer = () => {
    stopped = true
    void stream.return?.(undefined as never)
  }
  await update($, playing, () => id)
  await say($, '▶ 播放中（再按一次停止）', false)
  void (async () => {
    try {
      for await (const _ of stream) void _
    } catch {
      if (!stopped) await systemOpen($, local)
    }
    if ((await read($, playing)) === id) await update($, playing, () => '')
  })()
}

async function openMsg($: $, id: string) {
  const m = [...(await read($, view)).msgs, ...(await read($, peek)).msgs].find(x => x.id === id)
  if (!m) return
  if (m.kind === 'AUDIO' && (await read($, playing)) === id) {
    stopPlayer?.()
    stopPlayer = undefined
    await update($, playing, () => '')
    return say($, '已停止', false)
  }
  if (m.kind === 'IMAGE' && m.hasMedia) return showImage($, id)
  if (m.hasMedia) {
    await say($, '下載中…', false)
    try {
      const remote = await download($, id)
      if (m.kind === 'AUDIO') return await play($, id, remote)
      await systemOpen($, await fetchLocal($, remote, `${id}-${basename(remote)}`))
    } catch (e) {
      await say($, errText(e))
    }
    return
  }
  if (m.link) await systemOpen($, m.link)
}

async function showImage($: $, id: string) {
  await update($, viewer, () => ({ id, key: '', error: '' }))
  try {
    const remote = await download($, id)
    const key = `${remote}@900`
    await want($, [key])
    if ((await read($, viewer)).id !== id) return
    const ok = (await read($, media))[key]
    await update($, viewer, cur => (cur.id === id ? { id, key: ok ? key : '', error: ok ? '' : '圖片轉不出來（daemon 那台要有 magick）' } : cur))
  } catch (e) {
    await update($, viewer, cur => (cur.id === id ? { ...cur, error: `看不了這張圖：${errText(e)}` } : cur))
  }
}

async function openOriginal($: $, id: string) {
  try {
    const remote = await download($, id)
    await systemOpen($, await fetchLocal($, remote, `${id}-${basename(remote)}`))
  } catch (e) {
    await say($, errText(e))
  }
}

// ------------------------------------------------------------------ 剪貼簿、路徑補完

async function clipboard($: $) {
  const env = { env: { PATH: pathEnv }, timeoutMs: 8000 }
  if (isMac) {
    const file = await $.process.run(['osascript', '-e', 'POSIX path of (the clipboard as «class furl»)'], env).catch(() => undefined)
    const fi = file?.exitCode === 0 ? await fileInfo($, file.stdout.trim()) : undefined
    if (fi) return reply($, { kind: 'attach', path: fi.path, name: basename(fi.path), size: fi.size })
    const out = `${home}/Library/Caches/enil-mod/paste-${Date.now()}.png`
    const img = await $.process
      .run(['sh', '-c', 'mkdir -p "$(dirname "$0")" && osascript -e "set f to open for access POSIX file \\"$0\\" with write permission" -e "write (the clipboard as «class PNGf») to f" -e "close access f"', out], env)
      .catch(() => undefined)
    const ii = img?.exitCode === 0 ? await fileInfo($, out) : undefined
    if (ii && ii.size > 0) return reply($, { kind: 'attach', path: out, name: '剪貼簿的圖片.png', size: ii.size })
    const text = await $.process.run(['pbpaste'], env).catch(() => undefined)
    if (text?.stdout) return pasteText($, text.stdout)
    return say($, '剪貼簿是空的')
  }
  const types = await $.process.run(['wl-paste', '--list-types'], env).catch(() => undefined)
  const has = (t: string) => (types?.stdout ?? '').split('\n').includes(t)
  if (has('text/uri-list')) {
    const list = await $.process.run(['wl-paste', '--type', 'text/uri-list'], env).catch(() => undefined)
    const uri = list?.stdout.split('\n').find(l => l.startsWith('file://'))
    const fi = uri ? await fileInfo($, uri) : undefined
    if (fi) return reply($, { kind: 'attach', path: fi.path, name: basename(fi.path), size: fi.size })
  }
  for (const [mime, ext] of [['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif']] as const) {
    if (!has(mime)) continue
    const out = `${home}/.cache/enil-mod/paste-${Date.now()}.${ext}`
    const r = await $.process.run(['sh', '-c', 'mkdir -p "$(dirname "$0")" && wl-paste --type "$1" > "$0"', out, mime], env).catch(() => undefined)
    const fi = r?.exitCode === 0 ? await fileInfo($, out) : undefined
    if (fi && fi.size > 0) return reply($, { kind: 'attach', path: out, name: `剪貼簿的圖片.${ext}`, size: fi.size })
  }
  const text = await $.process.run(['wl-paste', '--no-newline', '--type', 'text'], env).catch(() => undefined)
  if (text?.stdout) return pasteText($, text.stdout)
  return say($, '剪貼簿是空的（或讀不到，需要 wl-paste）')
}

/** 貼上文字。整段就是一個存在的檔案路徑（把檔案拖進終端機就是貼路徑）就當成附件。 */
async function pasteText($: $, text: string) {
  const oneLine = !text.trim().includes('\n')
  const fi = oneLine ? await fileInfo($, text) : undefined
  if (fi) return reply($, { kind: 'attach', path: fi.path, name: basename(fi.path), size: fi.size })
  return reply($, { kind: 'text', text: text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(/\n+$/, '') })
}

async function complete($: $, input: string) {
  const cut = input.lastIndexOf('/') + 1
  const base = input.slice(0, cut)
  const prefix = input.slice(cut)
  const dir = base ? localPath(base) : (await $.session.cwd())
  const entries = await $.fs.list(dir).catch(() => [])
  const names = entries
    .filter(e => e.name.startsWith(prefix) && (prefix.startsWith('.') || !e.name.startsWith('.')))
    .map(e => (e.kind === 'dir' ? e.name + '/' : e.name))
    .sort()
  let common = names[0] ?? ''
  for (const n of names.slice(1)) {
    let i = 0
    while (i < common.length && i < n.length && common[i] === n[i]) i++
    common = common.slice(0, i)
  }
  const text = common.length > prefix.length ? base + common : input
  await reply($, { kind: 'complete', text, matches: names.slice(0, 50) })
}

// ------------------------------------------------------------------ 搜尋

async function startSearch($: $) {
  await update($, search, () => ({ q: '', hits: [], loading: true }))
  const [all, people] = await Promise.all([
    rpc($, { cmd: 'chats', limit: 5000 }, 60000).then(parseChats).catch(() => [] as Chat[]),
    contacts.length ? Promise.resolve(contacts) : rpc($, { cmd: 'contacts' }).then(parseChats).catch(() => [] as Chat[]),
  ])
  allChats = all
  contacts = people
  await runSearch($, (await read($, search)).q)
}

async function runSearch($: $, q: string) {
  const ql = q.toLowerCase()
  const pool = allChats.length ? allChats : await read($, chats)
  const recent = await read($, chats)
  const hits = pool.filter(c => c.name.toLowerCase().includes(ql)).map(c => ({ mid: c.mid, name: c.name, unread: c.unread, isNew: false }))
  // 好友清單很長，沒打字時不列，免得把聊天室擠下去。
  if (ql) {
    const known = new Set([...pool, ...recent].map(c => c.mid))
    for (const c of contacts) {
      if (c.name.toLowerCase().includes(ql) && !known.has(c.mid)) hits.push({ mid: c.mid, name: c.name, unread: 0, isNew: true })
    }
  }
  await update($, search, () => ({ q, hits: hits.slice(0, 200), loading: false }))
}

async function startMsgSearch($: $) {
  await update($, msgSearch, () => ({ q: '', hits: [], total: 0, archived: archive.length, loading: true }))
  const raw = await readRemote($, 'archive.jsonl')
  const seen = new Set<string>()
  const out: typeof archive = []
  for (const line of raw.split('\n')) {
    let m: Record<string, unknown>
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    const id = String(m.id ?? '')
    if (seen.has(id)) continue
    seen.add(id)
    const text = [m.text, m.flexText, m.altText].find(t => typeof t === 'string' && t !== '') as string | undefined
    if (!text) continue
    out.push({ chat: String(m.chat ?? ''), fromName: String(m.fromName ?? ''), text: text.replaceAll('\n', ' '), time: Number(m.time) || 0 })
  }
  archive = out.sort((a, b) => b.time - a.time)
  if (allChats.length === 0) void rpc($, { cmd: 'chats', limit: 5000 }, 60000).then(v => (allChats = parseChats(v))).catch(() => undefined)
  await runMsgSearch($, (await read($, msgSearch)).q)
}

async function runMsgSearch($: $, q: string) {
  const terms = q.split(/\s+/).filter(Boolean).map(t => t.toLowerCase())
  const recent = await read($, chats)
  const nameOf = (mid: string) => recent.find(c => c.mid === mid)?.name ?? allChats.find(c => c.mid === mid)?.name
  const all = terms.length === 0 ? [] : archive.filter(h => terms.every(t => `${h.text} ${h.fromName}`.toLowerCase().includes(t)))
  const hits: MsgHit[] = all.slice(0, 80).map(h => ({ ...h, chatName: nameOf(h.chat) ?? h.fromName, text: h.text.slice(0, 400) }))
  await update($, msgSearch, () => ({ q, hits, total: all.length, archived: archive.length, loading: false }))
}

// ------------------------------------------------------------------ 畫面送來的事

async function doOp($: $, o: Op) {
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '')
  switch (o.op) {
    case 'open':
      return openChat($, str('mid'), str('name'))
    case 'leave':
      ui.open = ''
      viewing = null
      void loadState($, true)
      return update($, view, () => ({ mid: '', name: '', msgs: [], busy: false, exhausted: false }))
    case 'peek':
      return peekChat($, str('mid'))
    case 'older':
      return loadOlder($, str('mid'))
    case 'chats':
      return loadChats($)
    case 'send': {
      const mid = str('mid')
      const text = str('text')
      const attach = str('attach')
      await say($, '傳送中…', false)
      try {
        // 附件與文字分開送，附件先：LINE 沒有「圖片加說明」這種單一訊息。
        if (attach) await rpc($, { cmd: 'sendFile', chat: mid, path: await upload($, attach) }, 180000)
        if (text) await rpc($, { cmd: 'send', chat: mid, text, mentions: mentionSpans(text, (o.mentions ?? []) as [string, string][]) })
        await say($, '', false)
      } catch (e) {
        await say($, errText(e))
      }
      peekCache.delete(mid)
      return reloadOpen($)
    }
    case 'sticker': {
      const st = o.sticker as Sticker
      await update($, prefs, cur => ({ ...cur, stickers: [st, ...cur.stickers.filter(s => s.id !== st.id)].slice(0, STICKERS_MAX) }))
      void savePrefs($, ['stickers'])
      await say($, '送出貼圖…', false)
      try {
        await rpc($, { cmd: 'sendSticker', chat: str('mid'), sticker: st })
        await say($, '', false)
      } catch (e) {
        await say($, `貼圖送不出去：${errText(e)}`)
      }
      return reloadOpen($)
    }
    case 'react':
      await say($, '送出表情…', false)
      return rpc($, { cmd: 'react', messageId: str('id'), type: str('type') })
        .then(() => say($, '', false))
        .catch(e => say($, `表情送不出去：${errText(e)}`))
    case 'unsend':
      await say($, '收回中…', false)
      return rpc($, { cmd: 'unsend', messageId: str('id') })
        .then(() => say($, '', false))
        .catch(e => say($, `收回失敗：${errText(e)}`))
    case 'forward': {
      const item = o.item as { kind: string; text?: string; sticker?: Sticker; id?: string }
      const mid = str('mid')
      const name = str('name')
      await say($, `轉傳到 ${name}…`, false)
      try {
        if (item.kind === 'text') await rpc($, { cmd: 'send', chat: mid, text: item.text, mentions: [] })
        else if (item.kind === 'sticker') await rpc($, { cmd: 'sendSticker', chat: mid, sticker: item.sticker })
        else await rpc($, { cmd: 'sendFile', chat: mid, path: await download($, item.id ?? '') }, 180000)
        return say($, `已轉傳到 ${name}`, false)
      } catch (e) {
        return say($, `轉傳失敗：${errText(e)}`)
      }
    }
    case 'members': {
      const mid = str('mid')
      if ((await read($, members)).mid === mid) return
      try {
        const list = (await rpc($, { cmd: 'members', chat: mid })) as { mid: string; name: string }[]
        return update($, members, () => ({ mid, list: list.map(m => [m.mid, m.name] as [string, string]) }))
      } catch (e) {
        return say($, `成員載入失敗：${errText(e)}`)
      }
    }
    case 'search':
      return startSearch($)
    case 'searchQuery':
      return runSearch($, str('q'))
    case 'msgSearch':
      return startMsgSearch($)
    case 'msgQuery':
      return runMsgSearch($, str('q'))
    case 'packs':
      if ((await read($, packs)).length) return
      try {
        const v = (await rpc($, { cmd: 'stickerPacks' })) as { pkg: string; ver: string; name?: string; stickers?: string[] }[]
        const list = v
          .map(p => ({ name: p.name || p.pkg, stickers: (p.stickers ?? []).map(id => ({ id, pkg: p.pkg, ver: p.ver })) }))
          .filter(p => p.stickers.length > 0)
        return update($, packs, () => list)
      } catch (e) {
        return say($, `拿不到擁有的貼圖：${errText(e)}`)
      }
    case 'stickerImages': {
      // 貼圖選單的縮圖：跟 daemon 要圖檔路徑（它從 CDN 抓好快取），再轉成 PNG。
      const known = await read($, stickerKeys)
      const ids = ((o.ids ?? []) as string[]).filter(id => known[id] === undefined && !stickerAsked.has(id)).slice(0, 24)
      if (ids.length === 0) return
      for (const id of ids) stickerAsked.add(id)
      const found: Record<string, string> = {}
      await Promise.all(
        ids.map(async id => {
          const d = (await rpc($, { cmd: 'stickerImage', id }).catch(() => undefined)) as { path?: string } | undefined
          found[id] = d?.path ? `${d.path}@160` : ''
        }),
      )
      for (const id of ids) stickerAsked.delete(id)
      await want($, Object.values(found).filter(Boolean))
      return update($, stickerKeys, cur => ({ ...cur, ...found }))
    }
    case 'openMsg':
      return openMsg($, str('id'))
    case 'view':
      return showImage($, str('id'))
    case 'closeViewer':
      return update($, viewer, () => ({ id: '', key: '', error: '' }))
    case 'openOriginal':
      return openOriginal($, str('id'))
    case 'link':
      return systemOpen($, str('url'))
    case 'vip': {
      const mid = str('mid')
      const name = str('name')
      const was = (await read($, prefs)).vip.includes(mid)
      await update($, prefs, cur => ({ ...cur, vip: was ? cur.vip.filter(m => m !== mid) : [...cur.vip, mid] }))
      await say($, was ? `已取消 VIP：${name}` : `★ ${name} 設為 VIP`, false)
      await savePrefs($, ['vip'])
      return refreshStatusLine($)
    }
    case 'cat': {
      const mid = str('mid')
      const name = str('name')
      const cat = str('cat').trim()
      const ok = cat && !RESERVED.includes(cat)
      await update($, prefs, cur => {
        const has = cur.cats.some(([m]) => m === mid)
        // 原地改：分類的順序是「第一次出現」，換分類不該讓別的分類跳位置。
        const cats: [string, string][] = ok
          ? has
            ? cur.cats.map(([m, c]) => [m, m === mid ? cat : c] as [string, string])
            : [...cur.cats, [mid, cat]]
          : cur.cats.filter(([m]) => m !== mid)
        // 放進一個收合的分區：打開它，不然剛分好的聊天室就不見了。
        const isVip = cur.vip.includes(mid)
        const section = isVip ? '★ VIP' : ok ? cat : mid.startsWith('u') ? '一對一' : '群組'
        return { ...cur, cats, collapsed: cur.collapsed.filter(c => c !== section) }
      })
      const isVip = (await read($, prefs)).vip.includes(mid)
      await say($, ok ? (isVip ? `${name} 放進「${cat}」（是 VIP，仍顯示在 VIP 區）` : `${name} 放進「${cat}」`) : `${name} 不分類`, false)
      return savePrefs($, ['categories', 'collapsed'])
    }
    case 'collapse': {
      const section = str('section')
      await update($, prefs, cur => ({
        ...cur,
        collapsed: cur.collapsed.includes(section) ? cur.collapsed.filter(c => c !== section) : [...cur.collapsed, section],
      }))
      return savePrefs($, ['collapsed'])
    }
    case 'expand': {
      const section = str('section')
      if (!(await read($, prefs)).collapsed.includes(section)) return
      await update($, prefs, cur => ({ ...cur, collapsed: cur.collapsed.filter(c => c !== section) }))
      return savePrefs($, ['collapsed'])
    }
    case 'theme': {
      const name = str('name')
      await $.store.set('theme', name)
      await update($, themes, cur => ({ ...cur, chosen: name }))
      return say($, `主題：${name}`, false)
    }
    case 'complete':
      return complete($, str('text'))
    case 'attach': {
      const fi = await fileInfo($, str('path'))
      if (!fi) return say($, `找不到檔案：${str('path').trim().slice(0, 50)}`)
      await say($, '已附加，Enter 送出', false)
      return reply($, { kind: 'attach', path: fi.path, name: basename(fi.path), size: fi.size })
    }
    case 'paste':
      return clipboard($)
    case 'pasteText':
      return pasteText($, str('text'))
    case 'login':
      await rpc($, { cmd: 'login' }).catch(e => say($, errText(e)))
      return loadState($)
    case 'close':
      return $.ui.close({ id: PANE })
    case 'status':
      return say($, str('text'), o.warn !== false)
    case 'draftTaken': {
      // 放進輸入框了：清掉，面板重開時不要再放一次。
      const seq = Number(o.seq)
      return update($, draft, cur => (cur.seq === seq ? { ...cur, text: '' } : cur))
    }
  }
}

const stickerAsked = new Set<string>()


// ------------------------------------------------------------------ 註冊

export const register: Register = (on, options) => {
  const o = options as Record<string, unknown>
  opts = {
    host: String(o.host ?? '').trim(),
    toast: String(o.toast ?? 'vip'),
    toastSeconds: Math.max(1, Number(o.toastSeconds) || 6),
    notify: String(o.notify ?? 'vip'),
    box: String(o.box ?? 'statusline'),
    images: String(o.images ?? 'on') !== 'off',
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'enil',
      description: 'LINE (enil): open the chat pane',
      argumentHint: '[close]',
      immediate: true,
    })
    await $.tool.register({
      name: 'draft',
      description:
        'Put a LINE message into the enil pane for the user to review and send. Opens the chat in the LINE pane ' +
        'and fills its input box; it does NOT send. The user checks it and presses Enter in the pane. ' +
        '`to` is a chat name (person or group, as shown in LINE) or a chat mid. If several chats match, ' +
        'the result lists them; ask the user which one and call again with its mid.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Chat name or mid' },
          text: { type: 'string', description: 'The message text' },
        },
        required: ['to', 'text'],
      },
      isDeferred: false,
    })
    home = (await $.env.get('HOME')) ?? ''
    const base = (await $.env.get('PATH')) ?? '/usr/bin:/bin'
    // 從 app 啟動的 Claude Code 不一定有 Homebrew／mise 的 PATH。
    pathEnv = [base, '/opt/homebrew/bin', '/usr/local/bin', `${home}/.local/share/mise/shims`, `${home}/.local/bin`, '/usr/bin', '/bin'].join(':')
    isMac = home.startsWith('/Users/')
    // 重新載入後圖片快取是空的：讓畫面重新要。
    await update($, media, () => ({}))
    await update($, slots, () => [])
    await update($, stickerKeys, () => ({}))
    await update($, conn, c => ({ ...c, where: opts.host || '本機' }))
    void (async () => {
      try {
        const info = JSON.parse(await bridge($, 'info', [], undefined, 15000)) as { stateDir: string; home: string }
        stateDir = info.stateDir
        void stateDir
      } catch {
        // 連不上：推送迴圈會一直重試，畫面顯示離線。
      }
      await loadState($)
      await loadPrefs($)
      await loadThemes($)
      await refreshStatusLine($)
    })()
    subscribe($)
    // 保底：每 10 秒問一次登入狀態（順便回報正在看哪個聊天室）；面板開著時每分鐘對齊一次清單。
    $.clock.every(10000, () => {
      void (async () => {
        const want = paneOpen && paneFocused && ui.open ? ui.open : null
        const changed = want !== viewing
        viewing = want
        if (paneOpen || changed) await loadState($, true)
        else if (Date.now() % 60000 < 10000) await loadState($)
        if (paneOpen && Date.now() - lastChatsAt > 60000) await loadChats($)
      })()
    })
    return started
  })

  on('command.run', { command: 'enil' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'LINE pane closed.' }
    }
    const res = await $.ui.open({ id: PANE, title: 'LINE', focus: true, closeOnEscape: true, rows: 40, columns: 100 })
    paneOpen = true
    if (Date.now() - lastChatsAt > 30000) void loadChats($)
    return { text: res.isPlaced ? 'LINE pane opened. Click it to type into it.' : `LINE pane waits: ${res.reason}` }
  })

  // Claude 只擬稿：打開聊天室、把字放進輸入框，送不送由人在面板裡按 Enter 決定。
  on('tool.call', { tool: 'mcp__enil__draft' }, async ($, e) => {
    const args = e as unknown as { to?: unknown; text?: unknown }
    const to = String(args.to ?? '').trim()
    const text = String(args.text ?? '')
    if (!to || !text.trim()) return { result: 'Nothing drafted: both `to` and `text` are required.' }
    let pool = await read($, chats)
    const pick = (list: Chat[]) => {
      const byMid = list.filter(c => c.mid === to)
      if (byMid.length) return byMid
      const exact = list.filter(c => c.name === to)
      if (exact.length) return exact
      return list.filter(c => c.name.toLowerCase().includes(to.toLowerCase()))
    }
    let hits = pick(pool)
    if (hits.length === 0) {
      try {
        pool = parseChats(await rpc($, { cmd: 'chats', limit: 5000, query: to }, 60000))
        hits = pick(pool)
      } catch (err) {
        return { result: `Could not reach the enil daemon: ${errText(err)}` }
      }
    }
    if (hits.length === 0) return { result: `No LINE chat matches "${to}". Nothing drafted.` }
    if (hits.length > 1) {
      const list = hits.slice(0, 15).map(c => `- ${c.name} (${c.mid.startsWith('u') ? 'person' : 'group'}, mid ${c.mid})`).join('\n')
      return { result: `Several LINE chats match "${to}"; ask the user which one, then call again with its mid:\n${list}` }
    }
    const chat = hits[0]!
    await update($, draft, cur => ({ seq: cur.seq + 1, mid: chat.mid, name: chat.name, text }))
    const res = await $.ui.open({ id: PANE, title: 'LINE', focus: true, closeOnEscape: true, rows: 40, columns: 100 })
    paneOpen = true
    return {
      result:
        `Drafted in the LINE pane for ${chat.name} (not sent). The user reviews it there and presses Enter to send` +
        (res.isPlaced ? '.' : ` (the pane waits: ${res.reason}).`),
    }
  })

  // Esc 不會送進 Client：它把焦點交回面板，面板再按 Esc 就關掉（closeOnEscape）。那個「關」攔下來：
  // 畫面還有東西可以退（浮層、選取、開著的聊天室）就當成 Esc 交給畫面，面板留著；退到底才真的關。
  // 引擎分不出是 Esc 還是點了關閉鈕，所以聊天室開著時點關閉鈕也是先回清單。
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const back = e.origin.kind === 'person' && (await read($, escapable))
    if (back) {
      await update($, esc, n => n + 1)
      return { value: undefined }
    }
    paneOpen = false
    paneFocused = false
    viewing = null
    stopPlayer?.()
    return next(e)
  })

  on('ui.message', { requestId: PANE }, async ($, e) => {
    const post = (e.data ?? {}) as Post
    const ops = (post.ops ?? []).filter(x => x.seq > lastSeq)
    if (ops.length) {
      lastSeq = Math.max(...ops.map(x => x.seq))
      await update($, ack, () => lastSeq)
      for (const op of ops) void doOp($, op).catch(err => say($, errText(err)))
    }
    if (post.ui) {
      ui = { ...post.ui }
      if ((await read($, escapable)) !== post.ui.escapable) await update($, escapable, () => post.ui!.escapable)
    }
    if (post.want?.length && opts.images) void want($, post.want)
    if (post.slots && JSON.stringify(post.slots) !== JSON.stringify(await read($, slots))) await update($, slots, () => post.slots!)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    paneOpen = true
    paneFocused = e.props.isFocused
    const els = $.ui.resolve(e)
    const cols = Math.max(20, e.props.bodyColumns)
    const rows = Math.max(8, e.props.scroll.bodyRows)
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = els
      return <Text dimColor>enil needs the terminal or the desktop app.</Text>
    }
    // Client 的 props 最多 100,000 字：大頭貼路徑每個人只送一次，太長就丟最舊的訊息。
    const avatars: Record<string, string> = {}
    const slim = (msgs: Msg[]) =>
      msgs.map(m => {
        if (!m.avatar) return m
        avatars[m.from] = m.avatar
        const { avatar, ...rest } = m
        void avatar
        return rest
      })
    const v = await read($, view)
    const pk = await read($, peek)
    const props: AppProps = {
      surface: e.surface,
      images: opts.images && e.surface === 'terminal',
      avatars,
      conn: await read($, conn),
      chats: await read($, chats),
      view: { ...v, msgs: slim(v.msgs) },
      peek: { ...pk, msgs: slim(pk.msgs) },
      status: await read($, status),
      prefs: await read($, prefs),
      search: await read($, search),
      msgSearch: await read($, msgSearch),
      members: await read($, members),
      packs: await read($, packs),
      media: await read($, media),
      replies: await read($, replies),
      viewer: await read($, viewer),
      themes: await read($, themes),
      ack: await read($, ack),
      esc: await read($, esc),
      focused: e.props.isFocused,
      playing: await read($, playing),
      stickerKeys: await read($, stickerKeys),
      draft: await read($, draft),
    }
    while (props.view.msgs.length > 40 && JSON.stringify(props).length > 95000) {
      props.view = { ...props.view, msgs: props.view.msgs.slice(20), exhausted: true }
    }
    if (e.surface === 'desktop') {
      const { Box, Client } = els as Elements['desktop']
      return (
        <Box width={cols} height={rows}>
          <Client key="app" module="./app.tsx" props={props} width={cols} height={rows} />
        </Box>
      )
    }
    const { Box, Client, Image } = els as Elements['terminal']
    const placed = props.images ? (await read($, slots)).filter(s => png.has(s.k) && s.x + s.w <= cols && s.y + s.h <= rows) : []
    return (
      <Box width={cols} height={rows}>
        <Client key="app" module="./app.tsx" props={props} width={cols} height={rows} />
        {placed.map(s => (
          <Box key={`img-${s.x}-${s.y}`} position="absolute" top={s.y} left={s.x} width={s.w} height={s.h}>
            <Image key={`${s.k}#${s.x},${s.y}`} source={{ png: png.get(s.k)! }} columns={s.w} rows={s.h} alt={s.a || ' '} />
          </Box>
        ))}
      </Box>
    )
  })
}
