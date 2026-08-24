/**
 * dsh-internet-access —— 公网访问插件（浏览器半区）。
 *
 * 两个职责：
 *  1. 设置页「公网访问」卡片（仅设置页入口，无侧边栏图标）：隧道启停、公网
 *     链接复制、访问口令查看/重生成。
 *  2. 公网门禁：在非本机回环 origin（LAN 或公网隧道）上，把应用的 /api、
 *     /sidebar、/git、/pet 请求改写为 /public 通道；未携带有效口令 cookie
 *     时显示全屏门禁页，验证通过后签发 cookie 并重载。
 *
 * 打包形态：window.__ModuleLoader__.load({ id, factory })（dsh-client-modules
 * 约定）。手写 React.createElement（无构建链），依赖由 dsh 客户端运行时提供。
 */

window.__ModuleLoader__.load({
	id: "dsh-internet-access",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var react = require("react");
		var jsxRuntime = require("react/jsx-runtime");

		var useState = react.useState;
		var useEffect = react.useEffect;
		var useRef = react.useRef;

		/** 所需服务：slots（设置页 section 注册）。 */
		exports.inject = ["slots"];

		// ── 常量 ────────────────────────────────────────────────────────────
		var STATUS_URL = "/api/public-access/status";
		var START_URL = "/api/public-access/start";
		var STOP_URL = "/api/public-access/stop";
		var REGEN_URL = "/api/public-access/regenerate-token";
		var VERIFY_URL = "/api/public-access/verify";
		var AUTHORIZED_URL = "/api/public-access/authorized";
		var USERS_URL = "/api/public-access/users";

		/** 门禁通道前缀（与 host 半区契约一致）。 */
		var PUBLIC_PREFIX = "/public";
		var CONTROL_PREFIX = "/api/public-access/";

		var API_PREFIX = "/api/";
		var SIDEBAR_PREFIX = "/sidebar/";
		var GIT_PREFIX = "/git/";
		var PET_PREFIX = "/pet/";
		var WS_PATHS = new Set([
			"/api/events.mux",
			"/api/events.host",
			"/sidebar/ws/terminal",
			"/sidebar/ws/agent-terminals",
			"/api/dsh-ssh/terminal",
		]);

		// ── 工具 ────────────────────────────────────────────────────────────
		function isLoopbackHostname(hostname) {
			if (hostname === "localhost" || hostname === "::1") return true;
			var parts = hostname.split(".");
			return (
				parts.length === 4 &&
				parts[0] === "127" &&
				parts.every(function (part) {
					return /^\d{1,3}$/.test(part) && Number(part) <= 255;
				})
			);
		}

		function toast(text) {
			var el = document.getElementById("dsh-ia-toast");
			if (!el) {
				el = document.createElement("div");
				el.id = "dsh-ia-toast";
				el.style.cssText =
					"position:fixed;left:50%;bottom:48px;transform:translateX(-50%);" +
					"background:rgba(31,35,41,.92);color:#fff;border-radius:999px;" +
					"padding:8px 16px;font-size:13px;z-index:99999;opacity:0;" +
					"transition:opacity .2s;pointer-events:none;";
				document.body.appendChild(el);
			}
			el.textContent = text;
			el.style.opacity = "1";
			clearTimeout(el._h);
			el._h = setTimeout(function () {
				el.style.opacity = "0";
			}, 1600);
		}

		function fallbackCopy(text) {
			var ta = document.createElement("textarea");
			ta.value = text;
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.appendChild(ta);
			ta.select();
			try {
				document.execCommand("copy");
			} catch (_) {
				/* 忽略 */
			}
			ta.remove();
		}

		function copyText(text) {
			if (navigator.clipboard && window.isSecureContext) {
				navigator.clipboard.writeText(text).then(
					function () {
						toast("已复制");
					},
					function () {
						fallbackCopy(text);
						toast("已复制");
					}
				);
			} else {
				fallbackCopy(text);
				toast("已复制");
			}
		}

		/** 从 SDK 信封或插件 JSON 里读错误码。 */
		function errorCodeOf(value) {
			if (typeof value !== "object" || value === null) return undefined;
			var record = value;
			var nested = record.result;
			if (typeof nested === "object" && nested !== null) {
				var error = nested.error;
				if (typeof error === "object" && error !== null && typeof error.code === "string") {
					return error.code;
				}
			}
			var err = record.error;
			if (typeof err === "object" && err !== null && typeof err.code === "string") {
				return err.code;
			}
			return undefined;
		}

		// ── 门禁通道改写（移植自 dsh-remote-web-ui remote-channel.ts，去掉配对）──
		function shouldRewriteFetchPath(pathname) {
			if (pathname.startsWith(CONTROL_PREFIX)) return false; // 门禁/控制端点保持直连
			if (pathname.startsWith(API_PREFIX)) return true;
			if (pathname === "/sidebar" || pathname.startsWith(SIDEBAR_PREFIX)) return true;
			if (pathname === "/git" || pathname.startsWith(GIT_PREFIX)) return true;
			if (pathname === "/pet" || pathname.startsWith(PET_PREFIX)) return true;
			return false;
		}

		function shouldRewriteWsPath(pathname) {
			return WS_PATHS.has(pathname);
		}

		function rewritePath(pathname) {
			return PUBLIC_PREFIX + pathname;
		}

		function rewriteRawUrl(raw, baseHref, origin) {
			var url;
			try {
				url = new URL(raw, baseHref);
			} catch (_) {
				return raw;
			}
			if (url.origin !== origin) return raw;
			if (!shouldRewriteFetchPath(url.pathname)) return raw;
			url.pathname = rewritePath(url.pathname);
			if (raw.startsWith("/") && !raw.startsWith("//")) {
				return url.pathname + url.search + url.hash;
			}
			return url.href;
		}

		/** 是否门禁 403（code token-required）。始终返回 Promise（调用处统一 .then 消费）。 */
		function isTokenRequiredDenied(response) {
			if (response.status !== 403) return Promise.resolve(false);
			return response
				.clone()
				.json()
				.then(function (body) {
					return errorCodeOf(body) === "token-required";
				})
				.catch(function () {
					return false;
				});
		}

		function patchSrcAccessor(ctor, rewrite) {
			if (ctor === undefined) return function () {};
			var descriptor = Object.getOwnPropertyDescriptor(ctor.prototype, "src");
			if (descriptor === undefined || descriptor.configurable === false) return function () {};
			if (descriptor.set === undefined) return function () {};
			var originalSet = descriptor.set;
			var originalGet = descriptor.get;
			Object.defineProperty(ctor.prototype, "src", {
				configurable: true,
				enumerable: descriptor.enumerable ?? true,
				get: originalGet,
				set: function (value) {
					originalSet.call(this, rewrite(String(value)));
				},
			});
			return function () {
				Object.defineProperty(ctor.prototype, "src", descriptor);
			};
		}

		/** 安装 /public 通道改写；返回恢复函数。 */
		function installRemoteChannel(window, onTokenRequired) {
			var originalFetch = window.fetch;
			var OriginalWebSocket = window.WebSocket;
			var OriginalEventSource = window.EventSource;

			var sameOrigin = function (url) {
				return url.origin === window.location.origin;
			};
			var rewrite = function (raw) {
				return rewriteRawUrl(raw, window.location.href, window.location.origin);
			};

			var patchedFetch = function (input, init) {
				var url = new URL(
					typeof input === "string" || input instanceof URL ? input.toString() : input.url,
					window.location.href
				);
				if (sameOrigin(url) && shouldRewriteFetchPath(url.pathname)) {
					var rewritten = new URL(url);
					rewritten.pathname = rewritePath(url.pathname);
					var next =
						typeof input === "string" || input instanceof URL
							? rewritten.toString()
							: new Request(rewritten, input);
					return Promise.resolve(originalFetch.call(window, next, init)).then(function (response) {
						isTokenRequiredDenied(response)
							.then(function (denied) {
								if (denied) onTokenRequired();
							})
							.catch(function () {
								// 门禁检查失败绝不影响真实响应链。
							});
						return response;
					});
				}
				return originalFetch.call(window, input, init);
			};

			var PatchedWebSocket = function (url, protocols) {
				var parsed = new URL(url.toString(), window.location.href);
				var wsOrigin =
					parsed.protocol === "wss:"
						? "https://" + parsed.host
						: parsed.protocol === "ws:"
							? "http://" + parsed.host
							: "";
				if (wsOrigin !== "" && wsOrigin === window.location.origin && shouldRewriteWsPath(parsed.pathname)) {
					var rewritten = new URL(parsed);
					rewritten.pathname = rewritePath(parsed.pathname);
					return new OriginalWebSocket(rewritten, protocols);
				}
				return new OriginalWebSocket(url, protocols);
			};
			PatchedWebSocket.prototype = OriginalWebSocket.prototype;

			var restoreSrc = [
				patchSrcAccessor(window.HTMLImageElement, rewrite),
				patchSrcAccessor(window.HTMLScriptElement, rewrite),
				patchSrcAccessor(window.HTMLIFrameElement, rewrite),
			];

			window.fetch = patchedFetch;
			window.WebSocket = PatchedWebSocket;
			if (OriginalEventSource !== undefined) {
				var PatchedEventSource = function (url, eventSourceInitDict) {
					var parsed = new URL(url.toString(), window.location.href);
					if (sameOrigin(parsed) && shouldRewriteFetchPath(parsed.pathname)) {
						var rewritten = new URL(parsed);
						rewritten.pathname = rewritePath(parsed.pathname);
						return new OriginalEventSource(rewritten, eventSourceInitDict);
					}
					return new OriginalEventSource(url, eventSourceInitDict);
				};
				PatchedEventSource.prototype = OriginalEventSource.prototype;
				window.EventSource = PatchedEventSource;
			}

			return function () {
				window.fetch = originalFetch;
				window.WebSocket = OriginalWebSocket;
				if (OriginalEventSource !== undefined) window.EventSource = OriginalEventSource;
				for (var i = 0; i < restoreSrc.length; i++) restoreSrc[i]();
			};
		}

		// ── 门禁页 ──────────────────────────────────────────────────────────
		var gateOverlay = {
			mounted: false,
			mount: function () {
				if (gateOverlay.mounted) return;
				gateOverlay.mounted = true;
				var node = document.createElement("div");
				node.id = "dsh-ia-gate";
				node.style.cssText =
					"position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;" +
					"background:var(--dsw-alias-bg-base,#0f1115);";
				document.body.appendChild(node);
				var root = createRootCompat();
				root.render(createGatePage(function (ok) {
					if (ok) window.location.reload();
				}));
				gateOverlay.node = node;
				gateOverlay.root = root;
			},
			unmount: function () {
				if (!gateOverlay.mounted) return;
				gateOverlay.mounted = false;
				try {
					gateOverlay.root.unmount();
				} catch (_) {}
				if (gateOverlay.node && gateOverlay.node.parentNode) {
					gateOverlay.node.parentNode.removeChild(gateOverlay.node);
				}
				gateOverlay.node = undefined;
				gateOverlay.root = undefined;
			},
		};

		/** react-dom/client 的 createRoot（尽力获取）。 */
		function createRootCompat() {
			try {
				var rd = require("react-dom/client");
				var node = document.getElementById("dsh-ia-gate");
				return rd.createRoot(node);
			} catch (err) {
				return {
					render: function (element) {
						var node = document.getElementById("dsh-ia-gate");
						node.innerHTML = "";
						node.appendChild(renderToDom(element));
					},
					unmount: function () {},
				};
			}
		}

		/** 极简 DOM 渲染兜底（无 react-dom 时）。 */
		function renderToDom(element) {
			if (element === null || element === undefined || element === false) return document.createDocumentFragment();
			if (typeof element === "string" || typeof element === "number") {
				return document.createTextNode(String(element));
			}
			var el = document.createElement(element.type);
			var props = element.props || {};
			for (var key in props) {
				if (key === "children") continue;
				if (key === "style" && typeof props[key] === "object") {
					for (var s in props[key]) el.style[s] = props[key][s];
				} else if (key.startsWith("on") && typeof props[key] === "function") {
					el.addEventListener(key.slice(2).toLowerCase(), props[key]);
				} else if (key === "className") {
					el.className = props[key];
				} else {
					el.setAttribute(key, props[key]);
				}
			}
			var children = props.children;
			if (children !== undefined && children !== null) {
				var list = Array.isArray(children) ? children : [children];
				for (var i = 0; i < list.length; i++) {
					var child = renderToDom(list[i]);
					if (child) el.appendChild(child);
				}
			}
			return el;
		}

		/** 门禁页组件：支持「访问口令」与「用户名密码」两种登录方式。 */
		function createGatePage(onDone) {
			var mode = "token"; // 'token' | 'password'

			var setMode = function (next) {
				mode = next;
				var tokenPanel = document.getElementById("dsh-ia-panel-token");
				var passwordPanel = document.getElementById("dsh-ia-panel-password");
				var tabToken = document.getElementById("dsh-ia-tab-token");
				var tabPassword = document.getElementById("dsh-ia-tab-password");
				if (tokenPanel) tokenPanel.style.display = next === "token" ? "" : "none";
				if (passwordPanel) passwordPanel.style.display = next === "password" ? "" : "none";
				if (tabToken) tabToken.style.background = next === "token" ? "var(--dsw-alias-accent,#3b82f6)" : "transparent";
				if (tabToken) tabToken.style.color = next === "token" ? "#fff" : "inherit";
				if (tabPassword) tabPassword.style.background = next === "password" ? "var(--dsw-alias-accent,#3b82f6)" : "transparent";
				if (tabPassword) tabPassword.style.color = next === "password" ? "#fff" : "inherit";
			};

			var setError = function (text) {
				var err = document.getElementById("dsh-ia-gate-error");
				if (err) err.textContent = text || "";
			};

			var setBusy = function (busy) {
				var btn = document.getElementById("dsh-ia-gate-submit");
				if (btn) {
					btn.disabled = busy;
					btn.textContent = busy ? "验证中…" : "登录";
				}
			};

			var submit = function (e) {
				e.preventDefault();
				setError("");
				var payload;
				if (mode === "token") {
					var input = document.getElementById("dsh-ia-token-input");
					var token = input ? input.value.trim() : "";
					if (token === "") return;
					payload = { token: token };
				} else {
					var u = document.getElementById("dsh-ia-username-input");
					var p = document.getElementById("dsh-ia-password-input");
					var username = u ? u.value.trim() : "";
					var password = p ? p.value : "";
					if (username === "" || password === "") {
						setError("请输入用户名和密码");
						return;
					}
					payload = { username: username, password: password };
				}
				setBusy(true);
				fetch(VERIFY_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
				})
					.then(function (res) {
						return res.json().then(function (body) {
							return { ok: res.ok, body: body };
						});
					})
					.then(function (result) {
						if (result.ok) {
							toast("登录成功，正在进入…");
							onDone(true);
						} else {
							setError("访问口令或用户名密码不正确，请重试");
							setBusy(false);
						}
					})
					.catch(function () {
						setError("网络错误，请重试");
						setBusy(false);
					});
			};

			var tabStyle = {
				flex: 1,
				padding: "8px 0",
				border: "1px solid var(--dsw-alias-border-strong,rgba(128,128,128,.35))",
				borderRadius: "8px",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: "13px",
				cursor: "pointer",
				textAlign: "center",
			};
			var inputStyle = {
				padding: "10px 12px",
				borderRadius: "8px",
				border: "1px solid var(--dsw-alias-border-strong,rgba(128,128,128,.35))",
				background: "var(--dsw-alias-bg-input,#0f1115)",
				color: "inherit",
				font: "inherit",
				fontSize: "14px",
			};

			return jsxRuntime.jsx("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: "14px",
					padding: "32px",
					background: "var(--dsw-alias-bg-panel,#161a20)",
					border: "1px solid var(--dsw-alias-border-strong,rgba(128,128,128,.3))",
					borderRadius: "16px",
					width: "min(420px, 90vw)",
				},
				children: [
					jsxRuntime.jsx("div", { style: { fontSize: "18px", fontWeight: 700 }, children: "公网访问需要登录" }),
					jsxRuntime.jsx("div", {
						style: { fontSize: "13px", color: "var(--dsw-alias-label-secondary,#999)", textAlign: "center", lineHeight: 1.6 },
						children: "此链接暴露在公网。请输入访问口令，或使用已授权的用户名与密码登录。",
					}),
					jsxRuntime.jsx("div", {
						style: { display: "flex", gap: "8px", width: "100%" },
						children: [
							jsxRuntime.jsx("button", {
								id: "dsh-ia-tab-token",
								type: "button",
								style: tabStyle,
								onClick: function () {
									setMode("token");
								},
								children: "访问口令",
							}),
							jsxRuntime.jsx("button", {
								id: "dsh-ia-tab-password",
								type: "button",
								style: tabStyle,
								onClick: function () {
									setMode("password");
								},
								children: "用户名密码",
							}),
						],
					}),
					jsxRuntime.jsx("form", {
						onSubmit: submit,
						style: { display: "flex", flexDirection: "column", gap: "10px", width: "100%" },
						children: [
							jsxRuntime.jsx("div", {
								id: "dsh-ia-panel-token",
								style: { display: "flex", flexDirection: "column", gap: "10px" },
								children: [
									jsxRuntime.jsx("input", {
										id: "dsh-ia-token-input",
										type: "password",
										placeholder: "输入访问口令",
										autoFocus: true,
										style: inputStyle,
									}),
								],
							}),
							jsxRuntime.jsx("div", {
								id: "dsh-ia-panel-password",
								style: { display: "none", flexDirection: "column", gap: "10px" },
								children: [
									jsxRuntime.jsx("input", {
										id: "dsh-ia-username-input",
										type: "text",
										placeholder: "用户名",
										autoComplete: "username",
										style: inputStyle,
									}),
									jsxRuntime.jsx("input", {
										id: "dsh-ia-password-input",
										type: "password",
										placeholder: "密码",
										autoComplete: "current-password",
										style: inputStyle,
									}),
								],
							}),
							jsxRuntime.jsx("button", {
								id: "dsh-ia-gate-submit",
								type: "submit",
								style: {
									padding: "10px 12px",
									borderRadius: "8px",
									border: "none",
									background: "var(--dsw-alias-accent,#3b82f6)",
									color: "#fff",
									font: "inherit",
									fontSize: "14px",
									cursor: "pointer",
								},
								children: "登录",
							}),
							jsxRuntime.jsx("div", {
								id: "dsh-ia-gate-error",
								style: { fontSize: "12.5px", color: "var(--dsw-alias-text-danger,#e5484d)", minHeight: "16px" },
							}),
						],
					}),
				],
			});
		}

		// ── 设置页卡片 ──────────────────────────────────────────────────────
		function PublicAccessCard() {
			var state = useState({
				status: "loading",
				phase: "stopped",
				url: undefined,
				error: undefined,
				tokenConfigured: false,
				requireToken: true,
				lanAddresses: [],
				posture: undefined,
				users: [],
				loginMethods: undefined,
			});
			var data = state[0];
			var setData = state[1];
			var refreshTimer = useRef(undefined);

			var load = function () {
				fetch(STATUS_URL, { headers: { accept: "application/json" } })
					.then(function (res) {
						if (res.status === 403) {
							setData({ status: "forbidden" });
							return null;
						}
						if (!res.ok) throw new Error("HTTP " + res.status);
						return res.json();
					})
					.then(function (body) {
						if (body === null) return;
						setData({
							status: "ready",
							phase: body.phase,
							url: body.url,
							error: body.error,
							tokenConfigured: body.tokenConfigured,
							requireToken: body.requireToken,
							lanAddresses: Array.isArray(body.lanAddresses) ? body.lanAddresses : [],
							posture: body.posture,
							users: Array.isArray(body.users) ? body.users : [],
							loginMethods: body.loginMethods,
						});
					})
					.catch(function (err) {
						setData({ status: "error", message: String(err?.message ?? err) });
					});
			};

			useEffect(function () {
				load();
				refreshTimer.current = setInterval(load, 4000);
				return function () {
					if (refreshTimer.current) clearInterval(refreshTimer.current);
				};
			}, []);

			var act = function (url, label) {
				return fetch(url, { method: "POST" })
					.then(function (res) {
						if (!res.ok) throw new Error("HTTP " + res.status);
						return res.json();
					})
					.then(function (body) {
						if (body && body.ok) toast(label + "成功");
						load();
					})
					.catch(function (err) {
						toast(label + "失败：" + String(err?.message ?? err));
					});
			};

			var regenerate = function () {
				if (!window.confirm("重新生成后，已拿到旧口令的人将立即失去访问权限。确定？")) return;
				fetch(REGEN_URL, { method: "POST" })
					.then(function (res) {
						if (!res.ok) throw new Error("HTTP " + res.status);
						return res.json();
					})
					.then(function (body) {
						if (body && body.ok && body.token) {
							copyText(body.token);
							toast("已生成新口令并复制");
						}
						load();
					})
					.catch(function (err) {
						toast("重生成失败：" + String(err?.message ?? err));
					});
			};

			/** 添加/修改用户（用户名密码登录）。 */
			var addUser = function () {
				var username = window.prompt("输入用户名：", "");
				if (username === null || username.trim() === "") return;
				var password = window.prompt("输入密码（至少 1 个字符）：", "");
				if (password === null || password === "") return;
				fetch(USERS_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ username: username.trim(), password: password }),
				})
					.then(function (res) {
						if (!res.ok) throw new Error("HTTP " + res.status);
						return res.json();
					})
					.then(function (body) {
						if (body && body.ok) toast("用户已保存");
						load();
					})
					.catch(function (err) {
						toast("保存用户失败：" + String(err?.message ?? err));
					});
			};

			/** 删除用户。 */
			var removeUser = function (username) {
				if (!window.confirm("确定删除用户 " + username + "？（至少保留一个用户）")) return;
				fetch(USERS_URL, {
					method: "DELETE",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ username: username }),
				})
					.then(function (res) {
						if (!res.ok) throw new Error("HTTP " + res.status);
						return res.json();
					})
					.then(function (body) {
						if (body && body.ok) toast("用户已删除");
						load();
					})
					.catch(function (err) {
						toast("删除用户失败：" + String(err?.message ?? err));
					});
			};

			if (data.status === "loading") {
				return jsxRuntime.jsx("div", { style: { padding: "20px 0", color: "var(--dsw-alias-label-secondary,#888)" }, children: "加载中…" });
			}
			if (data.status === "forbidden") {
				return jsxRuntime.jsx("div", {
					style: {
						padding: "16px",
						borderRadius: "8px",
						background: "rgba(229,72,77,.1)",
						border: "1px solid rgba(229,72,77,.4)",
						fontSize: "13px",
						lineHeight: 1.6,
					},
					children: "「公网访问」控制面板仅限本机（127.0.0.1）使用。请在 http://127.0.0.1 打开设置页。",
				});
			}
			if (data.status === "error") {
				return jsxRuntime.jsx("div", {
					style: { padding: "16px 0", color: "var(--dsw-alias-text-danger,#e5484d)", fontSize: "13px" },
					children: "无法获取公网访问状态：" + data.message,
				});
			}

			var phaseText = {
				stopped: "已停止",
				starting: "启动中…",
				running: "运行中",
				failed: "失败",
			}[data.phase] || data.phase;

			var phaseColor =
				data.phase === "running"
					? "var(--dsw-alias-text-success,#30a46c)"
					: data.phase === "failed"
						? "var(--dsw-alias-text-danger,#e5484d)"
						: "var(--dsw-alias-label-secondary,#888)";

			var rowStyle = {
				display: "flex",
				alignItems: "center",
				gap: "10px",
				padding: "8px 0",
				fontSize: "13px",
				flexWrap: "wrap",
			};
			var btnStyle = {
				padding: "4px 12px",
				borderRadius: "8px",
				border: "1px solid var(--dsw-alias-border-strong,rgba(128,128,128,.35))",
				background: "none",
				cursor: "pointer",
				font: "inherit",
				fontSize: "12px",
				color: "inherit",
			};

			return jsxRuntime.jsx("div", {
				style: { display: "flex", flexDirection: "column", gap: "4px", padding: "4px 0 16px" },
				children: [
					jsxRuntime.jsx("div", {
						style: { fontSize: "13px", color: "var(--dsw-alias-label-secondary,#888)", lineHeight: 1.7 },
						children:
							"把当前 dsh web GUI 暴露到互联网（Cloudflare quick tunnel，无账号/无域名）。任何拿到链接并输入口令的人都能完整操作 agent——请谨慎分享。",
					}),

					// 状态行
					jsxRuntime.jsx("div", {
						style: rowStyle,
						children: [
							jsxRuntime.jsx("span", { style: { fontWeight: 600 }, children: "隧道状态" }),
							jsxRuntime.jsx("span", { style: { color: phaseColor, fontWeight: 600 }, children: phaseText }),
							data.phase === "running" && data.url
								? jsxRuntime.jsx("button", {
										style: btnStyle,
										onClick: function () {
											copyText(data.url);
										},
										children: "复制公网链接",
									})
								: null,
						],
					}),

					// 公网链接
					data.url
						? jsxRuntime.jsx("div", {
								style: rowStyle,
								children: [
									jsxRuntime.jsx("span", { children: "公网链接" }),
									jsxRuntime.jsx("code", {
										style: { wordBreak: "break-all", fontFamily: "monospace", fontSize: "12.5px" },
										children: data.url,
									}),
								],
							})
						: null,

					// 启停
					jsxRuntime.jsx("div", {
						style: rowStyle,
						children: [
							data.phase === "running" || data.phase === "starting"
								? jsxRuntime.jsx("button", {
										style: Object.assign({}, btnStyle, { borderColor: "rgba(229,72,77,.5)", color: "var(--dsw-alias-text-danger,#e5484d)" }),
										onClick: function () {
											act(STOP_URL, "停止隧道");
										},
										children: "停止公网访问",
									})
								: jsxRuntime.jsx("button", {
										style: Object.assign({}, btnStyle, { background: "var(--dsw-alias-accent,#3b82f6)", color: "#fff", borderColor: "transparent" }),
										onClick: function () {
											act(START_URL, "开启隧道");
										},
										children: "开启公网访问",
									}),
						],
					}),

					// 失败原因
					data.phase === "failed" && data.error
						? jsxRuntime.jsx("div", {
								style: { fontSize: "12.5px", color: "var(--dsw-alias-text-danger,#e5484d)", lineHeight: 1.6 },
								children: "失败原因：" + data.error,
							})
						: null,

					// 口令
					jsxRuntime.jsx("div", {
						style: Object.assign({}, rowStyle, { borderTop: "1px solid var(--dsw-alias-divider-strong,rgba(128,128,128,.15))", marginTop: "6px" }),
						children: [
							jsxRuntime.jsx("span", { style: { fontWeight: 600 }, children: "访问口令" }),
							jsxRuntime.jsx("span", {
								style: { fontSize: "12px", opacity: 0.8, fontFamily: "monospace" },
								children: data.tokenConfigured ? "（自动生成，查看后请妥善保管）" : "（配置指定）",
							}),
							jsxRuntime.jsx("button", {
								style: btnStyle,
								onClick: function () {
									fetch(STATUS_URL)
										.then(function (res) {
											return res.ok ? res.json() : null;
										})
										.then(function (body) {
											if (body && body.token) {
												copyText(body.token);
											} else {
												toast("本机可复制口令");
											}
										})
										.catch(function () {
											toast("读取口令失败");
										});
								},
								children: "复制",
							}),
							jsxRuntime.jsx("button", { style: btnStyle, onClick: regenerate, children: "重新生成" }),
						],
					}),

					// 门禁策略
					jsxRuntime.jsx("div", {
						style: Object.assign({}, rowStyle, { fontSize: "12.5px" }),
						children: [
							jsxRuntime.jsx("span", { children: "口令门禁" }),
							jsxRuntime.jsx("span", {
								style: { color: data.requireToken ? "var(--dsw-alias-text-success,#30a46c)" : "var(--dsw-alias-text-danger,#e5484d)" },
								children: data.requireToken ? "已开启（非本机访问需登录）" : "未开启（完全公开，危险）",
							}),
						],
					}),

					// 登录方式
					data.loginMethods
						? jsxRuntime.jsx("div", {
								style: Object.assign({}, rowStyle, { fontSize: "12.5px" }),
								children: [
									jsxRuntime.jsx("span", { children: "登录方式" }),
									jsxRuntime.jsx("span", {
										style: { color: "var(--dsw-alias-label-secondary,#999)" },
										children:
											(data.loginMethods.token ? "访问口令" : "") +
											(data.loginMethods.token && data.loginMethods.password ? " + " : "") +
											(data.loginMethods.password ? "用户名密码" : ""),
									}),
								],
							})
						: null,

					// 用户管理（用户名密码登录）
					jsxRuntime.jsx("div", {
						style: Object.assign({}, rowStyle, { borderTop: "1px solid var(--dsw-alias-divider-strong,rgba(128,128,128,.15))", marginTop: "6px", flexDirection: "column", alignItems: "flex-start", gap: "6px" }),
						children: [
							jsxRuntime.jsx("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }, children: [
								jsxRuntime.jsx("span", { style: { fontWeight: 600 }, children: "登录用户" }),
								(data.users || []).map(function (u) {
									return jsxRuntime.jsx("span", {
										style: {
											fontSize: "12px",
											fontFamily: "monospace",
											padding: "2px 8px",
											borderRadius: "6px",
											background: "var(--dsw-alias-bg-input,#0f1115)",
											border: "1px solid var(--dsw-alias-border-strong,rgba(128,128,128,.3))",
											display: "inline-flex",
											alignItems: "center",
											gap: "6px",
										},
										children: [
											u,
											jsxRuntime.jsx("button", {
												style: Object.assign({}, btnStyle, { padding: "0 4px", fontSize: "11px" }),
												onClick: function () {
													removeUser(u);
												},
												children: "✕",
											}),
										],
									}, u);
								}),
								jsxRuntime.jsx("button", { style: btnStyle, onClick: addUser, children: "添加/修改用户" }),
							]}),
							jsxRuntime.jsx("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary,#aaa)" }, children: "用户名+密码登录的账号；首次启动已自动创建 admin 用户。至少保留一个用户。" }),
						],
					}),

					// 围栏姿态警告
					data.posture && data.posture.exposed
						? jsxRuntime.jsx("div", {
								style: {
									padding: "10px 12px",
									borderRadius: "8px",
									background: "rgba(229,72,77,.12)",
									border: "1px solid rgba(229,72,77,.4)",
									color: "var(--dsw-alias-text-danger,#e5484d)",
									fontSize: "12.5px",
									lineHeight: 1.6,
								},
								children:
									"⚠️ 检测到 SDK 的 /api 围栏对公网主机敞开（可能设置了 --trusted-host 或 --host 0.0.0.0）。口令门禁无法保护直接访问 /api 的调用方，请移除这些 flag 或改用本插件的 /public 通道。",
							})
						: null,

					// 局域网地址
					data.lanAddresses.length > 0
						? jsxRuntime.jsx("div", {
								style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary,#aaa)", marginTop: "4px" },
								children:
									"局域网地址：" +
									data.lanAddresses
										.map(function (ip) {
											return "http://" + ip + ":" + (window.location.port || "80");
										})
										.join("、"),
							})
						: null,
				],
			});
		}

		// ── 门禁启动流程 ────────────────────────────────────────────────────
		function startGateFlow() {
			var loopback = isLoopbackHostname(window.location.hostname);
			if (loopback) return; // 本机回环：直连，无需门禁/通道

			// 非回环 origin：先装 /public 通道（防止早期 SDK 调用逃逸），再探测门禁。
			var restore = installRemoteChannel(window, function () {
				gateOverlay.mount();
			});

			fetch(AUTHORIZED_URL)
				.then(function (res) {
					return res.json().then(function (body) {
						return { ok: res.ok, body: body };
					});
				})
				.then(function (result) {
					if (result.ok && result.body && result.body.ok) {
						// 已授权：通道保持，门禁不出现。
						return;
					}
					gateOverlay.mount();
				})
				.catch(function () {
					// 探测失败（网络/插件未装）：保守起见显示门禁页。
					gateOverlay.mount();
				});

			window.addEventListener("pagehide", function () {
				try {
					restore();
				} catch (_) {}
			});
		}

		// ── 插件 apply ──────────────────────────────────────────────────────
		function apply(ctx) {
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register(
					{
						name: "settings.section",
						id: "internet-access",
						order: 91,
						label: "公网访问",
					},
					PublicAccessCard
				);
			});

			// 门禁流程只跑一次（模块系统可能多次 apply 时保护）。
			if (!window.__dshInternetAccessGateStarted) {
				window.__dshInternetAccessGateStarted = true;
				startGateFlow();
			}
		}
		exports.apply = apply;

		return module.exports;
	},
});
