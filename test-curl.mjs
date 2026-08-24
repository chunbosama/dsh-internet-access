import http from 'node:http'
import { apply, Config } from 'file:///home/admin/dsh/dsh-internet-access/lib/index.js'
import { rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const base = '/home/admin/dsh/dsh-internet-access/.curl-test'
rmSync(base + '-users.json', { force: true })
rmSync(base + '-sessions.json', { force: true })

const routes = []
const webServer = { port: 3197, register(r) { routes.push(r); return () => {} }, registerUpgrade() { return () => {} } }
const ctx = { webServer, logger: { info(){}, warn(){} }, effect(fn) { this._d = fn() } }
apply(ctx, Config({ tokenFile: base + '-token.json', usersFile: base + '-users.json' }))
const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://x')
  const route = routes.find(r => r.path === parsed.pathname) ?? routes.find(r => r.kind === 'prefix' && parsed.pathname.startsWith(r.path + '/'))
  if (!route) { res.writeHead(404).end(); return }
  route.handler(req, res)
})
await new Promise(r => server.listen(3197, '127.0.0.1', r))

// curl 真正发送伪造 Host（undici 会忽略自定义 host）
for (const [label, cmd] of [
  ['users @remote-host', `curl -s -o /dev/null -w "%{http_code}" -H "Host: abc.trycloudflare.com" http://127.0.0.1:3197/api/public-access/users`],
  ['status @remote-host', `curl -s -o /dev/null -w "%{http_code}" -H "Host: abc.trycloudflare.com" http://127.0.0.1:3197/api/public-access/status`],
  ['users @loopback', `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3197/api/public-access/users`],
]) {
  const out = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' })
  console.log(label + ':', out.stdout.trim() || out.stderr.trim())
}
server.close(); ctx._d?.()
rmSync(base + '-users.json', { force: true }); rmSync(base + '-sessions.json', { force: true }); rmSync(base + '-token.json', { force: true })
console.log('DONE')
