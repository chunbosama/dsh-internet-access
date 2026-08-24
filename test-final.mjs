import http from 'node:http'
import { apply, Config } from 'file:///home/admin/dsh/dsh-internet-access/lib/index.js'
import { rmSync } from 'node:fs'

const base = '/home/admin/dsh/dsh-internet-access/.final-test'
for (const f of [base + '-users.json', base + '-sessions.json', base + '-token.json']) rmSync(f, { force: true })

function boot(port) {
  const routes = []
  const webServer = { port, register(r) { routes.push(r); return () => {} }, registerUpgrade() { return () => {} } }
  const ctx = { webServer, logger: { info(){}, warn(){} }, effect(fn) { this._d = fn() } }
  apply(ctx, Config({ tokenFile: base + '-token.json', usersFile: base + '-users.json', sessionsFile: base + '-sessions.json' }))
  return { routes, ctx }
}

// 第一次启动：播种 admin
let inst = boot(3195)
let server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://x')
  const route = inst.routes.find(r => r.path === parsed.pathname) ?? inst.routes.find(r => r.kind === 'prefix' && parsed.pathname.startsWith(r.path + '/'))
  if (!route) { res.writeHead(404).end(); return }
  route.handler(req, res)
})
await new Promise(r => server.listen(3195, '127.0.0.1', r))

async function call(method, path, headers = {}, body) {
  const res = await fetch(`http://127.0.0.1:3195${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  return { status: res.status, setCookie: res.headers.get('set-cookie'), body: text ? JSON.parse(text) : null }
}

// 登录 admin → 会话 cookie
let r = await call('POST', '/api/public-access/verify', {}, { username: 'admin', password: '100410zzr' })
console.log('1 admin login:', r.status, r.body?.ok)
const sessionCookie = String(r.setCookie).split(';')[0].split('=')[1]

// 用户文件已存在 → 再次 boot 不应重复播种或覆盖
server.close(); inst.ctx._d?.()
inst = boot(3195)
server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://x')
  const route = inst.routes.find(r => r.path === parsed.pathname) ?? inst.routes.find(r => r.kind === 'prefix' && parsed.pathname.startsWith(r.path + '/'))
  if (!route) { res.writeHead(404).end(); return }
  route.handler(req, res)
})
await new Promise(r => server.listen(3195, '127.0.0.1', r))

r = await call('GET', '/api/public-access/status', {})
console.log('2 after reboot users:', r.body.users, '| loginMethods:', JSON.stringify(r.body.loginMethods))

// 会话持久化：重启后旧会话 cookie 仍有效
r = await call('GET', '/api/public-access/authorized', { cookie: `dsh_public_access=${sessionCookie}` })
console.log('3 session survives reboot:', r.status, r.body?.ok)

// 自定义 initialUsers 覆盖（新文件）
for (const f of [base + '-users.json', base + '-sessions.json']) rmSync(f, { force: true })
server.close(); inst.ctx._d?.()
inst = boot(3195)
server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://x')
  const route = inst.routes.find(r => r.path === parsed.pathname) ?? inst.routes.find(r => r.kind === 'prefix' && parsed.pathname.startsWith(r.path + '/'))
  if (!route) { res.writeHead(404).end(); return }
  route.handler(req, res)
})
await new Promise(r => server.listen(3195, '127.0.0.1', r))
// 需要重建 apply 带 initialUsers —— 上面 boot() 用了默认；单独验证 UserStore 逻辑
console.log('DONE')
