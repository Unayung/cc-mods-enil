#!/usr/bin/env node
// enil-claude：在 LINE「跟自己的聊天」裡用 Claude Code。
//
// 跑在 enil daemon 那台機器上，跟 TUI、mod 一樣是 daemon unix socket 的消費者：
// 訂閱推送，看到「自己在跟自己的聊天裡發、以 cc 開頭」的訊息，就交給 `claude -p`，
// 再把回答送回同一個聊天室。只聽這一個聊天室、只認自己發的訊息，其他一律不理。
//
// Claude 只拿得到唯讀工具（Read、Grep、Glob），不載入任何 MCP server，
// 沒列在裡面的工具一律拒絕（dontAsk），所以它能讀檔、回答問題，不能改檔、不能跑指令。

import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const TOOLS = ['Read', 'Grep', 'Glob']
const REPLY = '🤖 '
/** LINE 一則文字最多 5000 字，留點空間給前綴和「(1/3)」。 */
const CHUNK = 4500
const MAX_CHUNKS = 5

const SYSTEM = [
  '你的回答會用 LINE 訊息送到使用者的手機上。',
  '用純文字回答，不要用 Markdown 表格或標題；程式碼片段可以，但要短。',
  '回答簡短，重點先講。你只有唯讀工具，不能改檔案或跑指令；被要求改東西時，說明要怎麼改就好。',
].join('')

const HELP = [
  'cc <問題>　問 Claude（接著上一段對話）',
  'cc /new　開新的對話',
  'cc /cd <目錄>　換專案目錄（也會開新的對話）',
  'cc /status　目前的目錄、對話、有沒有在跑',
  'cc /stop　停掉正在跑的',
  'cc /help　這份說明',
].join('\n')

export function stateDir(env = process.env) {
  return env.ENIL_STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'enil')
}

/** 送一行 JSON 給 daemon，回第一行回應的 data；daemon 回 ok:false 就丟錯。 */
export function request(sock, req, timeoutMs = 55000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock)
    let buf = ''
    const fail = err => {
      s.destroy()
      reject(err)
    }
    s.setTimeout(timeoutMs, () => fail(new Error('daemon 沒有回應')))
    s.on('connect', () => s.write(JSON.stringify(req) + '\n'))
    s.on('data', d => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      s.destroy()
      let v
      try {
        v = JSON.parse(buf.slice(0, nl))
      } catch {
        return reject(new Error('daemon 回了看不懂的東西'))
      }
      if (v.ok) resolve(v.data)
      else reject(new Error(v.error || 'daemon 回報錯誤'))
    })
    s.on('error', () => fail(new Error('daemon 沒在跑')))
  })
}

/** 把長回答切成 LINE 送得出去的幾則；太長的話後面截掉。 */
export function chunks(text, size = CHUNK, max = MAX_CHUNKS) {
  const parts = []
  let rest = text.trim() || '（沒有回答）'
  while (rest.length > 0) {
    let cut = rest.length <= size ? rest.length : rest.lastIndexOf('\n', size)
    if (cut < size / 2) cut = size
    parts.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (parts.length > max) {
    const dropped = parts.length - max
    parts.length = max
    parts[max - 1] += `\n\n…（太長了，後面還有 ${dropped} 段沒送）`
  }
  return parts.length === 1 ? parts : parts.map((p, i) => `(${i + 1}/${parts.length}) ${p}`)
}

/** 「cc 問題」→ 問題；不是給我們的訊息回 null。 */
export function command(text, prefix) {
  if (typeof text !== 'string') return null
  const t = text.trim()
  if (t === prefix) return ''
  for (const sep of [' ', '\n', '　']) if (t.startsWith(prefix + sep)) return t.slice(prefix.length + 1).trim()
  return null
}

function expand(dir, from) {
  if (dir === '~' || dir.startsWith('~/')) dir = path.join(os.homedir(), dir.slice(1))
  return path.resolve(from, dir)
}

/**
 * 開始聽。opts：
 *   stateDir   daemon 的 state 目錄（sock 在裡面）
 *   chat       要聽的聊天室 mid；不給就是自己（跟自己的聊天）
 *   cwd        Claude 一開始的工作目錄
 *   prefix     指令前綴，預設 cc
 *   claude     claude 執行檔
 *   timeoutMs  一次最多跑多久
 *   log        (line) => void
 * 回傳 { ready: Promise, stop() }。
 */
export function start(opts = {}) {
  const dir = opts.stateDir ?? stateDir()
  const sock = path.join(dir, 'sock')
  const saved = path.join(dir, 'enil-claude.json')
  const prefix = opts.prefix ?? 'cc'
  const claude = opts.claude ?? 'claude'
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000
  const log = opts.log ?? (line => console.error(`${new Date().toISOString()} ${line}`))

  let st = { cwd: opts.cwd ?? os.homedir(), sessionId: null }
  try {
    st = { ...st, ...JSON.parse(fs.readFileSync(saved, 'utf8')) }
  } catch {}
  if (opts.cwd) st.cwd = opts.cwd
  const save = () => {
    try {
      fs.writeFileSync(saved + '.tmp', JSON.stringify(st), { mode: 0o600 })
      fs.renameSync(saved + '.tmp', saved)
    } catch (e) {
      log(`存不了狀態：${e.message}`)
    }
  }

  let me = ''
  let chat = opts.chat ?? ''
  let job = null
  let busy = false
  let sub = null
  let stopped = false
  let retry = 1000
  const since = Date.now() - 60_000
  const seen = new Set()

  const reply = async text => {
    for (const part of chunks(text)) {
      try {
        await request(sock, { cmd: 'send', chat, text: REPLY + part, mentions: [] })
      } catch (e) {
        log(`送不出去：${e.message}`)
        return
      }
    }
  }

  const run = (prompt, resume) =>
    new Promise(resolve => {
      const args = [
        '-p',
        prompt,
        '--output-format',
        'json',
        '--tools',
        TOOLS.join(','),
        '--permission-mode',
        'dontAsk',
        '--strict-mcp-config',
        '--append-system-prompt',
        SYSTEM,
      ]
      if (resume) args.push('--resume', resume)
      const child = spawn(claude, args, { cwd: st.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      let killedBy = ''
      const timer = setTimeout(() => {
        killedBy = 'timeout'
        child.kill('SIGTERM')
      }, timeoutMs)
      job = { child, stop: () => ((killedBy = 'stop'), child.kill('SIGTERM')) }
      child.stdout.on('data', d => (out += d))
      child.stderr.on('data', d => (err += d))
      child.on('error', e => (err += e.message))
      child.on('close', code => {
        clearTimeout(timer)
        job = null
        let res = null
        try {
          res = JSON.parse(out)
        } catch {}
        resolve({ code, res, err: err.trim(), killedBy })
      })
    })

  const ask = async prompt => {
    busy = true
    try {
      return await answer(prompt)
    } finally {
      busy = false
    }
  }

  const answer = async prompt => {
    await reply('⏳ 收到，想一下…')
    let r = await run(prompt, st.sessionId)
    let note = ''
    if (!r.killedBy && st.sessionId && !r.res) {
      // 接不上之前的對話（被刪了、換了機器…）：開新的再試一次。
      note = '（之前的對話接不上，開了新的）\n'
      r = await run(prompt, null)
    }
    if (r.killedBy === 'stop') return reply('停了。')
    if (r.killedBy === 'timeout') return reply(`跑超過 ${Math.round(timeoutMs / 60000)} 分鐘，停掉了。`)
    if (!r.res) {
      log(`claude 失敗（${r.code}）：${r.err}`)
      return reply(`Claude 沒跑起來：${(r.err || `exit ${r.code}`).slice(0, 500)}`)
    }
    if (r.res.session_id) {
      st.sessionId = r.res.session_id
      save()
    }
    const text = typeof r.res.result === 'string' ? r.res.result : ''
    if (r.res.is_error || r.res.subtype !== 'success') return reply(note + `出錯了（${r.res.subtype}）${text ? '：' + text : ''}`)
    return reply(note + text)
  }

  const handle = async body => {
    const [verb, ...rest] = body.split(/\s+/)
    const arg = body.slice(verb.length).trim()
    if (body === '' || verb === '/help') return reply(HELP)
    if (verb === '/status') {
      return reply(`目錄：${st.cwd}\n對話：${st.sessionId ?? '（新的）'}\n${busy ? '正在跑' : '閒著'}`)
    }
    if (verb === '/stop') {
      if (!job) return reply('沒有在跑的。')
      job.stop()
      return
    }
    if (busy) return reply('還在跑上一個，等一下，或 cc /stop 停掉。')
    if (verb === '/new') {
      st.sessionId = null
      save()
      return reply('好，下一個問題開新的對話。')
    }
    if (verb === '/cd') {
      if (!rest.length) return reply(`目前在 ${st.cwd}`)
      const to = expand(arg, st.cwd)
      if (!fs.statSync(to, { throwIfNoEntry: false })?.isDirectory()) return reply(`沒有這個目錄：${to}`)
      st = { cwd: to, sessionId: null }
      save()
      return reply(`換到 ${to}，開新的對話。`)
    }
    if (verb.startsWith('/')) return reply(`不認得 ${verb}。\n\n${HELP}`)
    return ask(body)
  }

  const onMessage = m => {
    if (!m || m.chat !== chat || m.from !== me || !me) return
    if (m.contentType && m.contentType !== 'NONE') return
    if (typeof m.time === 'number' && m.time < since) return
    const body = command(m.text, prefix)
    if (body === null) return
    if (m.id) {
      if (seen.has(m.id)) return
      seen.add(m.id)
      if (seen.size > 500) seen.delete(seen.values().next().value)
    }
    log(`收到：${body.slice(0, 80)}`)
    handle(body).catch(e => log(`處理失敗：${e.message}`))
  }

  const connect = () => {
    if (stopped) return
    const s = net.connect(sock)
    sub = s
    let buf = ''
    s.on('connect', () => {
      retry = 1000
      s.write(JSON.stringify({ cmd: 'subscribe' }) + '\n')
    })
    s.on('data', d => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let v
        try {
          v = JSON.parse(line)
        } catch {
          continue
        }
        if (v.event === 'message') onMessage(v.data)
      }
    })
    s.on('error', () => {})
    s.on('close', () => {
      if (stopped) return
      log(`跟 daemon 的連線斷了，${retry / 1000} 秒後重連`)
      setTimeout(connect, retry)
      retry = Math.min(retry * 2, 60_000)
    })
  }

  const ready = (async () => {
    const state = await request(sock, { cmd: 'state' })
    me = state?.me?.mid ?? ''
    if (!me) throw new Error('daemon 還沒登入 LINE')
    if (!chat) chat = me
    log(`開始聽 ${chat === me ? '跟自己的聊天' : chat}，前綴「${prefix}」，目錄 ${st.cwd}`)
    connect()
  })()

  return {
    ready,
    stop() {
      stopped = true
      sub?.destroy()
      job?.stop()
    },
  }
}

function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = () => argv[++i]
    if (a === '--cwd') o.cwd = path.resolve(v())
    else if (a === '--chat') o.chat = v()
    else if (a === '--prefix') o.prefix = v()
    else if (a === '--claude') o.claude = v()
    else if (a === '--timeout') o.timeoutMs = Number(v()) * 60_000
    else if (a === '--state-dir') o.stateDir = v()
    else if (a === 'chats') o.listChats = true
    else if (a === '-h' || a === '--help') o.help = true
    else throw new Error(`不認得的參數：${a}`)
  }
  return o
}

const USAGE = `用法：enil-claude [選項]
       enil-claude chats        列出聊天室的 mid（找不到跟自己的聊天時用）

  --cwd <目錄>        Claude 一開始的工作目錄（預設：家目錄，或上次 /cd 的）
  --chat <mid>        要聽的聊天室（預設：跟自己的聊天）
  --prefix <字>       指令前綴（預設：cc）
  --claude <路徑>     claude 執行檔（預設：PATH 裡的 claude）
  --timeout <分鐘>    一次最多跑多久（預設：10）
  --state-dir <目錄>  enil daemon 的 state 目錄（預設跟 daemon 一樣）`

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let o
  try {
    o = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`)
    process.exit(2)
  }
  if (o.help) {
    console.log(USAGE)
    process.exit(0)
  }
  if (o.listChats) {
    const sock = path.join(o.stateDir ?? stateDir(), 'sock')
    try {
      const [state, list] = await Promise.all([request(sock, { cmd: 'state' }), request(sock, { cmd: 'chats' })])
      const me = state?.me?.mid
      if (me) console.log(`${me}\t（自己）`)
      for (const c of list ?? []) if (c.mid !== me) console.log(`${c.mid}\t${c.name}`)
      process.exit(0)
    } catch (e) {
      console.error(e.message)
      process.exit(1)
    }
  }
  const app = start(o)
  app.ready.catch(e => {
    console.error(e.message)
    process.exit(1)
  })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (app.stop(), process.exit(0)))
}
