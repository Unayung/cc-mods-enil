// 配色主題。照 tui/src/theme.rs 移植，多一個「Claude Code」（預設）：跟著 Claude Code 自己的主題走。
//
// 選單順序：Claude Code、Omarchy（讀 daemon 那台的 omarchy 主題）、終端機、內建（從 slk 移植）、
// 自訂（這台的 ~/.config/enil/themes 與 ~/.config/slk/themes，格式跟 slk 一樣）。

import type { Palette } from '../types'

export const CLAUDE = 'Claude Code'
export const OMARCHY = 'Omarchy'
export const TERMINAL = '終端機'

export const claudeCode: Palette = {
  accent: 'claude',
  onAccent: 'inverseText',
  muted: 'inactive',
  border: 'subtle',
  warning: 'warning',
  error: 'error',
  ok: 'success',
}

export const terminal: Palette = {
  accent: 'green',
  onAccent: 'black',
  warning: 'yellow',
  error: 'red',
  ok: 'green',
}

// （名稱, primary, accent, warning, error, background, surface, sidebar, text, muted, border）色碼照抄 slk。
const BUILTIN: [string, string[]][] = [
  ['Catppuccin Mocha', ['#89B4FA', '#A6E3A1', '#F9E2AF', '#F38BA8', '#1E1E2E', '#313244', '#0E0E16', '#CDD6F4', '#6C7086', '#45475A']],
  ['Catppuccin Latte', ['#1E66F5', '#40A02B', '#DF8E1D', '#D20F39', '#EFF1F5', '#E6E9EF', '#DCE0E8', '#4C4F69', '#6C6F85', '#BCC0CC']],
  ['Tokyo Night', ['#7AA2F7', '#9ECE6A', '#E0AF68', '#F7768E', '#1A1B26', '#24283B', '#262838', '#C0CAF5', '#565F89', '#3B4261']],
  ['Dracula', ['#BD93F9', '#50FA7B', '#FFB86C', '#FF5555', '#282A36', '#343746', '#14151C', '#F8F8F2', '#6272A4', '#44475A']],
  ['Gruvbox Dark', ['#83A598', '#B8BB26', '#FABD2F', '#FB4934', '#282828', '#3C3836', '#181818', '#EBDBB2', '#928374', '#504945']],
  ['Nord', ['#88C0D0', '#A3BE8C', '#EBCB8B', '#BF616A', '#2E3440', '#3B4252', '#1B2028', '#ECEFF4', '#7B88A1', '#4C566A']],
  ['One Dark', ['#61AFEF', '#98C379', '#E5C07B', '#E06C75', '#282C34', '#2C313C', '#1A1D23', '#ABB2BF', '#636D83', '#3E4452']],
  ['Rosé Pine', ['#C4A7E7', '#9CCFD8', '#F6C177', '#EB6F92', '#191724', '#1F1D2E', '#262433', '#E0DEF4', '#6E6A86', '#26233A']],
  ['Solarized Dark', ['#268BD2', '#859900', '#B58900', '#DC322F', '#002B36', '#073642', '#001820', '#839496', '#586E75', '#073642']],
  ['Solarized Light', ['#268BD2', '#859900', '#B58900', '#DC322F', '#FDF6E3', '#EEE8D5', '#EEE8D5', '#657B83', '#93A1A1', '#EEE8D5']],
  ['Everforest Dark', ['#7FBBB3', '#A7C080', '#DBBC7F', '#E67E80', '#2D353B', '#343F44', '#1E2429', '#D3C6AA', '#859289', '#3D484D']],
  ['Kanagawa', ['#7FB4CA', '#98BB6C', '#E6C384', '#E46876', '#1F1F28', '#2A2A37', '#0C0C10', '#DCD7BA', '#727169', '#363646']],
  ['GitHub Dark', ['#58A6FF', '#3FB950', '#D29922', '#F85149', '#0D1117', '#161B22', '#1C2128', '#C9D1D9', '#8B949E', '#30363D']],
  ['Monokai', ['#66D9EF', '#A6E22E', '#E6DB74', '#F92672', '#272822', '#3E3D32', '#181811', '#F8F8F2', '#75715E', '#49483E']],
  ['Cyberpunk Neon', ['#0ABDC6', '#00FF9C', '#FCEE0C', '#EA00D9', '#000B1E', '#0D1B2A', '#0D1B2A', '#D7D7D7', '#7E7E8E', '#133E7C']],
]

export function builtins(): Record<string, Palette> {
  const out: Record<string, Palette> = {}
  for (const [name, c] of BUILTIN) {
    out[name] = {
      accent: c[0]!,
      onAccent: c[4]!,
      selection: c[5],
      bg: c[4],
      sidebarBg: c[6],
      text: c[7],
      muted: c[8],
      border: c[9],
      warning: c[2]!,
      error: c[3]!,
      ok: c[1]!,
    }
  }
  return out
}

/** 一行一個 `key = "#rrggbb"` 的檔（omarchy 的 colors.toml、slk 主題的 [colors] 都是）。 */
function lookup(raw: string, key: string): string | undefined {
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    if (line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim()
  }
  return undefined
}

function hex(v: string | undefined): string | undefined {
  const h = v?.trim().replace(/^"|"$/g, '')
  return h && /^#[0-9a-fA-F]{6}$/.test(h) ? h : undefined
}

/** 往黑或白推一點：側欄背景要跟訊息區分得出來，omarchy 只給一個背景色。 */
function shade(c: string, amount: number): string {
  const n = parseInt(c.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const target = r + g + b < 3 * 128 ? 255 : 0
  const mix = (v: number) => Math.round(v + (target - v) * amount)
  return '#' + [mix(r), mix(g), mix(b)].map(v => v.toString(16).padStart(2, '0')).join('')
}

/** 相對亮度（0 暗 … 1 亮），用來判斷兩個顏色放在一起看不看得清楚。 */
function luminance(c: string): number {
  const n = parseInt(c.slice(1), 16)
  const ch = (v: number) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255)
}

const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x! + 0.05) / (y! + 0.05)
}

/**
 * omarchy 主題的 colors.toml。兩種寫法都認：新的（官方主題）用顏色名稱
 * （red、yellow、dark_foreground…），舊的（很多自己裝的主題）用終端機色號 color0–15。
 */
export function parseOmarchy(raw: string): Palette {
  if (!raw.trim()) return terminal
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const v = hex(lookup(raw, k))
      if (v) return v
    }
    return undefined
  }
  const bg = get('background')
  const text = get('foreground')
  // 選取列的底色：selection 常常是給「反白＋深色字」用的亮色（例如 #f5e0dc），拿來當清單的底色
  // 會讓上面的字看不見。跟文字的對比不夠就改用背景調亮一點。
  const sel = get('selection', 'lighter_background')
  const selection = sel && text && contrast(sel, text) >= 3 ? sel : bg ? shade(bg, 0.08) : undefined
  return {
    accent: get('accent', 'color4', 'blue') ?? 'green',
    onAccent: bg ?? 'black',
    selection,
    bg,
    sidebarBg: get('dark_background') ?? (bg ? shade(bg, 0.04) : undefined),
    text,
    muted: get('dark_foreground', 'color8', 'muted'),
    border: get('muted', 'color8', 'dark_foreground'),
    warning: get('yellow', 'color3') ?? 'yellow',
    error: get('red', 'color1') ?? 'red',
    ok: get('green', 'color2') ?? 'green',
  }
}

/** 主題資料夾名稱 → 選單上的名字：tokyo-night → Omarchy · Tokyo Night。 */
export function omarchyThemeName(dir: string): string {
  const words = dir.split(/[-_ ]+/).filter(Boolean).map(w => w[0]!.toUpperCase() + w.slice(1))
  return `${OMARCHY} · ${words.join(' ')}`
}

/**
 * 一次讀回來的所有 omarchy 主題：每個以「@@@ 資料夾名稱」開頭，接著是它的 colors.toml。
 * 後面的蓋掉前面的（自己裝的 ~/.config/omarchy/themes 排在官方的後面，跟 omarchy 一樣優先）。
 * 「current」是目前用的那個。
 */
export function parseOmarchyBundle(raw: string): { current: string; themes: [string, Palette][] } {
  const byDir = new Map<string, string>()
  let current = ''
  for (const part of raw.split(/^@@@ /m).slice(1)) {
    const nl = part.indexOf('\n')
    const dir = (nl < 0 ? part : part.slice(0, nl)).trim()
    const body = nl < 0 ? '' : part.slice(nl + 1)
    if (dir === 'current') current = body
    else if (dir && body.trim()) byDir.set(dir, body)
  }
  const themes = [...byDir.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map(dir => [omarchyThemeName(dir), parseOmarchy(byDir.get(dir)!)] as [string, Palette])
  return { current, themes }
}

/** slk 的主題檔：`name = "…"`，加一段 [colors]。缺名字、primary 或背景就不算主題。 */
export function parseSlk(raw: string): [string, Palette] | undefined {
  const name = lookup(raw, 'name')?.replace(/^"|"$/g, '')
  const get = (k: string) => hex(lookup(raw, k))
  const bg = get('background')
  const primary = get('primary')
  if (!name || !bg || !primary) return undefined
  return [
    name,
    {
      accent: primary,
      onAccent: bg,
      selection: get('selection_background') ?? get('surface'),
      bg,
      sidebarBg: get('sidebar_background') ?? get('surface_dark'),
      text: get('text'),
      muted: get('text_muted'),
      border: get('border'),
      warning: get('warning') ?? 'yellow',
      error: get('error') ?? 'red',
      ok: get('accent') ?? 'green',
    },
  ]
}
