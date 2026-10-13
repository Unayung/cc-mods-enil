// 用假的 enil daemon（unix socket）和假的 claude（記下參數、印出 JSON）測試，不會連到 LINE。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chunks, command, start, TOOLS } from './enil-claude.mjs'

const ME = 'uME'

function fakeDaemon(dir) {
  const d = { sent: [], subs: [] }
  d.server = net.createServer(s => {
    let buf = ''
    s.on('data', chunk => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        const ok = data => s.write(JSON.stringify({ ok: true, data }) + '\n')
        if (req.cmd === 'state') ok({ me: { mid: ME, displayName: '我' } })
        else if (req.cmd === 'subscribe') {
          d.subs.push(s)
          ok({ subscribed: true })
        } else if (req.cmd === 'send') {
          d.sent.push(req)
          ok({ id: `r${d.sent.length}` })
        } else ok({})
      }
    })
    s.on('error', () => {})
  })
  d.push = data => {
    for (const s of d.subs) s.write(JSON.stringify({ event: 'message', data }) + '\n')
  }
  return new Promise(resolve => d.server.listen(path.join(dir, 'sock'), () => resolve(d)))
}

/** 假的 claude：把參數和 cwd 寫進 calls.jsonl，回答 "答：<問題>"。問題是 "sleep" 就一直睡。 */
function fakeClaude(dir) {
  const bin = path.join(dir, 'claude')
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n')
const prompt = args[args.indexOf('-p') + 1]
const r = args.indexOf('--resume')
if (r >= 0 && args[r + 1] === 'gone') { process.stderr.write('No conversation found'); process.exit(1) }
if (prompt === 'sleep') setTimeout(() => {}, 60000)
else if (prompt === 'long') console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: ('x'.repeat(99) + '\\n').repeat(100), session_id: 's1' }))
else console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '答：' + prompt, session_id: r >= 0 ? args[r + 1] : 's1' }))
`,
    { mode: 0o755 },
  )
  const calls = () =>
    fs.existsSync(path.join(dir, 'calls.jsonl'))
      ? fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
      : []
  return { bin, calls }
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await new Promise(r => setTimeout(r, 20))
  }
  return false
}

async function boot(t, extra = {}, saved = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enil-claude-'))
  const work = path.join(dir, 'work')
  fs.mkdirSync(work)
  const d = await fakeDaemon(dir)
  const c = fakeClaude(dir)
  if (saved) fs.writeFileSync(path.join(dir, 'enil-claude.json'), JSON.stringify(saved))
  const app = start({ stateDir: dir, claude: c.bin, cwd: work, log: () => {}, ...extra })
  await app.ready
  await until(() => d.subs.length > 0)
  let n = 0
  const say = (text, more = {}) => d.push({ id: `m${++n}`, chat: ME, from: ME, text, time: Date.now(), contentType: 'NONE', ...more })
  const texts = () => d.sent.map(s => s.text)
  t.after(() => {
    app.stop()
    d.server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, work, d, c, app, say, texts }
}

test('command: only messages starting with the prefix', () => {
  assert.equal(command('cc 你好', 'cc'), '你好')
  assert.equal(command('cc\n多行\n問題', 'cc'), '多行\n問題')
  assert.equal(command('cc　全形空白', 'cc'), '全形空白')
  assert.equal(command('cc', 'cc'), '')
  assert.equal(command('ccc 不是', 'cc'), null)
  assert.equal(command('隨便說說', 'cc'), null)
  assert.equal(command('🤖 cc 自己的回覆', 'cc'), null)
  assert.equal(command(undefined, 'cc'), null)
})

test('chunks: long answers split under the LINE limit, capped', () => {
  assert.deepEqual(chunks('短'), ['短'])
  const parts = chunks(('a'.repeat(99) + '\n').repeat(400))
  assert.equal(parts.length, 5)
  for (const p of parts) assert.ok(p.length < 5000)
  assert.ok(parts[0].startsWith('(1/5) '))
  assert.match(parts[4], /後面還有 \d+ 段沒送/)
})

test('a question in the self chat goes to read-only claude and the answer comes back', async t => {
  const { d, c, say, texts, work } = await boot(t)
  say('cc 這個專案在做什麼？')
  assert.ok(await until(() => texts().includes('🤖 答：這個專案在做什麼？')))
  assert.equal(texts()[0], '🤖 ⏳ 收到，想一下…')
  assert.ok(d.sent.every(s => s.chat === ME))
  const [call] = c.calls()
  assert.equal(call.cwd, fs.realpathSync(work))
  const a = call.args
  assert.equal(a[a.indexOf('--tools') + 1], TOOLS.join(','))
  assert.deepEqual(TOOLS, ['Read', 'Grep', 'Glob'])
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk')
  assert.ok(a.includes('--strict-mcp-config'))
  assert.ok(!a.includes('--resume'))
  assert.ok(!a.some(x => /bypass|dangerously/i.test(x)))
})

test('ignores other chats, other senders, non-text, old messages and its own replies', async t => {
  const { d, c, say } = await boot(t)
  say('cc 別的聊天室', { chat: 'uALICE' })
  say('cc 別人發的', { from: 'uALICE' })
  say('cc 群組裡', { chat: 'cGROUP', from: 'uALICE' })
  say('', { contentType: 'STICKER' })
  say('cc 很久以前的', { time: Date.now() - 3600_000 })
  say('🤖 答：cc 回覆')
  say('沒有前綴')
  await new Promise(r => setTimeout(r, 300))
  assert.equal(d.sent.length, 0)
  assert.equal(c.calls().length, 0)
})

test('the same message pushed twice runs once', async t => {
  const { d, c, texts } = await boot(t)
  const m = { id: 'dup', chat: ME, from: ME, text: 'cc 一次就好', time: Date.now(), contentType: 'NONE' }
  d.push(m)
  d.push(m)
  assert.ok(await until(() => texts().includes('🤖 答：一次就好')))
  await new Promise(r => setTimeout(r, 200))
  assert.equal(c.calls().length, 1)
})

test('follow-ups resume the session; /new starts over; the session survives a restart', async t => {
  const { dir, c, say, texts } = await boot(t)
  say('cc 第一個')
  assert.ok(await until(() => texts().includes('🤖 答：第一個')))
  say('cc 第二個')
  assert.ok(await until(() => texts().includes('🤖 答：第二個')))
  const a = c.calls()[1].args
  assert.equal(a[a.indexOf('--resume') + 1], 's1')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'enil-claude.json'), 'utf8')).sessionId, 's1')

  say('cc /new')
  assert.ok(await until(() => texts().some(x => x.includes('開新的對話'))))
  say('cc 第三個')
  assert.ok(await until(() => texts().includes('🤖 答：第三個')))
  assert.ok(!c.calls()[2].args.includes('--resume'))
})

test('a session that cannot be resumed falls back to a new one', async t => {
  const { say, texts } = await boot(t, {}, { sessionId: 'gone' })
  say('cc 還在嗎')
  assert.ok(await until(() => texts().some(x => x.includes('之前的對話接不上') && x.includes('答：還在嗎'))))
})

test('/cd changes the directory and refuses ones that do not exist', async t => {
  const { c, say, texts, work } = await boot(t)
  fs.mkdirSync(path.join(work, 'sub'))
  say('cc /cd sub')
  assert.ok(await until(() => texts().some(x => x.startsWith('🤖 換到 '))))
  say('cc /cd nope')
  assert.ok(await until(() => texts().some(x => x.includes('沒有這個目錄'))))
  say('cc 在哪')
  assert.ok(await until(() => texts().includes('🤖 答：在哪')))
  assert.equal(c.calls()[0].cwd, fs.realpathSync(path.join(work, 'sub')))
})

test('one job at a time; /stop kills it; /status and /help answer', async t => {
  const { say, texts } = await boot(t)
  say('cc sleep')
  assert.ok(await until(() => texts().includes('🤖 ⏳ 收到，想一下…')))
  say('cc 插隊')
  assert.ok(await until(() => texts().some(x => x.includes('還在跑上一個'))))
  say('cc /status')
  assert.ok(await until(() => texts().some(x => x.includes('正在跑'))))
  say('cc /stop')
  assert.ok(await until(() => texts().includes('🤖 停了。')))
  say('cc')
  assert.ok(await until(() => texts().some(x => x.includes('cc /new'))))
  assert.ok(!texts().some(x => x.includes('答：插隊')))
})

test('long answers arrive as numbered parts', async t => {
  const { say, texts } = await boot(t)
  say('cc long')
  assert.ok(await until(() => texts().some(x => x.startsWith('🤖 (3/3) '))))
  for (const x of texts()) assert.ok(x.length <= 5000)
})
