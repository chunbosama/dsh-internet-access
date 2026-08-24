import http from 'node:http'
import { apply, Config } from 'file:///home/admin/dsh/dsh-internet-access/lib/index.js'
import { rmSync } from 'node:fs'

const base = '/home/admin/dsh/dsh-internet-access/.final-test'
for (const f of [base + '-users.json', base + '-sessions.json', base + '-token.json']) rmSync(f, { force: true })

function boot(port, opts = {}) {
  const routes = []
  const webServer = { port, register(r) { routes.push(r); return () => {} }, registerUpgrade() { return () => {} } }
  const ctx = { webServer, logger: { info(){}, warn(){} }, effect(fn) { this._d = fn() } }
  apply(ctx, Config(Object.assign({ tokenFile: base + '-token.json', usersFile: base + '-users.json', sessionsFile: base + '-sessions.json' }, opts)))
  return { routes, ctx }
}

// 第一次启动：无任何用户，必须先 setup 初始账号
let inst = boot(3195)
let server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://x')
  const route = inst.routes.find(r => r.path === parsed.pathname) ?? inst.routes.find(r => r.kind === 'prefix' && parsed.pathname.startsWith(r.path + '/'))
  if (!route) { res.writeHead(404).end(); return }
  route.handler(req, res)
})
await new Promise(r => server.listen(3195, '127.0.0.1', r))

async function call(method, path, headers = {}, body) {
  const res = await fetch(`http://127.0.0.1:3195${path}`, { method, headers: { 'content-type': 'application/json', connection: 'close', ...headers }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  return { status: res.status, setCookie: res.headers.get('set-cookie'), body: text ? JSON.parse(text) : null }
}

function closeServer(srv) {
  return new Promise((resolve) => {
    try { srv.closeAllConnections?.() } catch {}
    srv.close(() => resolve())
  })
}

// 首次启动：无用户，旧 admin 不可用
let r = await call('GET', '/api/public-access/status', {})
console.log('1 first boot users:', JSON.stringify(r.body?.users), '| setupRequired:', r.body?.setupRequired)

// 创建初始账号 alice
r = await call('POST', '/api/public-access/setup', {}, { username: 'alice', password: 'password123', confirm: 'password123' })
console.log('1 setup:', r.status, r.body?.ok, 'user=' + r.body?.user)

// 登录 alice → 会话 cookie
r = await call('POST', '/api/public-access/verify', {}, { username: 'alice', password: 'password123' })
console.log('1 alice login:', r.status, r.body?.ok)
const sessionCookie = String(r.setCookie).split(';')[0].split('=')[1]

// 用户文件已存在 → 再次 boot 不应重复播种或覆盖
await closeServer(server); inst.ctx._d?.()
inst = boot(3195)
server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://x')
  const route = inst.routes.find(r => r.path === parsed.pathname) ?? inst.routes.find(r => r.kind === 'prefix' && parsed.pathname.startsWith(r.path + '/'))
  if (!route) { res.writeHead(404).end(); return }
  route.handler(req, res)
})
await new Promise(r => server.listen(3195, '127.0.0.1', r))

r = await call('GET', '/api/public-access/status', {})
console.log('2 after reboot users:', r.body?.users, '| loginMethods:', JSON.stringify(r.body?.loginMethods), '| setupRequired:', r.body?.setupRequired)

// 会话持久化：重启后旧会话 cookie 仍有效
r = await call('GET', '/api/public-access/authorized', { cookie: `dsh_public_access=${sessionCookie}` })
console.log('3 session survives reboot:', r.status, r.body?.ok)

// 自定义 initialUsers 覆盖（新文件）
for (const f of [base + '-users.json', base + '-sessions.json']) rmSync(f, { force: true })
await closeServer(server); inst.ctx._d?.()
inst = boot(3195, { initialUsers: { bob: 'bobpassword9' } })
server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://x')
  const route = inst.routes.find(r => r.path === parsed.pathname) ?? inst.routes.find(r => r.kind === 'prefix' && parsed.pathname.startsWith(r.path + '/'))
  if (!route) { res.writeHead(404).end(); return }
  route.handler(req, res)
})
await new Promise(r => server.listen(3195, '127.0.0.1', r))
r = await call('POST', '/api/public-access/verify', {}, { username: 'bob', password: 'bobpassword9' })
console.log('4 config.initialUsers seeded bob login:', r.status, r.body?.ok)

await closeServer(server); inst.ctx._d?.()
for (const f of [base + '-users.json', base + '-sessions.json', base + '-token.json']) rmSync(f, { force: true })
console.log('DONE')
