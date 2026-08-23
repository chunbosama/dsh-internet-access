/**
 * dsh-internet-access —— 公网访问插件（host 半区）。
 *
 * 参考 zhu1090093659/dsh-web-ui 的 dsh-remote-web-ui 架构，但**去掉全部配对
 * （配队）功能**：没有二维码、没有一次性令牌、没有设备会话、没有 /remote 配对
 * 通道。取而代之的是一个极简「访问口令」门禁：
 *
 *   - 一键 Cloudflare quick tunnel（cloudflared 随包分发，无账号/无域名），
 *     把 dsh web GUI 暴露到公网；
 *   - 共享访问口令（自动生成并落盘，或 profile 配置指定）：浏览器在非本机
 *     回环 origin 打开时，必须携带有效口令 cookie 才能使用；
 *   - 浏览器半区把 /api、/sidebar、/git、/pet 改写为 /public 通道，本半区
 *     在口令门禁通过后把请求转发回 127.0.0.1（loopback 形态），从而绕过
 *     SDK 对非回环 Host 的 /api 围栏，同时保持 SDK 特权方法仅本机可达。
 *
 * 路由族（与浏览器半区契约）：
 *   GET  /api/public-access/status        仅本机回环：隧道状态/公网链接/口令配置/姿态
 *   POST /api/public-access/start        仅本机回环：启动 quick tunnel
 *   POST /api/public-access/stop         仅本机回环：停止隧道
 *   POST /api/public-access/regenerate-token  仅本机回环：重生成访问口令
 *   GET  /api/public-access/authorized   任意来源：门禁探测（口令 cookie 有效 → 200）
 *   POST /api/public-access/verify       任意来源：校验口令并签发 cookie（门禁页用）
 *   GET/POST /public/*                   口令门禁通道：校验 cookie 后转发回 127.0.0.1
 *   UPGRADE /public/api/events.mux 等    同上门禁的 WebSocket 升级通道
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { connect } from 'node:net'
import { request as httpRequest } from 'node:http'
import z from '@deepseek-ai/schemastery'
import { bin, install, Tunnel } from 'cloudflared'

/** Cordis 插件名（cordis.patch.yml 中按此 id 引用）。 */
export const name = 'dsh-internet-access'

/** 必需服务：webServer 是路由载体。 */
export const inject = ['webServer']

/** 插件配置 schema。 */
export const Config = z.object({
  /** 主开关：false 时不注册任何路由、不启动隧道。 */
  enabled: z.boolean().default(true),
  /**
   * 共享访问口令。留空 = 首次启动自动生成一个强随机口令并持久化到
   * `$DSH_HOME/public-access-token.json`（0600）。显式配置后不再自动生成。
   */
  accessToken: z.string().default(''),
  /**
   * 是否要求口令：true（默认）时，非本机回环来源必须携带有效口令 cookie
   * 才能使用 GUI；false = 完全公开（任何拿到公网链接的人都能操作 agent，
   * 危险，仅在信任网络层时使用）。
   */
  requireToken: z.boolean().default(true),
  /** 启动插件时是否自动开始公网隧道。false 时在设置页卡片手动开启。 */
  autoTunnel: z.boolean().default(false),
  /**
   * 手动公网 base URL（例如你自建 named tunnel 的 `https://foo.example.com`）。
   * 设置后卡片展示的「公网链接」用它；未设置时用 quick tunnel 铸造的 URL。
   * 畸形值被忽略并告警。
   */
  publicBaseUrl: z.string().default(''),
  /** 口令 cookie 名。 */
  cookieName: z.string().default('dsh_public_access'),
  /** 口令持久化文件绝对路径（默认 $DSH_HOME/public-access-token.json）。 */
  tokenFile: z.string().default(''),
})

/**
 * 解析 DSH home（$DSH_HOME 优先，回退 ~/.dsh）。
 */
function dshHome() {
  const raw = process.env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    return raw.trim().replace(/^~(?=$|\/|\\)/, homedir())
  }
  return join(homedir(), '.dsh')
}

/** 默认口令文件路径。 */
function defaultTokenFile() {
  return join(dshHome(), 'public-access-token.json')
}

/**
 * 口令仓库：读取/生成/持久化访问口令。文件 0600 + 原子 rename，尽量不留
 * 半写状态。
 */
class TokenStore {
  constructor(file, configured) {
    this.file = file
    this.configured = configured
    this.token = undefined
  }

  /** 当前口令：配置优先，否则读取/生成持久化口令。 */
  get() {
    if (this.configured !== '') return this.configured
    if (this.token === undefined) {
      this.token = this.readOrCreate()
    }
    return this.token
  }

  /** 是否已配置（非自动生成）。 */
  get configuredExplicit() {
    return this.configured !== ''
  }

  /** 重生成一个随机口令并持久化（仅自动生成模式可用）。 */
  regenerate() {
    const next = randomBytes(24).toString('base64url')
    if (this.configured === '') {
      this.persist(next)
    }
    this.token = next
    return next
  }

  readOrCreate() {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (typeof parsed.token === 'string' && parsed.token !== '') return parsed.token
    } catch {
      // 不存在或损坏：重新生成。
    }
    const next = randomBytes(24).toString('base64url')
    this.persist(next)
    return next
  }

  persist(token) {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify({ token, createdAt: new Date().toISOString() }), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (error) {
      // 持久化失败不致命：口令只在本次进程内有效，下次启动会重新生成。
      console.warn(`[dsh-internet-access] 无法持久化访问口令到 ${this.file}: ${error?.message ?? error}`)
    }
  }
}

/** sha256 摘要，用于恒定时间比较（避免长度泄漏）。 */
function digest(value) {
  return createHash('sha256').update(value).digest()
}

/** 恒定时间比较两个口令。 */
function safeEqual(a, b) {
  const da = digest(a)
  const db = digest(b)
  return timingSafeEqual(da, db)
}

/** 读一个 cookie 值。 */
function readCookie(header, cookieName) {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    if (key === cookieName) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** 请求来源的 Host hostname。 */
function hostnameOf(request) {
  const host = request.headers.host
  if (typeof host !== 'string') return undefined
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return undefined
  }
}

/** IPv4 回环判定。 */
function isLoopbackAddress(address) {
  if (address === undefined) return false
  if (address === '::1' || address === '::ffff:127.0.0.1') return true
  return address.startsWith('127.')
}

/** hostname 回环判定（localhost / ::1 / 127/8）。 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 是否来自本机回环（socket + Host 双重校验，防 DNS rebinding）。 */
function isLoopbackClient(request) {
  const hostname = hostnameOf(request)
  if (hostname === undefined || !isLoopbackHostname(hostname)) return false
  const socket = request.socket
  return isLoopbackAddress(socket?.remoteAddress)
}

/** JSON 响应。 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** 有界读取 JSON body。 */
async function readBoundedJson(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk
    size += buffer.length
    if (size > maxBytes) throw new Error('body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 默认二进制就绪：缺失时按平台下载 cloudflared。 */
async function defaultEnsureBinary() {
  if (existsSync(bin)) return
  await install(bin)
}

/** 默认工厂：cloudflared 包的 quick tunnel（无账号）。 */
function defaultFactory(targetUrl) {
  return Tunnel.quick(targetUrl, { '--no-autoupdate': true })
}

const nodeTimer = { setTimeout, clearTimeout }

/**
 * 隧道生命周期管理器（移植自 dsh-remote-web-ui 的 tunnel.ts）：
 * start/stop、URL 上报、崩溃退避重启。
 */
export class TunnelManager {
  constructor(options = {}) {
    this.factory = options.factory ?? defaultFactory
    this.ensureBinary = options.ensureBinary ?? defaultEnsureBinary
    this.urlTimeoutMs = options.urlTimeoutMs ?? 30_000
    this.restartBaseMs = options.restartBaseMs ?? 5_000
    this.restartMaxMs = options.restartMaxMs ?? 60_000
    this.timer = options.timer ?? nodeTimer

    this.phase = 'stopped'
    this.url = undefined
    this.error = undefined
    this.targetUrl = undefined
    this.handle = undefined
    this.urlTimer = undefined
    this.restartTimer = undefined
    this.attempts = 0
    this.generation = 0
    this.stopping = false
    this.urlListeners = new Set()
    this.phaseListeners = new Set()
  }

  get info() {
    return {
      phase: this.phase,
      ...(this.url !== undefined ? { url: this.url } : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
    }
  }

  start(targetUrl) {
    if (this.targetUrl === targetUrl && (this.phase === 'starting' || this.phase === 'running')) return
    this.teardown()
    this.stopping = false
    this.targetUrl = targetUrl
    this.attempts = 0
    this.generation += 1
    this.attempt()
  }

  stop() {
    this.teardown()
    this.stopping = false
    this.targetUrl = undefined
    this.setPhase('stopped')
  }

  dispose() {
    this.stop()
  }

  onUrl(listener) {
    this.urlListeners.add(listener)
    return () => {
      this.urlListeners.delete(listener)
    }
  }

  onPhase(listener) {
    this.phaseListeners.add(listener)
    return () => {
      this.phaseListeners.delete(listener)
    }
  }

  attempt() {
    if (this.stopping || this.targetUrl === undefined) return
    const gen = this.generation
    this.setPhase('starting')
    this.handle = undefined
    this.url = undefined
    this.error = undefined
    void this.ensureBinary().then(() => {
      if (this.stopping || this.targetUrl === undefined || gen !== this.generation) return
      const handle = this.factory(this.targetUrl)
      this.handle = handle
      this.urlTimer = this.timer.setTimeout(() => {
        this.fail('timed out waiting for the tunnel URL')
      }, this.urlTimeoutMs)
      handle.on('url', (value) => {
        if (this.handle !== handle) return
        this.handleUrl(value)
      })
      handle.on('exit', () => {
        if (this.handle !== handle) return
        this.handleExit()
      })
      handle.on('error', (value) => {
        if (this.handle !== handle || this.phase !== 'starting') return
        this.error = value instanceof Error ? value.message : String(value)
      })
    }).catch((value) => {
      if (this.stopping || this.targetUrl === undefined || gen !== this.generation) return
      const message = value instanceof Error ? value.message : String(value)
      this.fail(`could not obtain the cloudflared binary: ${message}`)
    })
  }

  handleUrl(value) {
    if (this.urlTimer !== undefined) {
      this.timer.clearTimeout(this.urlTimer)
      this.urlTimer = undefined
    }
    this.url = value
    this.error = undefined
    this.attempts = 0
    this.setPhase('running')
    for (const listener of this.urlListeners) {
      try {
        listener(value)
      } catch {
        // 订阅者抛错不得打断广播。
      }
    }
  }

  handleExit() {
    if (this.stopping) return
    this.fail('the tunnel process exited unexpectedly')
  }

  fail(message) {
    if (this.stopping) return
    this.url = undefined
    this.error = message
    if (this.handle !== undefined) {
      this.handle.stop()
      this.handle = undefined
    }
    if (this.urlTimer !== undefined) {
      this.timer.clearTimeout(this.urlTimer)
      this.urlTimer = undefined
    }
    this.setPhase('failed')
    this.attempts += 1
    const delay = Math.min(this.restartBaseMs * 2 ** (this.attempts - 1), this.restartMaxMs)
    this.restartTimer = this.timer.setTimeout(() => {
      this.restartTimer = undefined
      this.attempt()
    }, delay)
  }

  teardown() {
    this.stopping = true
    if (this.urlTimer !== undefined) {
      this.timer.clearTimeout(this.urlTimer)
      this.urlTimer = undefined
    }
    if (this.restartTimer !== undefined) {
      this.timer.clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    if (this.handle !== undefined) {
      this.handle.stop()
      this.handle = undefined
    }
  }

  setPhase(phase) {
    this.phase = phase
    const info = this.info
    for (const listener of this.phaseListeners) {
      try {
        listener(info)
      } catch {
        // 同上。
      }
    }
  }
}

/** 局域网 IPv4 字面量（不含回环）。 */
export function lanIPv4Addresses() {
  const out = []
  const ifaces = networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (!out.includes(entry.address)) out.push(entry.address)
    }
  }
  return out
}

/** 公网 base 的 host 权威（畸形时 undefined）。 */
function publicHostOf(url) {
  if (url === undefined || url === '') return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/** 探测 SDK /api 围栏姿态：伪造 Host 请求 /api，非 403 视为敞开。 */
async function probeFence(port, hostHeader, timeoutMs = 3000) {
  return await new Promise((resolvePromise) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/session.list',
        headers: { host: hostHeader, 'content-type': 'application/json' },
        timeout: timeoutMs,
      },
      (res) => {
        resolvePromise(res.statusCode !== 403)
        res.resume()
      },
    )
    req.on('error', () => resolvePromise(false))
    req.on('timeout', () => {
      req.destroy()
      resolvePromise(false)
    })
    req.end('{}')
  })
}

/** /public 通道的内层路径映射。 */
const PUBLIC_PREFIX = '/public'
const CONTROL_PREFIX = '/api/public-access'

/** SDK 特权方法（对应 client-connection 的 loopback-only 面），远程不可达。 */
const LOOPBACK_ONLY_METHODS = new Set([
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
])

/** 必须留在本机的内层路径（控制平面 / 其它插件特权面）。 */
function loopbackOnlyDenial(innerPath) {
  if (innerPath === CONTROL_PREFIX || innerPath.startsWith(`${CONTROL_PREFIX}/`)) {
    return 'public-access control endpoints stay loopback-only'
  }
  if (innerPath === '/api/plugin-manager' || innerPath.startsWith('/api/plugin-manager/')) {
    return 'plugin-manager stays loopback-only'
  }
  if (innerPath === '/api/dsh-desktop-launcher' || innerPath.startsWith('/api/dsh-desktop-launcher/')) {
    return 'desktop-launcher endpoints stay loopback-only'
  }
  if (innerPath === '/api/dsh-web-ui-settings' || innerPath.startsWith('/api/dsh-web-ui-settings/')) {
    return 'settings-bridge endpoints stay loopback-only'
  }
  if (!innerPath.startsWith('/api/')) return undefined
  const method = innerPath.slice('/api/'.length)
  if (method !== '' && !method.includes('/') && LOOPBACK_ONLY_METHODS.has(method)) {
    return `${method} is loopback-only`
  }
  return undefined
}

/** /public/... → 内层路径；不安全段拒绝。 */
function innerPathOf(pathname) {
  if (pathname === PUBLIC_PREFIX || pathname === `${PUBLIC_PREFIX}/`) return undefined
  if (!pathname.startsWith(`${PUBLIC_PREFIX}/`)) return undefined
  const rest = pathname.slice(PUBLIC_PREFIX.length)
  if (!rest.startsWith('/')) return undefined
  const segments = rest.slice(1).split('/')
  if (segments.length === 0 || segments.some((segment) => {
    if (segment === '') return true
    let decoded
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return true
    }
    return decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')
  })) {
    return undefined
  }
  return rest
}

/** WebSocket 转发所需请求头。 */
const WS_FORWARD_HEADERS = [
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
]

/** 回环上游响应头白名单。 */
const HTTP_FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'cache-control',
  'etag',
  'last-modified',
]

/** HTTP 转发：把已过门禁的请求重发到 127.0.0.1（Host 重写、丢弃 Origin/cookie）。 */
export function proxyLoopbackHttp(req, res, port, upstreamPath) {
  const headers = {
    host: `127.0.0.1:${String(port)}`,
    'sec-fetch-site': 'same-origin',
  }
  const contentType = req.headers['content-type']
  if (typeof contentType === 'string') headers['content-type'] = contentType
  const contentLength = req.headers['content-length']
  if (typeof contentLength === 'string') headers['content-length'] = contentLength
  const accept = req.headers.accept
  if (typeof accept === 'string') headers.accept = accept

  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port,
      path: upstreamPath,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      const out = {}
      for (const name of HTTP_FORWARD_RESPONSE_HEADERS) {
        const value = upstreamRes.headers[name]
        if (value !== undefined) out[name] = value
      }
      res.writeHead(upstreamRes.statusCode ?? 502, out)
      upstreamRes.pipe(res)
    },
  )
  upstream.on('error', () => {
    if (!res.headersSent) {
      writeJson(res, 502, { ok: false, error: { code: 'upstream-failure', message: 'upstream request failed' } })
      return
    }
    res.destroy()
  })
  req.pipe(upstream)
}

/** WebSocket 升级转发：重建 loopback 形态握手并双向管道。 */
export function proxyLoopbackUpgrade(req, socket, head, port, upstreamPath) {
  const lines = [
    `GET ${upstreamPath} HTTP/1.1`,
    `Host: 127.0.0.1:${String(port)}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
  ]
  for (const name of WS_FORWARD_HEADERS) {
    const value = req.headers[name]
    if (value === undefined) continue
    lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
  }
  const handshake = `${lines.join('\r\n')}\r\n\r\n`

  const upstream = connect(port, '127.0.0.1')
  const tearDown = () => {
    upstream.destroy()
    socket.destroy()
  }
  upstream.on('error', tearDown)
  socket.on('error', tearDown)
  upstream.on('close', () => { socket.destroy() })
  socket.on('close', () => { upstream.destroy() })
  upstream.on('connect', () => {
    upstream.write(handshake)
    if (head.length > 0) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
}

/** SDK 信封形态的 403（保持浏览器解析路径）。 */
function envelopeError(res, status, rpcId, code, message) {
  writeJson(res, status, {
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code, message, details: { issues: [] } } },
  })
}

/** 升级通道路径（与浏览器半区契约一致）。 */
export const PUBLIC_UPGRADE_PATHS = [
  `${PUBLIC_PREFIX}/api/events.mux`,
  `${PUBLIC_PREFIX}/api/events.host`,
  `${PUBLIC_PREFIX}/sidebar/ws/terminal`,
  `${PUBLIC_PREFIX}/sidebar/ws/agent-terminals`,
  `${PUBLIC_PREFIX}/api/dsh-ssh/terminal`,
]

/** 升级路径内层映射（查询串保留）。 */
function upgradeInnerPath(reqUrl, fallbackPath) {
  if (reqUrl === undefined || reqUrl === '') return fallbackPath
  let url
  try {
    url = new URL(reqUrl, 'http://127.0.0.1')
  } catch {
    return fallbackPath
  }
  const inner = innerPathOf(url.pathname)
  if (inner === undefined) return fallbackPath
  return `${inner}${url.search}`
}

/** 插件 apply。 */
export function apply(ctx, config) {
  const cfg = config
  if (!cfg.enabled) {
    ctx.logger.info('dsh-internet-access: disabled by config, no routes registered')
    return
  }

  const web = ctx.webServer
  const port = web.port
  const tokens = new TokenStore(cfg.tokenFile !== '' ? cfg.tokenFile : defaultTokenFile(), cfg.accessToken)
  const tunnel = new TunnelManager()
  const disposers = []

  const requireToken = () => cfg.requireToken

  const publicUrl = () => {
    if (cfg.publicBaseUrl !== '') {
      try {
        return new URL(cfg.publicBaseUrl).toString().replace(/\/$/, '')
      } catch {
        ctx.logger.warn('dsh-internet-access: 忽略畸形 publicBaseUrl，回退 quick tunnel URL')
        return tunnel.info.url
      }
    }
    return tunnel.info.url
  }

  /** 请求是否携带有效口令 cookie。 */
  const authorized = (req) => {
    const cookie = readCookie(req.headers.cookie, cfg.cookieName)
    if (cookie === undefined) return false
    return safeEqual(cookie, tokens.get())
  }

  /** 最近一次围栏姿态（缓存 10s）。 */
  let postureCache
  const checkPosture = async (force = false) => {
    const now = Date.now()
    if (!force && postureCache !== undefined && now - postureCache.at < 10_000) {
      return { exposed: postureCache.exposed, checkedAt: postureCache.checkedAt }
    }
    const host = publicHostOf(publicUrl()) ?? publicHostOf(tunnel.info.url)
    let exposed = false
    let checkedAt = 0
    if (host !== undefined) {
      exposed = await probeFence(port, host)
      checkedAt = Date.now()
    }
    postureCache = { at: now, exposed, checkedAt }
    return { exposed, checkedAt }
  }

  // ── /api/public-access 路由族 ────────────────────────────────────────────
  // 状态（仅回环）
  disposers.push(web.register({
    kind: 'exact',
    path: `${CONTROL_PREFIX}/status`,
    handler: (req, res) => {
      if (!isLoopbackClient(req)) {
        req.resume()
        envelopeError(res, 403, 'invalid-request', 'forbidden', 'public-access status is loopback-only')
        return
      }
      void (async () => {
        const posture = await checkPosture()
        writeJson(res, 200, {
          ok: true,
          phase: tunnel.info.phase,
          url: publicUrl(),
          tunnelUrl: tunnel.info.url,
          error: tunnel.info.error,
          tokenConfigured: !tokens.configuredExplicit,
          token: tokens.get(),
          requireToken: requireToken(),
          publicBaseUrlConfigured: cfg.publicBaseUrl !== '',
          lanAddresses: lanIPv4Addresses(),
          posture,
        })
      })()
    },
  }))

  // 启动隧道（仅回环）
  disposers.push(web.register({
    kind: 'exact',
    path: `${CONTROL_PREFIX}/start`,
    handler: (req, res) => {
      if (!isLoopbackClient(req)) {
        req.resume()
        envelopeError(res, 403, 'invalid-request', 'forbidden', 'public-access control is loopback-only')
        return
      }
      req.resume()
      tunnel.start(`http://127.0.0.1:${String(port)}`)
      writeJson(res, 200, { ok: true, phase: tunnel.info.phase })
    },
  }))

  // 停止隧道（仅回环）
  disposers.push(web.register({
    kind: 'exact',
    path: `${CONTROL_PREFIX}/stop`,
    handler: (req, res) => {
      if (!isLoopbackClient(req)) {
        req.resume()
        envelopeError(res, 403, 'invalid-request', 'forbidden', 'public-access control is loopback-only')
        return
      }
      req.resume()
      tunnel.stop()
      writeJson(res, 200, { ok: true, phase: tunnel.info.phase })
    },
  }))

  // 重生成口令（仅回环）
  disposers.push(web.register({
    kind: 'exact',
    path: `${CONTROL_PREFIX}/regenerate-token`,
    handler: (req, res) => {
      if (!isLoopbackClient(req)) {
        req.resume()
        envelopeError(res, 403, 'invalid-request', 'forbidden', 'public-access control is loopback-only')
        return
      }
      req.resume()
      const next = tokens.regenerate()
      writeJson(res, 200, { ok: true, token: next })
    },
  }))

  // 门禁探测（任意来源）：有效口令 cookie → 200；否则 403 token-required。
  // 浏览器半区在非回环 origin 启动时用它决定是否显示口令门禁页。
  disposers.push(web.register({
    kind: 'exact',
    path: `${CONTROL_PREFIX}/authorized`,
    handler: (req, res) => {
      req.resume()
      if (!requireToken() || authorized(req)) {
        writeJson(res, 200, { ok: true, requireToken: requireToken() })
        return
      }
      envelopeError(res, 403, 'invalid-request', 'token-required', 'public access requires the access token')
    },
  }))

  // 口令校验并签发 cookie（任意来源——公网门禁页依赖它）
  disposers.push(web.register({
    kind: 'exact',
    path: `${CONTROL_PREFIX}/verify`,
    handler: (req, res) => {
      void (async () => {
        try {
          const body = await readBoundedJson(req, 4096)
          const submitted = typeof body?.token === 'string' ? body.token : ''
          if (submitted === '' || !safeEqual(submitted, tokens.get())) {
            writeJson(res, 403, { ok: false, error: { code: 'bad-token', message: '访问口令不正确' } })
            return
          }
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'set-cookie': `${cfg.cookieName}=${tokens.get()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
            'referrer-policy': 'no-referrer',
          })
          res.end(JSON.stringify({ ok: true }))
        } catch {
          writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: '无效请求' } })
        }
      })()
    },
  }))

  // ── /public 门禁通道 ─────────────────────────────────────────────────────
  const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])

  disposers.push(web.register({
    kind: 'prefix',
    path: PUBLIC_PREFIX,
    handler: (req, res) => {
      if (requireToken() && !authorized(req)) {
        req.resume()
        envelopeError(res, 403, 'invalid-request', 'token-required', 'public access requires the access token')
        return
      }
      const method = req.method ?? 'GET'
      if (!ALLOWED_METHODS.has(method)) {
        req.resume()
        res.writeHead(405).end()
        return
      }
      let url
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1')
      } catch {
        req.resume()
        res.writeHead(400).end()
        return
      }
      const inner = innerPathOf(url.pathname)
      if (inner === undefined) {
        req.resume()
        res.writeHead(404).end()
        return
      }
      const denied = loopbackOnlyDenial(inner)
      if (denied !== undefined) {
        req.resume()
        envelopeError(res, 403, 'invalid-request', 'forbidden', denied)
        return
      }
      proxyLoopbackHttp(req, res, port, `${inner}${url.search}`)
    },
  }))

  // WebSocket 升级通道（按精确路径注册）
  for (const path of PUBLIC_UPGRADE_PATHS) {
    const fallback = path.slice(PUBLIC_PREFIX.length)
    disposers.push(web.registerUpgrade({
      path,
      handler: (req, socket, head) => {
        if (requireToken() && !authorized(req)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        const inner = upgradeInnerPath(req.url, fallback)
        const denied = loopbackOnlyDenial(inner.split('?')[0] ?? inner)
        if (denied !== undefined) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        proxyLoopbackUpgrade(req, socket, head, port, inner)
      },
    }))
  }

  // 隧道 URL 变化 → 重探测围栏姿态
  const unsubscribeUrl = tunnel.onUrl(() => {
    void checkPosture(true)
  })

  // autoTunnel
  if (cfg.autoTunnel) {
    tunnel.start(`http://127.0.0.1:${String(port)}`)
  }

  ctx.effect(() => () => {
    unsubscribeUrl()
    tunnel.dispose()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 忽略单个卸载失败。
      }
    }
  }, 'dsh-internet-access: routes + tunnel')
}
