import http from 'node:http'
import { apply, Config } from 'file:///home/admin/dsh/dsh-internet-access/lib/index.js'
import { rmSync } from 'node:fs'

const base = '/home/admin/dsh/dsh-internet-access/.firstrun-test'
for (const f of [base + '-users.json', base + '-sessions.json', base + '-token.json']) rmSync(f, { force: true })

const routes = []
const webServer = { port: 3196, register(r) { routes.push(r); return () => {} }, registerUpgrade() { return () => {} } }
const ctx = { webServer, logger: { info(){}, warn(){} }, effect(fn) { this._d = fn() } }
apply(ctx, Config({ tokenFile: base + '-token.json', usersFile: base + '-users.json', sessionsFile: base + '-sessions.json' }))

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://x')
  const route = routes.find(r => r.path === parsed.pathname) ?? routes.find(r => r.kind === 'prefix' && parsed.pathname.startsWith(r.path + '/'))
  if (!route) { res.writeHead(404).end(); return }
  route.handler(req, res)
})
await new Promise(r => server.listen(3196, '127.0.0.1', r))

// raw http.request 允许伪造 Host（fetch/undici 会忽略自定义 Host）
function call(method, path, hostHeader, body) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: 3196, method, path,
      headers: { host: hostHeader ?? '127.0.0.1:3196', 'content-type': 'application/json' },
    }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        let parsed = null
        try { parsed = raw ? JSON.parse(raw) : null } catch { parsed = { _raw: raw } }
        resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'], body: parsed })
      })
    })
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

let pass = 0, fail = 0
const ok = (label, cond) => { if (cond) { pass++; console.log('PASS', label) } else { fail++; console.log('FAIL', label) } }

// 1) 首次启动：无任何用户，setupRequired=true，旧 admin 不应存在
let r = await call('GET', '/api/public-access/status')
ok('status users empty on first boot', Array.isArray(r.body?.users) && r.body.users.length === 0)
ok('setupRequired true on first boot', r.body?.setupRequired === true)
ok('loginMethods.password false on first boot', r.body?.loginMethods?.password === false)

// 2) 旧内置 admin 不应自动创建
r = await call('POST', '/api/public-access/verify', undefined, { username: 'admin', password: '100410zzr' })
ok('legacy admin/100410zzr no longer logs in (403)', r.status === 403)

// 3) 公网 Host 访问 setup → 403
r = await call('POST', '/api/public-access/setup', 'abc.trycloudflare.com', { username: 'bob', password: 'password123', confirm: 'password123' })
ok('setup from non-loopback host rejected (403)', r.status === 403)

// 4) 密码不一致 → 400
r = await call('POST', '/api/public-access/setup', undefined, { username: 'bob', password: 'password123', confirm: 'different123' })
ok('setup password mismatch rejected (400)', r.status === 400)

// 5) 密码过短 → 400
r = await call('POST', '/api/public-access/setup', undefined, { username: 'bob', password: 'short', confirm: 'short' })
ok('setup weak password rejected (400)', r.status === 400)

// 6) 合法初始账号创建成功
r = await call('POST', '/api/public-access/setup', undefined, { username: 'bob', password: 'password123', confirm: 'password123' })
ok('setup creates initial user (200)', r.status === 200 && r.body?.ok === true && r.body?.user === 'bob')

// 7) 再次 setup → 409（防止公网抢占）
r = await call('POST', '/api/public-access/setup', undefined, { username: 'eve', password: 'password456', confirm: 'password456' })
ok('second setup rejected (409)', r.status === 409)

// 8) 创建的用户可登录
r = await call('POST', '/api/public-access/verify', undefined, { username: 'bob', password: 'password123' })
ok('created user can log in (200 + cookie)', r.status === 200 && r.body?.ok === true && Boolean(r.setCookie))

server.close(); ctx._d?.()
for (const f of [base + '-users.json', base + '-sessions.json', base + '-token.json']) rmSync(f, { force: true })
console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
