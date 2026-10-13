import { expect, test } from 'claude-code/testing'

import { omarchyThemeName, parseOmarchy, parseOmarchyBundle } from '../hooks/themes'

// 官方主題的寫法：顏色名稱。
const NAMED = `accent = "#7aa2f7"
selection = "#292e42"
muted = "#414868"
background = "#1a1b26"
dark_background = "#13141c"
foreground = "#a9b1d6"
dark_foreground = "#565f89"
red = "#f7768e"
yellow = "#e0af68"
green = "#9ece6a"
`
// 很多自己裝的主題：終端機色號，selection_background 是給反白用的亮色。
const NUMBERED = `accent = "#89b4fa"
foreground = "#cdd6f4"
background = "#1e1e2e"
selection_background = "#f5e0dc"
color1 = "#f38ba8"
color2 = "#a6e3a1"
color3 = "#f9e2af"
color8 = "#585b70"
`

test('omarchy colors.toml in the named format', () => {
  expect(parseOmarchy(NAMED)).toMatchObject({
    accent: '#7aa2f7',
    selection: '#292e42',
    bg: '#1a1b26',
    sidebarBg: '#13141c',
    text: '#a9b1d6',
    muted: '#565f89',
    error: '#f7768e',
    warning: '#e0af68',
    ok: '#9ece6a',
  })
})

test('omarchy colors.toml in the numbered format, with an unreadable selection colour replaced', () => {
  const p = parseOmarchy(NUMBERED)
  expect(p).toMatchObject({ accent: '#89b4fa', bg: '#1e1e2e', muted: '#585b70', error: '#f38ba8', warning: '#f9e2af', ok: '#a6e3a1' })
  // #f5e0dc 上面放淺色字看不見：改用背景調亮一點。
  expect(p.selection).not.toBe('#f5e0dc')
  expect(p.selection).toMatch(/^#[0-9a-f]{6}$/)
})

test('a bundle of themes: names, the installed one wins over the official one, and the current one', () => {
  const raw = `@@@ tokyo-night\n${NAMED}\n@@@ catppuccin-latte\n${NUMBERED}\n@@@ tokyo-night\n${NUMBERED}\n@@@ current\n${NAMED}`
  const b = parseOmarchyBundle(raw)
  expect(b.themes.map(([n]) => n)).toEqual(['Omarchy · Catppuccin Latte', 'Omarchy · Tokyo Night'])
  expect(b.themes[1]![1].accent).toBe('#89b4fa')
  expect(parseOmarchy(b.current).accent).toBe('#7aa2f7')
  expect(omarchyThemeName('rose-pine-dark')).toBe('Omarchy · Rose Pine Dark')
})
