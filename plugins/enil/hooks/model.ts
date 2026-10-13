// daemon 回傳的資料 → 畫面用的形狀。照 tui/src/model.rs 移植。

import type { Chat, Msg, Sticker } from '../types'

type Raw = Record<string, unknown>

const s = (v: Raw, k: string): string => (typeof v[k] === 'string' ? (v[k] as string) : '')
const n = (v: Raw, k: string): number => (typeof v[k] === 'number' ? (v[k] as number) : 0)

export function parseChats(v: unknown): Chat[] {
  if (!Array.isArray(v)) return []
  return v.map((c: Raw) => {
    const name = s(c, 'name')
    const avatar = s(c, 'avatar')
    return {
      mid: s(c, 'mid'),
      name: name || s(c, 'mid'),
      unread: n(c, 'unread'),
      lastText: s(c, 'lastText').replaceAll('\n', ' '),
      lastFrom: s(c, 'lastFrom'),
      lastTime: n(c, 'lastTime'),
      ...(avatar ? { avatar } : {}),
    }
  })
}

export function parseMsgs(v: unknown, me: string): Msg[] {
  if (!Array.isArray(v)) return []
  return v.map(m => parseMsg(m as Raw, me))
}

export function parseMsg(m: Raw, me: string): Msg {
  // mediaPath 是圖片縮圖，thumbPath 是貼圖或 FLEX 的圖 —— 畫法一樣。
  const media = [s(m, 'mediaPath'), s(m, 'thumbPath')].find(p => p !== '')
  const flexLinks = Array.isArray(m.flexLinks) ? (m.flexLinks as unknown[]) : []
  const link = [typeof flexLinks[0] === 'string' ? (flexLinks[0] as string) : undefined, firstUrl(s(m, 'text'))].find(
    u => u !== undefined && isWebUrl(u),
  )
  const st = m.sticker as Raw | undefined
  const sticker: Sticker | undefined =
    st && typeof st === 'object' && s(st, 'id') ? { id: s(st, 'id'), pkg: s(st, 'pkg'), ver: s(st, 'ver') } : undefined
  const avatar = s(m, 'fromAvatar')
  return {
    id: s(m, 'id'),
    from: s(m, 'from'),
    fromName: s(m, 'fromName'),
    text: body(m, media !== undefined),
    time: n(m, 'time'),
    mine: s(m, 'from') === me && me !== '',
    kind: s(m, 'contentType'),
    hasMedia: m.hasMedia === true,
    readCount: n(m, 'readCount'),
    reactions: Array.isArray(m.reactions) ? (m.reactions as Raw[]).map(r => s(r, 'type')) : [],
    mentions: Array.isArray(m.mentions) ? (m.mentions as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    ...(media !== undefined ? { media } : {}),
    ...(link !== undefined ? { link } : {}),
    ...(avatar ? { avatar } : {}),
    ...(sticker ? { sticker } : {}),
  }
}

/** 訊息本文。有文字就是文字；沒有的依型別給一個讀得懂的標示。有圖時圖片與貼圖不需要文字。 */
function body(m: Raw, hasImage: boolean): string {
  const text = s(m, 'text')
  const alt = s(m, 'altText')
  const kind = s(m, 'contentType')
  if (kind === 'CALL') return callLabel(text)
  if (text) return text
  if (kind === 'NONE' && m.decryptFailed === true) return '[E2EE 解密失敗]'
  if (kind === 'FLEX') return s(m, 'flexText') || alt || '[FLEX]'
  if ((kind === 'IMAGE' || kind === 'STICKER') && hasImage) return ''
  if (kind === 'IMAGE') return '[圖片]'
  if (kind === 'STICKER') return '[貼圖]'
  if (kind === 'VIDEO') return `[影片]${length(m)}${sizeSuffix(m)}`
  if (kind === 'AUDIO') return `[語音]${length(m)}`
  if (kind === 'FILE') return `[檔案] ${s(m, 'fileName') || '未命名'}${sizeSuffix(m)}`
  if (kind === 'CHATEVENT') return '[聊天室事件]'
  if (alt) return alt
  return `[${kind}]`
}

function length(m: Raw): string {
  const secs = Math.floor(n(m, 'duration') / 1000)
  return secs <= 0 ? '' : ` ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

function sizeSuffix(m: Raw): string {
  const b = n(m, 'fileSize')
  if (b <= 0) return ''
  if (b < 1024 * 1024) return `（${Math.ceil(b / 1024)} KB）`
  return `（${(b / 1048576).toFixed(1)} MB）`
}

function callLabel(text: string): string {
  const head = text.split(' millisecs')[0] ?? ''
  const ms = Number(head.split(' ').pop()) || 0
  if (ms <= 0) return '[通話] 未接通'
  return `[通話] ${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
}

function firstUrl(text: string): string | undefined {
  const at = [text.indexOf('https://'), text.indexOf('http://')].filter(i => i >= 0)
  if (at.length === 0) return undefined
  return text.slice(Math.min(...at)).split(/\s/)[0]
}

/** 只開 http(s)。連結是對方給的，file:// 或自訂 scheme 等於讓對方挑一個本機程式來執行。 */
function isWebUrl(u: string): boolean {
  return u.startsWith('https://') || u.startsWith('http://')
}

/** 送出時把挑過的 @ 換算成 LINE 要的位置（UTF-16 索引）。送出前刪掉的就不算。 */
export function mentionSpans(text: string, picked: [string, string][]): { mid: string; start: number; end: number }[] {
  let from = 0
  const out: { mid: string; start: number; end: number }[] = []
  for (const [mid, name] of picked) {
    const needle = `@${name}`
    const at = text.indexOf(needle, from)
    if (at < 0) continue
    // JS 字串本來就是 UTF-16，索引就是 LINE 要的。
    out.push({ mid, start: at, end: at + needle.length })
    from = at + needle.length
  }
  return out
}
