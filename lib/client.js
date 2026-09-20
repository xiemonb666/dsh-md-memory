// dsh-md-memory client — Memory tab (conversation.view) + Context Weight View
// (VAC-GC STEP 7, plan §96–§101) + composer Memory button.
// Plain JS for window.__ModuleLoader__; React + react/jsx-runtime only (DEC-008).
window.__ModuleLoader__.load({
	id: "dsh-md-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const jsx = require("react/jsx-runtime");
		const { useState, useEffect, useMemo } = React;
		// react/jsx-runtime's jsx/jsxs have the signature (type, config,
		// maybeKey): children MUST live in config.children — a trailing
		// positional argument is read as the element KEY (strings) or
		// ignored (anything after the 3rd param), so raw `jsx(type, props,
		// childA, childB)` silently renders EMPTY elements. Wrap both so the
		// ergonomic `el(type, props, ...children)` call sites below work.
		function e(type, props, ...children) {
			const p = { ...props };
			if (children.length === 1 && Array.isArray(children[0])) p.children = children[0];
			else if (children.length > 0) p.children = children;
			return jsx.jsxs(type, p);
		}
		function e$(type, props, ...children) {
			const p = { ...props };
			if (children.length === 1) p.children = children[0];
			else if (children.length > 1) p.children = children;
			return jsx.jsx(type, p);
		}

		const CHANNEL = "/dsh-md-memory";
		const FILE_LABELS = {
			"INDEX.md": "INDEX · router",
			"PROJECT.md": "PROJECT · requirements",
			"STATE.md": "STATE · current",
			"DECISIONS.md": "DECISIONS",
			"TECH.md": "TECH",
			"HISTORY.md": "HISTORY · append-only",
			"CONFLICTS.md": "CONFLICTS"
		};
		// Keep these explanations in Chinese so a project-memory file is
		// understandable before the user opens it. They are used by the
		// native browser tooltip on both the file list and search hits.
		const FILE_TOOLTIPS = {
			"INDEX.md": "INDEX：项目记忆路由索引，说明每份记忆文件的用途、条目数量和读取入口。",
			"PROJECT.md": "PROJECT：项目目标、需求和范围，说明这项工作要完成什么。",
			"STATE.md": "STATE：项目当前状态、正在进行的任务、已完成事项和下一步。",
			"DECISIONS.md": "DECISIONS：已经确认的方案与决策依据，帮助后续回合保持一致。",
			"TECH.md": "TECH：技术事实、环境配置、版本、路径和可复用约定。",
			"HISTORY.md": "HISTORY：只追加的同步与压缩记录，用来追溯记忆何时以及为什么变化。",
			"CONFLICTS.md": "CONFLICTS：尚未解决的记忆冲突；存在内容分歧时会记录在这里，不能静默覆盖。"
		};
		const fileTooltip = (fileName) => FILE_TOOLTIPS[fileName] ?? `项目记忆文件：${fileName}`;

		function rpc(connection, endpoint, payload) {
			return connection.rpc.call(CHANNEL, endpoint, payload).then((response) => {
				if (response?.ok === true) return response.value;
				const error = new Error(response?.error?.message ?? "request failed");
				// Preserve structured server details (especially settings validation
				// field names) so the panel can point at the exact invalid control.
				error.code = response?.error?.code;
				error.details = response?.error?.details ?? {};
				throw error;
			});
		}

		// The /dsh-md-memory route is registered by the per-session engine
		// constructor, which can lag the first page load after a host
		// restart — an early fetch then hits the web server's static
		// fallback and gets HTTP 405. Retry transport-level failures only
		// (route not ready / host down); server result errors (ok:false
		// envelopes) are final and are not retried. ~10 s of backoff total.
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		async function rpcResilient(connection, endpoint, payload, { attempts = 6, baseMs = 700 } = {}) {
			for (let attempt = 0; ; attempt += 1) {
				try {
					return await rpc(connection, endpoint, payload);
				} catch (error) {
					const message = String(error?.message ?? error);
					const transport = /transport failure|HTTP 404|HTTP 405|HTTP 5\d\d|Failed to fetch|fetch failed|network|ECONNREFUSED|socket|aborted/i.test(message);
					if (!transport || attempt >= attempts - 1) throw error;
					await sleep(baseMs * (attempt + 1));
				}
			}
		}

		function formatTime(value) {
			if (!value) return "-";
			const d = new Date(value);
			if (Number.isNaN(d.getTime())) return "-";
			return d.toLocaleString();
		}

		function formatSize(size) {
			if (size === null || size === undefined) return "";
			if (size < 1024) return `${size} B`;
			return `${(size / 1024).toFixed(1)} KB`;
		}

		function useCurrentSessionId(injectedSessionId, sessions) {
			const current = () => sessions?.list?.getSnapshot?.()?.current ?? injectedSessionId;
			const [sessionId, setSessionId] = useState(current);
			useEffect(() => {
				setSessionId(current());
				return sessions?.list?.subscribe?.(() => setSessionId(current()));
			}, [injectedSessionId, sessions]);
			return sessionId;
		}

		// ------------------------------------------------------------------
		// Memory view (conversation.view slot)
		// ------------------------------------------------------------------
		const MemoryView = (0, React.memo)(function MemoryView({ sessionId: injectedSessionId, sessions, connection, t }) {
			const sessionId = useCurrentSessionId(injectedSessionId, sessions);
			const [status, setStatus] = useState(null);
			const [statusError, setStatusError] = useState(null);
			const [selected, setSelected] = useState(null);
			const [content, setContent] = useState(null);
			const [contentError, setContentError] = useState(null);
			const [query, setQuery] = useState("");
			const [results, setResults] = useState(null);
			const [searching, setSearching] = useState(false);
			const [syncing, setSyncing] = useState(false);
			const [syncNote, setSyncNote] = useState(null);

			const loadStatus = () => {
				if (!connection) return;
				setStatusError(null);
				rpcResilient(connection, "status", sessionId ? { sessionId } : {})
					.then((value) => setStatus(value))
					.catch((error) => setStatusError(String(error?.message ?? error)));
			};
			useEffect(loadStatus, [sessionId, connection]);

			useEffect(() => {
				if (!selected) {
					setContent(null);
					setContentError(null);
					return;
				}
				setContentError(null);
				rpc(connection, "read", { ...(sessionId ? { sessionId } : {}), file: selected })
					.then((value) => setContent(value))
					.catch((error) => setContentError(String(error?.message ?? error)));
			}, [selected, sessionId, connection]);

			useEffect(() => {
				if (!query.trim()) {
					setResults(null);
					setSearching(false);
					return;
				}
				setSearching(true);
				const timer = setTimeout(() => {
					rpc(connection, "search", { ...(sessionId ? { sessionId } : {}), query: query.trim(), limit: 30 })
						// Current hosts return { results }; older builds may return
						// the array directly. Normalize before rendering either shape.
						.then((value) => setResults(Array.isArray(value) ? value : Array.isArray(value?.results) ? value.results : []))
						.catch(() => setResults(null))
						.finally(() => setSearching(false));
				}, 300);
				return () => clearTimeout(timer);
			}, [query, sessionId, connection]);

			const onSync = async () => {
				if (syncing || !connection) return;
				setSyncing(true);
				setSyncNote(null);
				try {
					const value = await rpc(connection, "sync", sessionId ? { sessionId } : {});
					setSyncNote(value?.skipped ? t("note.skipped", { reason: value.skipped }) : t("note.written", { count: (value?.written ?? []).length }));
					loadStatus();
				} catch (error) {
					const message = String(error?.message ?? error);
					if (/a memory sync is already running/i.test(message)) {
						// A sync (e.g. compaction-triggered) is in flight: not
						// an error state — note it neutrally and refresh the
						// status shortly so the result lands without re-clicking.
						setSyncNote(t("note.busy"));
						setTimeout(() => loadStatus(), 5000);
					} else {
						setSyncNote(`error: ${message}`);
					}
				} finally {
					setSyncing(false);
				}
			};

			const styles = useMemo(() => ({
				root: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, gap: 8, padding: 12, boxSizing: "border-box", overflow: "auto" },
				header: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
				badge: (tone) => ({ fontSize: 11, padding: "1px 8px", borderRadius: 999, border: `1px solid ${tone === "ok" ? "rgba(80,200,120,.5)" : tone === "warn" ? "rgba(230,180,60,.5)" : "rgba(127,127,127,.4)"}`, color: tone === "ok" ? "rgba(120,220,160,1)" : tone === "warn" ? "rgba(240,200,90,1)" : "rgba(170,170,170,1)" }),
				dim: { color: "rgba(160,160,160,.9)", fontSize: 12 },
				button: (primary) => ({ cursor: "pointer", fontSize: 12, padding: "3px 12px", borderRadius: 6, border: `1px solid ${primary ? "rgba(100,150,255,.6)" : "rgba(127,127,127,.4)"}`, background: primary ? "rgba(80,130,240,.25)" : "transparent", color: "inherit" }),
				row: { display: "flex", gap: 10, flex: 1, minHeight: 240 },
				left: { width: 300, minWidth: 220, display: "flex", flexDirection: "column", gap: 8, minHeight: 0 },
				right: { flex: 1, display: "flex", flexDirection: "column", gap: 8, minWidth: 0, minHeight: 0 },
				box: { border: "1px solid rgba(127,127,127,.3)", borderRadius: 8, padding: 8, overflow: "auto" },
				input: { width: "100%", boxSizing: "border-box", fontSize: 12, padding: "4px 8px", borderRadius: 6, border: "1px solid rgba(127,127,127,.4)", background: "rgba(127,127,127,.08)", color: "inherit" },
				fileItem: (active) => ({ display: "flex", justifyContent: "space-between", gap: 6, cursor: "pointer", padding: "4px 8px", borderRadius: 6, fontSize: 12, background: active ? "rgba(80,130,240,.2)" : "transparent", border: "1px solid transparent" }),
				pre: { margin: 0, fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace" },
				resultItem: { cursor: "pointer", padding: "3px 6px", borderRadius: 4, fontSize: 12 }
			}), []);

			const body = [];
			if (statusError) body.push(e$("div", { key: "err", style: { color: "rgba(240,120,120,1)", fontSize: 12 } }, statusError));
			if (!status && !statusError) body.push(e$("div", { key: "loading", style: styles.dim }, t("loading")));
			if (status) {
				body.push(
					e("div", { key: "header", style: styles.header },
						e$("span", { style: { fontSize: 13, fontWeight: 600 } }, t("header.title")),
						e$("code", { style: { fontSize: 11, color: "rgba(160,160,160,.9)" } }, status.ledgerDir ?? "-"),
						e$("span", { style: styles.badge(status.exists ? "ok" : "warn") }, status.exists ? t("badge.exists") : t("badge.missing")),
						!status.exists ? e$("span", { style: styles.dim }, t("hint.missing")) : null,
						e$("span", { style: { ...styles.dim, marginLeft: "auto" } }, t("header.synced", { time: formatTime(status.state?.lastSyncMs) })),
						e$("button", { key: "sync", type: "button", style: styles.button(true), disabled: syncing, onClick: onSync }, syncing ? t("button.syncing") : t("button.sync"))
					),
					syncNote ? e$("div", { key: "syncnote", style: styles.dim }, syncNote) : null,
					status.activeConflicts?.length ? e(
						"div", { key: "conflicts", style: { ...styles.box, borderColor: "rgba(230,120,60,.5)" } },
						e$("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 4, color: "rgba(240,170,90,1)" } }, t("conflicts.title", { count: status.activeConflicts.length })),
						e$("div", { style: styles.dim }, status.activeConflicts.map((item) => `${item.id}: ${item.title ?? ""}`).join(" · "))
					) : null
				);
			}
			body.push(
				e("div", { key: "row", style: styles.row },
					e("div", { style: styles.left },
						e$("input", { style: styles.input, placeholder: t("search.placeholder"), value: query, onChange: (event) => setQuery(event.target.value) }),
						results?.length ? e("div", { key: "results", style: styles.box }, results.map((item, index) => e(
							"div", { key: `${item.file}:${item.line}:${index}`, title: fileTooltip(item.file), style: styles.resultItem, onClick: () => setSelected(item.file) },
							e$("span", { style: { color: "rgba(140,170,255,1)" } }, `${item.file}:${item.line}`),
							e$("div", { style: styles.dim }, item.text)
						))) : null,
						status?.exists ? e("div", { key: "files", style: { ...styles.box, display: "flex", flexDirection: "column", gap: 2, flex: 1 } },
							// Only viewer content: the 7 ledger .md files. The
							// engine lists exactly these (older hosts may still
							// include internal files like .gitignore, whose
							// /read throws "unknown ledger file").
							(status.files ?? []).filter((file) => typeof file.name === "string" && file.name.endsWith(".md")).map((file) => e(
								"div", { key: file.name, title: fileTooltip(file.name), style: styles.fileItem(selected === file.name), onClick: () => setSelected(file.name) },
								e$("span", { title: fileTooltip(file.name) }, FILE_LABELS[file.name] ?? file.name),
								e$("span", { style: styles.dim }, formatSize(file.size))
							))
						) : null
					),
					e("div", { style: styles.right },
						e("div", { style: { ...styles.box, flex: 1 } },
							contentError ? e$("div", { style: { color: "rgba(240,120,120,1)", fontSize: 12 } }, contentError) : null,
							content !== null ? e$("pre", { style: styles.pre }, content.content.length > 40000 ? `${content.content.slice(0, 40000)}\n… ${t("viewer.truncated")}` : content.content) : null,
							content === null && !contentError ? e$("div", { style: styles.dim }, selected ? t("loading") : t("viewer.empty")) : null
						)
					)
				)
			);
			return e$("div", { style: styles.root }, ...body);
		});
		// ------------------------------------------------------------------
		// Context view (VAC-GC STEP 7, plan §96–§101 — "Context Weight View"):
		// pressure gauges, tier distribution, per-unit table (unit/tokens/tier/
		// score/reason) and the click-through score breakdown ("why was it
		// compressed?"). Data source: vacgc/plan (latest shadow plan).
		// ------------------------------------------------------------------
		const VACGC_TIERS = ["PINNED", "HOT", "WARM", "COLD", "TRASH"];
		const DEFAULT_CONTINUATION = { enabled: true, maxCount: 3, prompt: "继续" };
		const VACGC_TIER_COLOR = {
			PINNED: "rgba(88,166,255,.95)",
			HOT: "rgba(255,166,87,.95)",
			WARM: "rgba(227,179,65,.95)",
			COLD: "rgba(139,148,158,.95)",
			TRASH: "rgba(98,107,118,.95)"
		};
		const ZONE_TONE = { Z0: "ok", Z1: "ok", Z2: "warn", Z3: "warn", Z4: "err", Z5: "err" };

		function fmtTokens(n) {
			if (n === null || n === undefined || Number.isNaN(n)) return "-";
			if (n < 1000) return String(n);
			return `${(n / 1000).toFixed(1)}K`;
		}
		function fmtPct(x) {
			return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "-";
		}
		function fmtScore(x) {
			return Number.isFinite(x) ? x.toFixed(2) : "-";
		}
		function unitLabel(row) {
			if (row.kind === "tool-pair") return `#${row.firstSeq} ${row.toolName ?? "tool"}`;
			if (row.kind === "checkpoint") return `CP #${row.firstSeq}`;
			if (row.kind === "injected") return `INJ #${row.firstSeq}`;
			return `#${row.firstSeq} ${row.kind}`;
		}
		function unitReason(row) {
			const p = (row.protectionReasons ?? []).filter(Boolean).join("; ");
			return p || row.contentType || "—";
		}

		// §102 — build the sparkline (SVG polyline of input tokens over time,
		// with markers: planned compact / planned fresh-prune / injection
		// spike / degraded sample). Pure element construction (hermetic-test
		// friendly: no DOM APIs).
		function historySpark(points, width, height) {
			if (!Array.isArray(points) || points.length === 0) return null;
			const xs = points.map((p, i) => (points.length === 1 ? width / 2 : (i / (points.length - 1)) * (width - 8) + 4));
			const inMax = Math.max(1, ...points.map((p) => p.in ?? 0));
			const ys = points.map((p) => height - 6 - ((p.in ?? 0) / inMax) * (height - 16) - 4);
			const line = points.map((p, i) => `${xs[i].toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
			const children = [e$("polyline", { key: "line", points: line, fill: "none", stroke: "rgba(120,160,255,.85)", strokeWidth: 1.5 })];
			points.forEach((p, i) => {
				if (p.degraded) children.push(e$("circle", { key: `d${i}`, cx: xs[i], cy: ys[i], r: 2.5, fill: "rgba(150,150,150,.9)", title: "degraded" }));
				if (p.action === "compact") children.push(e$("circle", { key: `c${i}`, cx: xs[i], cy: ys[i], r: 3, fill: "rgba(240,180,60,.95)", title: `history compact (planned) — reclaim ${p.reclaim ?? 0}` }));
				if (p.action === "fresh-prune") children.push(e$("circle", { key: `p${i}`, cx: xs[i], cy: ys[i], r: 3, fill: "rgba(80,200,120,.95)", title: `fresh prune (planned) — ${p.reclaim ?? 0}` }));
				if ((p.inj ?? 0) > 0) children.push(e$("circle", { key: `j${i}`, cx: xs[i], cy: Math.max(4, ys[i] - 7), r: 2 + Math.min(3, (p.inj / 10000)), fill: "rgba(190,120,255,.95)", title: `injection +${p.inj} tokens` }));
			});
			return e$("svg", { viewBox: `0 0 ${width} ${height}`, style: { width: "100%", height: height, display: "block" }, role: "img" }, ...children);
		}

		const ContextView = (0, React.memo)(function ContextView({ sessionId: injectedSessionId, sessions, connection, t }) {
			const sessionId = useCurrentSessionId(injectedSessionId, sessions);
			const [state, setState] = useState(null); // { plan, config, history, error } once loaded
			const [refreshing, setRefreshing] = useState(false);
			const [selectedId, setSelectedId] = useState(null);
			const [settingsDraft, setSettingsDraft] = useState(null);
			const [settingsBusy, setSettingsBusy] = useState(false);
			const [settingsNote, setSettingsNote] = useState(null);

			const load = () => {
				if (!connection) return;
				setRefreshing(true);
				// plan is authoritative (its failure errors the view); history,
				// executed and provenance are nice-to-have (failure → empty
				// section, no error).
				const planReq = rpcResilient(connection, "vacgc/plan", sessionId ? { sessionId } : {}).catch((error) => {
					setState({ plan: null, config: null, history: [], executed: null, provenance: null, error: String(error?.message ?? error) });
					return null;
				});
				const histReq = rpcResilient(connection, "vacgc/history", sessionId ? { sessionId } : {}).catch(() => null);
				const execReq = rpcResilient(connection, "vacgc/executed", sessionId ? { sessionId } : {}).catch(() => null);
				const provReq = rpcResilient(connection, "memory/provenance", sessionId ? { sessionId } : {}).catch(() => null);
				const settingsReq = rpcResilient(connection, "settings/get", { ...(sessionId ? { sessionId } : {}), refresh: true }).catch(() => null);
				const settingsStatusReq = rpcResilient(connection, "settings/status", sessionId ? { sessionId } : {}).catch(() => null);
				Promise.all([planReq, histReq, execReq, provReq, settingsReq, settingsStatusReq]).then(([planValue, histValue, execValue, provValue, settingsValue, settingsStatus]) => {
					if (planValue === null) return; // error already recorded
					setState({
						plan: planValue?.plan ?? null,
						config: planValue?.config ?? null,
						history: Array.isArray(histValue?.points) ? histValue.points : [],
						executed: execValue?.executions ?? null,
						semantic: execValue?.semantic ?? null,
						provenance: provValue?.unresolvedActive ? provValue : null,
						settings: settingsValue,
						settingsStatus,
						error: null
					});
					if (settingsValue?.effective) setSettingsDraft({ ...(settingsValue.configured ?? {}), continuation: { ...(settingsValue.effective.continuation ?? {}) } });
				}).finally(() => setRefreshing(false));
			};
			useEffect(load, [sessionId, connection]);

			const styles = useMemo(() => ({
				root: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, gap: 8, padding: 12, boxSizing: "border-box", overflow: "auto" },
				header: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
				badge: (tone) => ({ fontSize: 11, padding: "1px 8px", borderRadius: 999, border: `1px solid ${tone === "ok" ? "rgba(80,200,120,.5)" : tone === "warn" ? "rgba(230,180,60,.5)" : tone === "err" ? "rgba(240,100,100,.55)" : "rgba(127,127,127,.4)"}`, color: tone === "ok" ? "rgba(120,220,160,1)" : tone === "warn" ? "rgba(240,200,90,1)" : tone === "err" ? "rgba(255,140,140,1)" : "rgba(170,170,170,1)" }),
				dim: { color: "rgba(160,160,160,.9)", fontSize: 12 },
				button: { cursor: "pointer", fontSize: 12, padding: "3px 12px", borderRadius: 6, border: "1px solid rgba(100,150,255,.6)", background: "rgba(80,130,240,.25)", color: "inherit" },
				box: { border: "1px solid rgba(127,127,127,.3)", borderRadius: 8, padding: 8 },
				statGrid: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 },
				statCell: { border: "1px solid rgba(127,127,127,.25)", borderRadius: 6, padding: "6px 8px" },
				statLabel: { fontSize: 10, color: "rgba(160,160,160,.8)", marginBottom: 2 },
				statValue: { fontSize: 13, fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace" },
				tierRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 3 },
				tierBarTrack: { flex: 1, height: 8, borderRadius: 4, background: "rgba(127,127,127,.15)", overflow: "hidden" },
				tierBarFill: { height: "100%", borderRadius: 4 },
				unitHead:{ display: "grid", gridTemplateColumns: "150px 56px 56px 48px 1fr", gap: 8, fontSize: 11, color: "rgba(160,160,160,.8)", padding: "2px 8px", borderBottom: "1px solid rgba(127,127,127,.3)" },
				unitRow: { display: "grid", gridTemplateColumns: "150px 56px 56px 48px 1fr", gap: 8, fontSize: 11, padding: "3px 8px", cursor: "pointer", borderRadius: 4, alignItems: "baseline" },
				unitId: { fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
				unitScore: { fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace" },
				unitReason: { color: "rgba(170,170,170,.9)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
				bdRow: { display: "flex", gap: 8, alignItems: "baseline" },
				pre: { margin: 0, fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace", color: "rgba(200,200,200,.9)" },
				formGrid: { display: "grid", gridTemplateColumns: "repeat(3, minmax(160px, 1fr))", gap: 8 },
				field: { display: "flex", flexDirection: "column", gap: 3, fontSize: 11, color: "rgba(180,180,180,.95)" },
				fieldInput: { width: "100%", boxSizing: "border-box", fontSize: 12, padding: "4px 6px", borderRadius: 5, border: "1px solid rgba(127,127,127,.4)", background: "rgba(127,127,127,.08)", color: "inherit" },
				readOnly: { fontFamily: "ui-monospace, monospace", color: "rgba(180,180,180,.8)" }
			}), []);

			const plan = state?.plan ?? null;
			const settings = state?.settings ?? null;
			const effective = settings?.effective ?? {};
			const draft = settingsDraft ?? {};
			const continuationDraft = draft.continuation ?? effective.continuation ?? DEFAULT_CONTINUATION;
			const setDraftField = (key, value) => setSettingsDraft((old) => ({ ...(old ?? {}), [key]: value }));
			const setContinuationField = (key, value) => setSettingsDraft((old) => ({ ...(old ?? {}), continuation: { ...(old?.continuation ?? {}), [key]: value } }));
			const numberValue = (value) => value === "" ? undefined : Number(value);
			const settingFieldLabel = (field) => ({
				targetContextTokens: t("settings.targetContext"),
				maxOutputTokens: t("settings.maxOutput"),
				safetyMarginTokens: t("settings.safety"),
				thresholdRatio: t("settings.threshold"),
				retainRatio: t("settings.retainRatio"),
				retainTokens: t("settings.retainTokens"),
				compactionRetries: t("settings.compactionRetries"),
				maxOverflowRetries: t("settings.overflowRetries"),
				"continuation.maxCount": t("settings.continuationCount"),
				"continuation.prompt": t("settings.continuationPrompt")
			}[field] ?? field);
			const settingErrorText = (error) => {
				const message = String(error?.message ?? error);
				const field = error?.details?.field;
				return field ? `${settingFieldLabel(field)}：${message}` : message;
			};
			const saveSettings = async () => {
				if (!connection || !settings || settingsBusy) return;
				setSettingsBusy(true);
				setSettingsNote(null);
				try {
					const value = await rpc(connection, "settings/set", { ...(sessionId ? { sessionId } : {}), patch: draft, expectedRevision: settings.revision });
					setSettingsNote(t("settings.saved", { revision: value?.revision ?? "-" }));
					load();
				} catch (error) {
					setSettingsNote(`${t("settings.error")}: ${settingErrorText(error)}`);
				} finally { setSettingsBusy(false); }
			};
			const resetSettings = async () => {
				if (!connection || !settings || settingsBusy) return;
				setSettingsBusy(true);
				setSettingsNote(null);
				try {
					await rpc(connection, "settings/reset", { ...(sessionId ? { sessionId } : {}), expectedRevision: settings.revision });
					setSettingsDraft(null);
					setSettingsNote(t("settings.reset"));
					load();
				} catch (error) {
					setSettingsNote(`${t("settings.error")}: ${settingErrorText(error)}`);
				} finally { setSettingsBusy(false); }
			};
			const input = (label, key, value, onChange, props = {}) => e("label", { key, style: styles.field }, label, e$("input", { type: "number", style: styles.fieldInput, value: value ?? "", onChange: (event) => onChange(numberValue(event.target.value)), ...props }));
			const settingsPanel = settings ? e("div", { key: "settings", style: styles.box },
				e$("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, t("settings.title")),
				e$("div", { style: styles.dim }, `${settings.route?.provider ?? "-"}/${settings.route?.model ?? "-"} · ${t("settings.revision", { revision: settings.revision ?? 0 })}`),
				e$("div", { style: styles.dim, title: t("settings.backendTooltip") }, settings.modelInfo?.stale
					? t("settings.backendStale", { time: formatTime(settings.modelInfo.fetchedAt) })
					: t("settings.backendDynamic", { time: formatTime(settings.modelInfo?.fetchedAt) })),
				e("div", { style: styles.formGrid },
					e$("label", { style: styles.field }, t("settings.hardContext"), e$("input", { style: { ...styles.fieldInput, ...styles.readOnly }, value: settings.hard?.contextWindow ?? "-", readOnly: true })),
					e$("label", { style: styles.field }, t("settings.hardOutput"), e$("input", { style: { ...styles.fieldInput, ...styles.readOnly }, value: settings.hard?.maxTokens ?? "-", readOnly: true })),
					input(t("settings.targetContext"), "targetContextTokens", draft.targetContextTokens ?? effective.targetContextTokens, (v) => setDraftField("targetContextTokens", v)),
					input(t("settings.maxOutput"), "maxOutputTokens", draft.maxOutputTokens ?? effective.maxOutputTokens, (v) => setDraftField("maxOutputTokens", v)),
					input(t("settings.safety"), "safetyMarginTokens", draft.safetyMarginTokens ?? effective.safetyMarginTokens ?? 2048, (v) => setDraftField("safetyMarginTokens", v)),
					input(t("settings.threshold"), "thresholdRatio", draft.thresholdRatio ?? effective.thresholdRatio ?? "", (v) => setDraftField("thresholdRatio", v), { step: "0.01", min: "0.05", max: "0.99" }),
					input(t("settings.retainRatio"), "retainRatio", draft.retainRatio ?? effective.retainRatio ?? "", (v) => setDraftField("retainRatio", v), { step: "0.01", min: "0.01", max: "0.98" }),
					input(t("settings.retainTokens"), "retainTokens", draft.retainTokens ?? effective.retainTokens ?? "", (v) => setDraftField("retainTokens", v)),
					input(t("settings.compactionRetries"), "compactionRetries", draft.compactionRetries ?? effective.compactionRetries ?? 1, (v) => setDraftField("compactionRetries", v), { min: "0", max: "10" }),
					input(t("settings.overflowRetries"), "maxOverflowRetries", draft.maxOverflowRetries ?? effective.maxOverflowRetries ?? 1, (v) => setDraftField("maxOverflowRetries", v), { min: "0", max: "10" }),
				),
				e("div", { style: { ...styles.formGrid, marginTop: 8 } },
					e$("label", { style: styles.field }, t("settings.continuationEnabled"), e$("input", { type: "checkbox", checked: continuationDraft.enabled !== false, onChange: (event) => setContinuationField("enabled", event.target.checked) })),
					input(t("settings.continuationCount"), "continuation.maxCount", continuationDraft.maxCount ?? 3, (v) => setContinuationField("maxCount", v), { min: "0", max: "10" }),
					e$("label", { style: styles.field }, t("settings.continuationPrompt"), e$("input", { style: styles.fieldInput, type: "text", value: continuationDraft.prompt ?? "继续", onChange: (event) => setContinuationField("prompt", event.target.value) }))
				),
				e("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" } },
					e$("button", { type: "button", style: styles.button, disabled: settingsBusy, onClick: saveSettings }, settingsBusy ? t("settings.saving") : t("settings.save")),
					e$("button", { type: "button", style: { ...styles.button, background: "transparent" }, disabled: settingsBusy, onClick: resetSettings }, t("settings.resetButton")),
					e$("span", { style: styles.dim }, t("settings.restartHint")),
					settingsNote ? e$("span", { style: styles.dim }, settingsNote) : null
				),
				state.settingsStatus?.continuation ? e$("div", { style: { ...styles.dim, marginTop: 4 } }, t("settings.lastContinuation", { count: state.settingsStatus.continuation.count ?? 0, reason: state.settingsStatus.continuation.reason ?? "-" })) : null
			) : e("div", { key: "settings-unavailable", style: { ...styles.box, ...styles.dim } }, t("settings.unavailable"));
			const body = [];
			body.push(
				e("div", { key: "header", style: styles.header },
					e$("span", { style: { fontSize: 13, fontWeight: 600 } }, t("ctx.title")),
					e$("span", { style: styles.badge("info") }, plan?.mode ?? "shadow"),
					plan ? e$("span", { style: styles.badge(ZONE_TONE[plan.pressure?.zone] ?? "info") }, plan.pressure?.zone ?? "-") : null,
					plan ? e$("span", { style: { ...styles.dim, marginLeft: "auto" } }, t("ctx.generated", { time: formatTime(plan.generatedAt) })) : null,
					e$("button", { key: "refresh", type: "button", style: styles.button, disabled: refreshing, onClick: load }, refreshing ? t("ctx.refreshing") : t("ctx.refresh"))
				)
			);
			if (state?.error) body.push(e$("div", { key: "err", style: { color: "rgba(240,120,120,1)", fontSize: 12 } }, state.error));
			if (!plan && !state?.error) body.push(e$("div", { key: "empty", style: styles.dim }, state ? t("ctx.noPlan") : t("loading")));
			body.push(settingsPanel);

			// Config gate: vacgcUiEnabled=false → the whole view is disabled
			// (the host still plans in the background; the UI just stays silent).
			if (state?.config?.ui?.enabled === false) {
				body.push(e$("div", { key: "uioff", style: styles.dim }, t("ctx.uiDisabled")));
				return e$("div", { style: styles.root }, ...body);
			}

			if (plan) {
				if (plan.degraded) {
					body.push(e$("div", { key: "deg", style: { ...styles.box, borderColor: "rgba(240,120,60,.5)", color: "rgba(240,170,90,1)", fontSize: 12 } }, t("ctx.degraded", { error: plan.error ?? "" })));
				}
				// §97 — pressure gauges
				const p = plan.pressure ?? {};
				const stat = (key, label, value, tone) => e("div", { key, style: styles.statCell },
					e$("div", { style: styles.statLabel }, t(label)),
					e$("div", { style: { ...styles.statValue, ...(tone ? { color: tone } : {}) } }, value));
				body.push(e("div", { key: "pressure", style: styles.statGrid },
					stat("w", "ctx.window", fmtTokens(p.contextWindow)),
					stat("i", "ctx.input", fmtTokens(p.inputTokens)),
					stat("eo", "ctx.expected", fmtTokens(p.expectedOutput)),
					stat("ir", "ctx.reserve", fmtTokens(p.injectionReserve)),
					stat("sm", "ctx.safety", fmtTokens(p.safetyMargin)),
					stat("soft", "ctx.soft", fmtPct(p.soft)),
					stat("hard", "ctx.hard", fmtPct(p.hard), p.hard >= 0.94 ? "rgba(240,120,120,1)" : undefined),
					stat("zone", "ctx.zone", p.zone ?? "-")
				));
				// §98 — tier distribution
				const tiers = plan.tiers ?? {};
				const maxTierTokens = Math.max(1, ...VACGC_TIERS.map((k) => tiers[k]?.tokens ?? 0));
				body.push(e("div", { key: "tiers", style: styles.box },
					e$("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, t("ctx.tiers")),
					VACGC_TIERS.map((k) => {
						const s = tiers[k] ?? { count: 0, tokens: 0 };
						return e("div", { key: k, style: styles.tierRow },
							e$("span", { style: { width: 56, fontSize: 11, fontFamily: "ui-monospace, monospace" } }, k),
							e("div", { style: styles.tierBarTrack }, e$("div", { style: { ...styles.tierBarFill, width: `${Math.max(s.tokens > 0 ? 2 : 0, (s.tokens / maxTierTokens) * 100)}%`, background: VACGC_TIER_COLOR[k] } })),
							e$("span", { style: { width: 96, fontSize: 11, textAlign: "right", color: "rgba(170,170,170,.9)" } }, `${s.count} · ${fmtTokens(s.tokens)}`)
						);
					})
				));
				// §99 — context unit table
				const units = plan.units ?? [];
				const unitCount = plan.unitCount ?? units.length;
				body.push(e("div", { key: "units", style: styles.box },
					e$("div", { title: t("ctx.units.tooltip", { count: unitCount }), style: { fontSize: 12, fontWeight: 600, marginBottom: 6, cursor: "help" } }, t("ctx.units", { count: unitCount })),
					e("div", { key: "head", style: styles.unitHead },
						e$("span", { title: t("ctx.unit.tooltip"), style: { cursor: "help" } }, t("ctx.unit")),
						e$("span", { title: t("ctx.tokens.tooltip"), style: { cursor: "help" } }, t("ctx.tokens")),
						e$("span", { title: t("ctx.tier.tooltip"), style: { cursor: "help" } }, t("ctx.tier")),
						e$("span", { title: t("ctx.score.tooltip"), style: { cursor: "help" } }, t("ctx.score")),
						e$("span", { title: t("ctx.reason.tooltip"), style: { cursor: "help" } }, t("ctx.reason"))
					),
					units.map((row) => {
						const tags = [];
						if (row.inRecentFloor) tags.push(t("ctx.floor"));
						if (row.open) tags.push(t("ctx.open"));
						if (row.protection && row.protection !== "NORMAL") tags.push(row.protection);
						const label = unitLabel(row);
						const reason = `${unitReason(row)}${tags.length ? ` · ${tags.join(" · ")}` : ""}`;
						return e("div", {
							key: row.unitId,
							style: { ...styles.unitRow, background: selectedId === row.unitId ? "rgba(80,130,240,.18)" : undefined },
							onClick: () => setSelectedId(selectedId === row.unitId ? null : row.unitId)
						},
							e$("span", { title: `${t("ctx.unit.tooltip")}\n${label}`, style: styles.unitId }, label),
							e$("span", { title: `${t("ctx.tokens.tooltip")}\n${fmtTokens(row.tokens)}` }, fmtTokens(row.tokens)),
							e$("span", { title: `${t("ctx.tier.tooltip")}\n${row.tier}`, style: { color: VACGC_TIER_COLOR[row.tier], cursor: "help" } }, row.tier),
							e$("span", { title: `${t("ctx.score.tooltip")}\n${fmtScore(row.score)}`, style: { ...styles.unitScore, cursor: "help" } }, fmtScore(row.score)),
							e$("span", { title: `${t("ctx.reason.tooltip")}\n${reason}`, style: styles.unitReason }, reason)
						);
					})
				));
				// §100 — "why was it compressed?" score breakdown
				const sel = units.find((row) => row.unitId === selectedId) ?? null;
				if (sel) {
					const f = sel.features ?? {};
					const line = (label, value) => e("div", { key: label, style: styles.bdRow },
						e$("span", { style: { width: 130, fontSize: 11, color: "rgba(170,170,170,.9)" } }, t(label)),
						e$("span", { style: { fontSize: 11, fontFamily: "ui-monospace, monospace" } }, value));
					body.push(e("div", { key: "why", style: { ...styles.box, borderColor: "rgba(100,150,255,.5)" } },
						e$("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, t("ctx.why", { unit: unitLabel(sel) })),
						line("ctx.f.intrinsic", fmtScore(f.intrinsic)),
						line("ctx.f.relevance", fmtScore(f.taskRelevance)),
						line("ctx.f.recency", fmtScore(f.recency)),
						line("ctx.f.dependency", fmtScore(f.dependency)),
						line("ctx.f.reconstruct", fmtScore(f.reconstructibility)),
						line("ctx.f.duplication", fmtScore(f.duplication)),
						line("ctx.f.size", fmtScore(f.sizePenalty)),
						line("ctx.final", fmtScore(sel.score)),
						e("div", { key: "dec", style: { ...styles.bdRow, marginTop: 6 } },
							e$("span", { style: { width: 130, fontSize: 11, color: "rgba(170,170,170,.9)" } }, t("ctx.decision")),
							e$("span", { style: { fontSize: 11, fontWeight: 600, color: VACGC_TIER_COLOR[sel.tier] } }, `${sel.tier}${sel.protection && sel.protection !== "NORMAL" ? ` (${sel.protection})` : ""}`)
						),
						(sel.protectionReasons?.length || sel.notes?.length) ? e("div", { key: "reason", style: { ...styles.pre, marginTop: 6, maxHeight: 160, overflow: "auto" } },
							[...(sel.protectionReasons ?? []).map((r) => `• ${r}`), ...(sel.notes ?? [])].join("\n")) : null
					));
				}
				// decision line (observation aid for STEP 8)
				const fp = plan.freshPrune;
				const fpReduce = fp?.actions?.filter((a) => a.kind === "reduce").length ?? 0;
				const fpDrop = fp?.actions?.filter((a) => a.kind === "drop").length ?? 0;
				body.push(e$("div", { key: "decisionline", style: styles.dim },
					`${t("ctx.decision.line", { action: plan.decision?.action ?? "none" })} — ${plan.decision?.reason ?? ""}`
					+ (plan.selected ? ` · ${t("ctx.selectedSeg", { tokens: fmtTokens(plan.selected.reclaimTokens) })}` : "")
					+ (plan.pruneCandidates?.length ? ` · ${t("ctx.prune", { count: plan.pruneCandidates.length })}` : "")
					+ ((fpReduce || fpDrop) ? ` · ${t("ctx.freshPrune", { reduce: fpReduce, drop: fpDrop, tokens: fmtTokens(fp.totalReclaim) })}` : "")
				));
				// PLAN vs EXECUTED: show the planner's selected segment alongside
				// official prefix compactions, semantic Phase 3 commits, and landed
				// TRASH prunes.
				const ex = state?.executed ?? null;
				const exTime = (at) => (typeof at === "string" && at ? new Date(at).toLocaleTimeString() : "—");
				body.push(e("div", { key: "executed", style: styles.box },
					e$("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, t("ctx.executed.title")),
					e$("div", { style: styles.dim }, t("ctx.executed.plan", { action: plan.decision?.action ?? "none" })),
					e$("div", { style: styles.dim }, t("ctx.executed.official", { count: ex?.official?.count ?? 0, at: exTime(ex?.official?.at) })),
					e$("div", { style: styles.dim }, t("ctx.executed.semantic", { count: ex?.semantic?.count ?? 0, at: exTime(ex?.semantic?.at) })),
					e$("div", { style: styles.dim }, t("ctx.executed.prune", { count: ex?.prune?.count ?? 0, at: exTime(ex?.prune?.at) })),
						e$("div", { style: { ...styles.dim, marginTop: 4 } }, t("ctx.executed.note"))
				));
				const semanticState = state?.semantic;
				if (semanticState) body.push(e$("div", { key: "semantic-state", style: styles.dim }, t("ctx.executed.state", { status: semanticState.status ?? "—", reason: semanticState.reason ? ` · ${semanticState.reason}` : "" })));
				// P0.5 — provenance gap: ACTIVE entries without a resolved
				// evidence binding (degraded state — conservative P1 hold on
				// lexically-related units until a sync repairs the sidecar).
				const prov = state?.provenance ?? null;
				const provIds = Array.isArray(prov?.unresolvedActive) ? prov.unresolvedActive : [];
				if (provIds.length > 0) {
					body.push(e$("div", { key: "provgap", style: { ...styles.box, borderColor: "rgba(255,170,60,.55)" } },
						e$("div", { style: styles.dim }, t("ctx.provenance.gap", { count: provIds.length, ids: `${provIds.slice(0, 6).join(", ")}${provIds.length > 6 ? "…" : ""}` }))
					));
				}
				// §103 metrics (planned outcome in shadow — §101 Before/After/Saved wording)
				const m = plan.metrics;
				if (m) {
					body.push(e$("div", { key: "metrics1", style: styles.dim },
						t("ctx.m.before", { tokens: fmtTokens(m.tokensBefore) }) + " · "
						+ t("ctx.m.after", { tokens: fmtTokens(m.tokensAfter) }) + " · "
						+ t("ctx.m.saved", { tokens: fmtTokens(m.reclaim) }) + " · "
						+ t("ctx.m.avg", { score: fmtScore(m.averageScore) })
					));
					body.push(e$("div", { key: "metrics2", style: styles.dim },
						t("ctx.m.candidates", { count: m.candidateCount }) + " · "
						+ t("ctx.m.rejected", { p0: m.rejectedByP0, floor: m.rejectedByRecentFloor, tier: m.rejectedByTier }) + " · "
						+ t("ctx.m.protection", { p0: m.P0Count, p1: m.P1Count })
						+ (m.pressureAfter ? ` · ${t("ctx.m.pressure", { soft: fmtPct(m.pressureAfter.soft), zone: m.pressureAfter.zone })}` : "")
					));
				}
				// §102 — Context History: shadow-plan ring (vacgc/history).
				// Phase 1 markers are PLANNED actions (nothing is executed);
				// the point shape already reserves the fields execution adds.
				const pts = (state?.history ?? []).filter((pt) => pt && typeof pt === "object");
				body.push(e("div", { key: "history", style: styles.box },
					e$("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, t("ctx.hist")),
					pts.length >= 2 ? historySpark(pts, 320, 64) : e$("div", { style: styles.dim }, t("ctx.hist.empty")),
					pts.length >= 2 ? e$("div", { style: { ...styles.dim, marginTop: 4 } }, t("ctx.hist.legend", {
						compact: pts.filter((pt) => pt.action === "compact").length,
						prune: pts.filter((pt) => pt.action === "fresh-prune").length,
						inj: pts.filter((pt) => (pt.inj ?? 0) > 0).length,
						deg: pts.filter((pt) => pt.degraded).length
					})) : null
				));
			}
			return e$("div", { style: styles.root }, ...body);
		});

		// ------------------------------------------------------------------
		// Composer action button
		// ------------------------------------------------------------------
		function openMemoryTab(t) {
			const label = t("tab.label").trim();
			[...document.querySelectorAll('[role="tab"]')].find((candidate) => candidate.textContent?.trim() === label)?.click();
		}
		const MemoryButton = (0, React.memo)(function MemoryButton({ t }) {
			return e$("button", {
				type: "button",
				title: t("tab.tooltip"),
				style: { cursor: "pointer", fontSize: 12, padding: "2px 10px", borderRadius: 6, border: "1px solid rgba(127,127,127,.4)", background: "transparent", color: "inherit" },
				onClick: () => openMemoryTab(t)
			}, t("tab.button"));
		});

		// ------------------------------------------------------------------
		// Locale + apply
		// ------------------------------------------------------------------
		const zh = {
			"tab.label": "项目记忆",
			"tab.button": "记忆",
			"tab.tooltip": "查看/同步 .dsh-memory 项目记忆台账",
			"header.title": "Markdown Memory Ledger",
			"header.synced": "上次同步 {time}",
			"badge.exists": "已初始化",
			"badge.missing": "未初始化",
			"hint.missing": "首次同步或压缩时自动创建",
			"button.sync": "立即同步",
			"button.syncing": "同步中…",
			"note.written": "同步完成，写入 {count} 个文件",
			"note.skipped": "跳过：{reason}",
			"note.busy": "已有同步正在进行中 — 完成后状态会自动刷新",
			"conflicts.title": "{count} 个活动冲突（CONFLICTS.md）",
			"search.placeholder": "搜索台账…",
			"viewer.empty": "选择左侧文件查看内容",
			"viewer.truncated": "（内容已截断）",
			"loading": "加载中…",
			"ctx.tab": "上下文",
			"ctx.title": "上下文权重视图",
			"ctx.refresh": "刷新",
			"ctx.refreshing": "刷新中…",
			"ctx.generated": "计划 {time}",
			"ctx.noPlan": "尚无影子计划 — 观测器在回合结束/压缩前运行；若宿主尚未加载 VAC-GC，需重启宿主。",
			"ctx.degraded": "规划器降级为 no-op：{error}",
			"ctx.window": "窗口",
			"ctx.input": "当前输入",
			"ctx.expected": "预期输出",
			"ctx.reserve": "注入保留",
			"ctx.safety": "安全余量",
			"ctx.soft": "软压力",
			"ctx.hard": "硬压力",
			"ctx.zone": "区间",
			"ctx.tiers": "Tier 分布",
			"ctx.units": "上下文单元 {count}",
			"ctx.units.tooltip": "这里显示当前计划识别出的 {count} 个上下文单元；单元是压缩器评估和保留的最小连续事件组。",
			"ctx.unit": "单元",
			"ctx.unit.tooltip": "单元：一组连续的会话事件，例如用户消息、工具调用与工具结果；压缩时尽量保持完整。",
			"ctx.tokens": "Tokens",
			"ctx.tokens.tooltip": "Tokens：该单元估算占用的输入上下文 token 数，不是输出 token 数。",
			"ctx.tier": "Tier",
			"ctx.tier.tooltip": "Tier：按价值、近期性、依赖关系和可重建性分出的保留层级；PINNED/HOT 更应保留，TRASH 更适合回收。",
			"ctx.score": "分数",
			"ctx.score.tooltip": "分数：0 到 1 的综合保留价值分数，越高越不应被压缩。",
			"ctx.reason": "原因",
			"ctx.reason.tooltip": "原因：影响该单元 Tier、分数和压缩候选资格的主要保护理由或内容类型。",
			"ctx.floor": "近期窗口保护",
			"ctx.open": "未闭合工具对",
			"ctx.why": "为什么压缩 {unit}",
			"ctx.f.intrinsic": "固有价值",
			"ctx.f.relevance": "任务相关",
			"ctx.f.recency": "新近度",
			"ctx.f.dependency": "依赖度",
			"ctx.f.reconstruct": "可重建性",
			"ctx.f.duplication": "重复度",
			"ctx.f.size": "体积惩罚",
			"ctx.final": "最终分数",
			"ctx.decision": "判定",
			"ctx.decision.line": "决策 {action}",
			"ctx.selectedSeg": "选中段可回收 {tokens}",
			"ctx.prune": "剪枝候选 {count}",
			"ctx.freshPrune": "剪枝预案 {reduce} 缩减 + {drop} 去重 ≈ {tokens}",
			"ctx.executed.title": "计划 vs 执行",
			"ctx.executed.plan": "计划（影子，建议性）：{action}",
			"ctx.executed.official": "已执行 · 官方压缩（前缀摘要）：{count} 次 · 最近 {at}",
			"ctx.executed.prune": "已执行 · VAC-GC 剪枝（TRASH 微剪）：{count} 项 · 最近 {at}",
			"ctx.executed.semantic": "已执行 · VAC-GC 语义压缩（加权区段 + 事实校验）：{count} 次 · 最近 {at}",
			"ctx.executed.note": "说明：语义压缩先做 P0/P1 精确事实覆盖校验，失败自动回退官方压缩。",
			"ctx.executed.state": "语义链路：{status}{reason}",
			"ctx.provenance.gap": "证据缺口：{count} 条 ACTIVE 条目暂无已解析的原始证据绑定（{ids}）— 相关候选按 P1 保守保护（多留、不误删），下次同步可自动修复",
			"ctx.m.before": "Before {tokens}",
			"ctx.m.after": "After {tokens}",
			"ctx.m.saved": "Saved {tokens}",
			"ctx.m.avg": "平均价值 {score}",
			"ctx.m.candidates": "候选 {count}",
			"ctx.m.rejected": "拒绝: P0 {p0} · 近期窗口 {floor} · 层级 {tier}",
			"ctx.m.protection": "P0 {p0} / P1 {p1}",
			"ctx.m.pressure": "压缩后压力 {soft} ({zone})",
			"ctx.hist": "上下文历史",
			"ctx.hist.empty": "历史收集中 — 每个影子计划追加一个采样点（影子模式下所有标记均为「计划」动作）",
			"ctx.hist.legend": "紧凑(计划) {compact} · 修剪(计划) {prune} · 注入 {inj} · 降级 {deg}",
			"ctx.uiDisabled": "VAC-GC UI 已禁用（配置 ui.enabled = false）— 后台规划仍在进行",
			"settings.title": "预算与压缩设置",
			"settings.revision": "配置版本 {revision}",
			"settings.hardContext": "模型硬上下文上限",
			"settings.hardOutput": "路由最大输出",
			"settings.backendDynamic": "后端动态读取，最近更新 {time}",
			"settings.backendStale": "后端暂时不可用，沿用最近一次能力值（{time}）",
			"settings.backendTooltip": "上下文长度来自 DSH 后端当前 provider/model 路由；刷新设置时会重新读取，运行中按短缓存自动更新。",
			"settings.targetContext": "插件目标上下文",
			"settings.maxOutput": "默认最大输出",
			"settings.safety": "安全余量 tokens",
			"settings.threshold": "压缩阈值比例",
			"settings.retainRatio": "保留比例",
			"settings.retainTokens": "保留 tokens（优先）",
			"settings.compactionRetries": "压缩重试次数",
			"settings.overflowRetries": "溢出重试次数",
			"settings.continuationEnabled": "撞顶自动续写",
			"settings.continuationCount": "续写最多次数",
			"settings.continuationPrompt": "续写提示词",
			"settings.save": "保存设置",
			"settings.saving": "保存中…",
			"settings.resetButton": "恢复默认",
			"settings.restartHint": "预算保护立即生效；模型/原生压缩字段对新会话生效",
			"settings.saved": "已保存（版本 {revision}）",
			"settings.reset": "已恢复默认",
			"settings.error": "设置失败",
			"settings.lastContinuation": "最近续写：{count} 次，状态 {reason}",
			"settings.unavailable": "当前宿主没有设置服务；保留插件默认行为"
		};
		const en = {
			"tab.label": "Project Memory",
			"tab.button": "Memory",
			"tab.tooltip": "View/sync the .dsh-memory project ledger",
			"header.title": "Markdown Memory Ledger",
			"header.synced": "last sync {time}",
			"badge.exists": "initialized",
			"badge.missing": "not initialized",
			"hint.missing": "created on first sync/compaction",
			"button.sync": "Sync now",
			"button.syncing": "Syncing…",
			"note.written": "sync done, {count} file(s) written",
			"note.skipped": "skipped: {reason}",
			"note.busy": "a sync is already running — status refreshes when it finishes",
			"conflicts.title": "{count} active conflict(s) (CONFLICTS.md)",
			"search.placeholder": "Search ledger…",
			"viewer.empty": "Select a file to view",
			"viewer.truncated": "(content truncated)",
			"loading": "Loading…",
			"ctx.tab": "Context",
			"ctx.title": "Context Weight View",
			"ctx.refresh": "Refresh",
			"ctx.refreshing": "Refreshing…",
			"ctx.generated": "plan {time}",
			"ctx.noPlan": "No shadow plan yet — the observer runs at turn end / pre-compact; restart the host if VAC-GC is not loaded.",
			"ctx.degraded": "Planner degraded to no-op: {error}",
			"ctx.window": "Window",
			"ctx.input": "Current Input",
			"ctx.expected": "Expected Output",
			"ctx.reserve": "Injection Reserve",
			"ctx.safety": "Safety",
			"ctx.soft": "Soft Pressure",
			"ctx.hard": "Hard Pressure",
			"ctx.zone": "Zone",
			"ctx.tiers": "Tier Distribution",
			"ctx.units": "Context Units {count}",
			"ctx.units.tooltip": "The {count} context units recognized by the current plan; each is the smallest contiguous event group evaluated for retention or compaction.",
			"ctx.unit": "Unit",
			"ctx.unit.tooltip": "Unit: a contiguous group of session events, such as a user message or a tool call/result pair, kept intact during compaction when possible.",
			"ctx.tokens": "Tokens",
			"ctx.tokens.tooltip": "Tokens: estimated input-context tokens occupied by this unit, not output tokens.",
			"ctx.tier": "Tier",
			"ctx.tier.tooltip": "Tier: the retention layer derived from value, recency, dependencies, and reconstructibility; PINNED/HOT are safer to keep and TRASH is easiest to reclaim.",
			"ctx.score": "Score",
			"ctx.score.tooltip": "Score: a 0–1 combined retention-value score; higher scores are less suitable for compaction.",
			"ctx.reason": "Reason",
			"ctx.reason.tooltip": "Reason: the main protection reason or content type that affects this unit's tier, score, and compaction eligibility.",
			"ctx.floor": "in recent floor",
			"ctx.open": "open tool pair",
			"ctx.why": "Why: {unit}",
			"ctx.f.intrinsic": "Intrinsic",
			"ctx.f.relevance": "Task relevance",
			"ctx.f.recency": "Recency",
			"ctx.f.dependency": "Dependency",
			"ctx.f.reconstruct": "Reconstructibility",
			"ctx.f.duplication": "Duplication",
			"ctx.f.size": "Size penalty",
			"ctx.final": "Final",
			"ctx.decision": "Decision",
			"ctx.decision.line": "Decision {action}",
			"ctx.selectedSeg": "selected segment reclaims {tokens}",
			"ctx.prune": "prune candidates {count}",
			"ctx.freshPrune": "prune plan: {reduce} reduce + {drop} drop ≈ {tokens}",
			"ctx.executed.title": "Plan vs Executed",
			"ctx.executed.plan": "Planned (shadow, advisory): {action}",
			"ctx.executed.official": "Executed · official compaction (prefix summary): {count}× · last {at}",
			"ctx.executed.prune": "Executed · VAC-GC prune (TRASH micro-prune): {count} action(s) · last {at}",
			"ctx.executed.semantic": "Executed · VAC-GC semantic compaction (weighted segment + fact coverage): {count}× · last {at}",
			"ctx.executed.note": "Note: semantic compaction verifies exact P0/P1 facts first and falls back to official compaction on failure.",
			"ctx.executed.state": "Semantic path: {status}{reason}",
			"ctx.provenance.gap": "Provenance gap: {count} ACTIVE entr(y/ies) without resolved evidence bindings ({ids}) — related candidates held at P1 (keep more, never delete wrongly); the next sync may repair automatically",
			"ctx.m.before": "Before {tokens}",
			"ctx.m.after": "After {tokens}",
			"ctx.m.saved": "Saved {tokens}",
			"ctx.m.avg": "Avg importance {score}",
			"ctx.m.candidates": "candidates {count}",
			"ctx.m.rejected": "rejected: P0 {p0} · floor {floor} · tier {tier}",
			"ctx.m.protection": "P0 {p0} / P1 {p1}",
			"ctx.m.pressure": "pressure after {soft} ({zone})",
			"ctx.hist": "Context History",
			"ctx.hist.empty": "collecting — each shadow plan appends a sample (in shadow mode all markers are PLANNED actions)",
			"ctx.hist.legend": "compact (planned) {compact} · prune (planned) {prune} · injection {inj} · degraded {deg}",
			"ctx.uiDisabled": "VAC-GC UI disabled (config ui.enabled = false) — background planning continues",
			"settings.title": "Budget & Compaction Settings",
			"settings.revision": "config revision {revision}",
			"settings.hardContext": "Model hard context limit",
			"settings.hardOutput": "Route max output",
			"settings.backendDynamic": "Read dynamically from backend; updated {time}",
			"settings.backendStale": "Backend unavailable; using last known capacity ({time})",
			"settings.backendTooltip": "Context capacity comes from the current DSH provider/model route; refresh reads it again and normal turns update it on a short TTL.",
			"settings.targetContext": "Plugin target context",
			"settings.maxOutput": "Default max output",
			"settings.safety": "Safety margin tokens",
			"settings.threshold": "Compaction threshold ratio",
			"settings.retainRatio": "Retain ratio",
			"settings.retainTokens": "Retain tokens (priority)",
			"settings.compactionRetries": "Compaction retries",
			"settings.overflowRetries": "Overflow retries",
			"settings.continuationEnabled": "Auto-continue at output limit",
			"settings.continuationCount": "Maximum continuations",
			"settings.continuationPrompt": "Continuation prompt",
			"settings.save": "Save settings",
			"settings.saving": "Saving…",
			"settings.resetButton": "Reset defaults",
			"settings.restartHint": "Budget protection is live; model/native compaction fields apply to new sessions",
			"settings.saved": "Saved (revision {revision})",
			"settings.reset": "Defaults restored",
			"settings.error": "Settings failed",
			"settings.lastContinuation": "Last continuation: {count}, status {reason}",
			"settings.unavailable": "The host has no settings service; plugin defaults remain active"
		};

		function apply(ctx) {
			const namespace = "mdMemory";
			ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "dsh-md-memory: locale");
			const t = ctx.locale.bind(namespace);
			ctx.effect(() => {
				const disposeView = ctx.slots.inject("conversation.view", () => ctx.slots.register({
					name: "conversation.view",
					id: "mdMemory",
					order: 40,
					label: () => t("tab.label"),
					locale: namespace,
					inject: (sessionId) => ({
						...typeof sessionId === "string" && sessionId !== "" ? { sessionId } : {},
						sessions: ctx.sessions,
						connection: ctx.connection,
						t
					})
				}, MemoryView));
				const disposeContextView = ctx.slots.inject("conversation.view", () => ctx.slots.register({
					name: "conversation.view",
					id: "mdMemoryCtx",
					order: 41,
					label: () => t("ctx.tab"),
					locale: namespace,
					inject: (sessionId) => ({
						...typeof sessionId === "string" && sessionId !== "" ? { sessionId } : {},
						sessions: ctx.sessions,
						connection: ctx.connection,
						t
					})
				}, ContextView));
				const disposeAction = ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
					name: "conversation.chat.assistant-actions",
					id: "md-memory",
					order: 95,
					locale: namespace,
					inject: (sessionId) => ({
						...typeof sessionId === "string" && sessionId !== "" ? { sessionId } : {},
						connection: ctx.connection,
						t
					})
				}, MemoryButton));
				return () => {
					disposeAction();
					disposeContextView();
					disposeView();
				};
			}, "dsh-md-memory: ui slots");

		}

		exports.apply = apply;
		exports.inject = ["slots", "sessions", "connection", "locale"];
		return module.exports;
	}
});
