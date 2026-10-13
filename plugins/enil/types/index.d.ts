// enil mod 的型別契約：hooks 模組放在 $.state 的值，以及交給畫面（app.tsx）的 props。

export type Chat = {
  mid: string
  name: string
  unread: number
  lastText: string
  lastFrom: string
  lastTime: number
  /** 大頭貼在 daemon 那台機器上的路徑（一對一是對方的照片，群組是群組圖）。 */
  avatar?: string
}

export type Sticker = { id: string; pkg: string; ver: string }

export type Msg = {
  id: string
  from: string
  fromName: string
  /** 畫面上的本文：文字，或依型別給的標示（[影片] 0:12、[檔案] a.pdf…）。圖片、貼圖有圖時是空的。 */
  text: string
  time: number
  mine: boolean
  /** contentType 原樣（IMAGE / STICKER / FLEX …），收回後是 UNSENT。 */
  kind: string
  /** 要畫的圖（縮圖、貼圖、FLEX 的第一張圖），daemon 那台機器上的路徑。 */
  media?: string
  /** 有原檔可以跟 daemon 要（圖片、影片、語音、檔案）。 */
  hasMedia: boolean
  /** 點得開的網址（只有 http／https）。 */
  link?: string
  /** 發話者大頭貼。 */
  avatar?: string
  readCount: number
  reactions: string[]
  mentions: string[]
  sticker?: Sticker
}

export type Login = {
  status: string
  url?: string
  pin?: string
  error?: string
  qrPng?: string
}

export type Conn = {
  /** 推送那條連線通不通。 */
  online: boolean
  /** 問過 daemon 了沒（還沒問之前不畫登入畫面）。 */
  checked: boolean
  loggedIn: boolean
  me: string
  login: Login
  /** 連得上的話是哪台（ssh 主機，或「本機」）。 */
  where: string
}

/** 開著的聊天室。 */
export type View = {
  mid: string
  name: string
  msgs: Msg[]
  busy: boolean
  /** 往前翻已經翻到底了。 */
  exhausted: boolean
}

export type Peek = { mid: string; msgs: Msg[]; loading: boolean }

export type Status = { text: string; at: number; warn: boolean }

export type Prefs = {
  vip: string[]
  /** [mid, 分類]，依建立順序。 */
  cats: [string, string][]
  collapsed: string[]
  /** 最近用過或看過的貼圖，最近的在前。 */
  stickers: Sticker[]
}

export type Hit = { mid: string; name: string; unread: number; isNew: boolean }

export type Search = { q: string; hits: Hit[]; loading: boolean }

export type MsgHit = { chat: string; chatName: string; fromName: string; text: string; time: number }

export type MsgSearch = { q: string; hits: MsgHit[]; total: number; archived: number; loading: boolean }

export type Members = { mid: string; list: [string, string][] }

export type Pack = { name: string; stickers: Sticker[] }

/** 某張圖轉好了沒：[寬, 高]（像素），0 = 轉不出來。key 是「路徑@最大邊長」。 */
export type MediaDims = Record<string, [number, number] | 0>

/** 畫面上要疊一張圖的位置（app.tsx 算好送來）。 */
export type Slot = {
  /** 「路徑@最大邊長」。 */
  k: string
  x: number
  y: number
  w: number
  h: number
  /** 圖畫不出來時那裡顯示的字（跟底下畫的一樣）。 */
  a: string
}

export type Reply =
  | { seq: number; kind: 'attach'; path: string; name: string; size: number }
  | { seq: number; kind: 'text'; text: string }
  | { seq: number; kind: 'complete'; text: string; matches: string[] }

export type Viewer = { id: string; key: string; error: string }

/** Claude 擬好的訊息：畫面打開那個聊天室、放進輸入框，由人按 Enter 送出。seq 遞增。 */
export type Draft = { seq: number; mid: string; name: string; text: string }

export type Palette = {
  accent: string
  onAccent: string
  selection?: string
  bg?: string
  sidebarBg?: string
  text?: string
  muted?: string
  border?: string
  warning: string
  error: string
  ok: string
}

export type Themes = { names: string[]; palettes: Record<string, Palette>; chosen: string }

/** 畫面要做的事。seq 由畫面遞增，hooks 模組依它去重（同一批可能送兩次）。 */
export type Op = { seq: number; op: string; [k: string]: unknown }

export type Post = {
  ops?: Op[]
  /** 想要的圖（「路徑@最大邊長」）。 */
  want?: string[]
  slots?: Slot[]
  /** 畫面現在的樣子：開著哪個聊天室、有沒有往上捲、有沒有選取訊息、還有沒有 Esc 可以退。 */
  ui?: { open: string; scrolled: boolean; cursor: boolean; escapable: boolean }
}

export type AppProps = {
  surface: string
  images: boolean
  /** 發話者 mid → 大頭貼路徑（訊息裡的 avatar 拿掉了，省 props 的空間）。 */
  avatars: Record<string, string>
  conn: Conn
  chats: Chat[]
  view: View
  peek: Peek
  status: Status
  prefs: Prefs
  search: Search
  msgSearch: MsgSearch
  members: Members
  packs: Pack[]
  media: MediaDims
  replies: Reply[]
  viewer: Viewer
  themes: Themes
  ack: number
  esc: number
  focused: boolean
  playing: string
  /** 貼圖 id → 縮圖的「路徑@邊長」；'' = 拿不到。 */
  stickerKeys: Record<string, string>
  draft: Draft
}

declare module 'claude-code' {
  interface PluginState {
    enil: {
      conn: Conn
      chats: Chat[]
      view: View
      peek: Peek
      status: Status
      prefs: Prefs
      search: Search
      msgSearch: MsgSearch
      members: Members
      packs: Pack[]
      media: MediaDims
      slots: Slot[]
      replies: Reply[]
      viewer: Viewer
      themes: Themes
      ack: number
      esc: number
      escapable: boolean
      playing: string
      stickerKeys: Record<string, string>
      draft: Draft
    }
  }
}
