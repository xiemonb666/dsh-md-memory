/**
 * dsh-md-memory — root bundle entry (module face, exports["."]).
 *
 * WHY THIS MODULE EXISTS (2026-09-05, "Context tab never appears" root cause):
 *
 * The host's ClientModuleRegistry (@deepseek-ai/dsh-client-modules) builds the
 * browser boot manifest — `window.__DSH_BOOT__.entries`, the client modules the
 * page preloads from `/plugins/??<id>/client.js…` — from ROOT loader rows only:
 * each row's package manifest is resolved and a client entry is registered when
 * the package declares a `dsh.client` half (platform "web"). A package that is
 * imported only by per-session preset rows is invisible to that scan. dsh-md-
 * memory previously had no root row (its patch layer was []), so lib/client.js
 * — which registers the 项目记忆 / 上下文 conversation tabs — was never served
 * to the browser, in any session, in any shell mode.
 *
 * The row this module backs lives in cordis.patch.yml:
 *   - insert:
 *       - id: md-memory-root
 *         name: dsh-md-memory
 *
 * It imports the package main export (this file). Behavior: idempotent,
 * failure-tolerant MML preset provisioning — the exact same function the
 * engine calls in its (per-session) constructor — plus one startup log line.
 * No services, no listeners, no compaction behavior: all per-session work
 * stays in lib/index.js, mounted by the standard-mml / minimal-mml preset
 * rows through the `dsh-md-memory/engine` subpath export.
 *
 * Contract mirrors the shipped dsh-free-search plugin module face: named
 * exports `name`, `inject`, `Config`, `apply(ctx, config)`.
 */
import z from "@deepseek-ai/schemastery";
import { provisionMmlPresets } from "./index.js";
import { installSettings } from "./settings.js";

const name = "md-memory-root";
const inject = [];
const Config = z.object({});

function apply(ctx, _config) {
	// Idempotent and failure-tolerant by construction (never throws): derives
	// the standard-mml / minimal-mml presets from the host's builtins and
	// leaves the user's default preset unchanged. Running this at the root
	// realm guarantees the presets exist before any session realm is built.
	provisionMmlPresets(ctx);
	// The settings service is optional on older DSH builds.  The engine keeps
	// its existing in-code defaults when it is absent, while newer hosts get a
	// profile-persisted route budget namespace before session realms mount.
	installSettings(ctx);
	ctx.logger.info("md-memory-root: bundle entry active (preset provisioning complete)");
}

export { name, inject, Config, apply };
