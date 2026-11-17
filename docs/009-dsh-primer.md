# 009 A DSH primer

This plugin is a DSH bundle, so reading it means reading two things at once: the team agent, and the harness it lives in. The other documents assume the harness. This one explains the ten harness concepts the code uses and the four APIs no other document names.

## Ten concepts

**1. Bundle and profile.** A DSH installation runs *profiles*; a profile is a directory whose `cordis.patch.yml` lists the plugins to mount. This package is one entry in that list (`id: dsh-superagent`) plus a client entry for the panel. Installing this repository into a profile is what `SETUP.md` does; nothing here is a standalone server.

**2. Plugin.** A package that exports `name`, optional `inject`, and `apply(ctx, config)`. See `src/index.ts`: it mounts `Runtime` and registers the dispose hook. `Config` is the schema DSH validates the profile's YAML block against.

**3. Context.** The `ctx` passed to `apply` and to every `Service` constructor. It is a service registry with a lifetime: `ctx.<service>` or `ctx.get('name')` returns a mounted service; `ctx.logger`, `ctx.effect` and `ctx.inject` are on it too.

**4. Service.** A class that registers itself on the context under a name, so other plugins can require it. `Runtime` is one (`super(ctx, 'orchestrator')`), and `src/app/runtime.ts` declares the typing with `declare module '@deepseek-ai/cordis'`. When this document says "the `SourceHost` service", it means that registration, not an HTTP host.

**5. Effect and disposal.** `ctx.effect(() => dispose)` ties a resource to the plugin's lifetime; `ctx.effect(() => () => cleanup)` is the async form. Every registration in this repository — a Source kind, a tool, a locale dictionary, a timer — is wrapped so a restart or unload cleans it up. A leaked registration is why a reloaded plugin suddenly registers twice.

**6. Fiber and restart.** A plugin instance runs in a *fiber*. `ctx.fiber.restart()` tears the plugin down and applies it again with the same configuration; this is how a deployment change (a new GitHub account, a new Feishu app) takes effect without restarting DSH. `src/index.ts` exposes that call to the Runtime, and the settings path calls it.

**7. Injection.** `inject` lists the services a plugin cannot work without; DSH applies the plugin only once they are mounted, and re-applies it if one goes away. `ctx.inject(['settings'], child => …)` does the same for an optional dependency at runtime.

**8. Session and Agent.** A DSH *Session* is a conversation with history and a workspace; an *Agent* is the running thing that answers in it. `ctx.sessionController` creates, resolves and renames them, and holds their model catalogue. Two roles exist here: the main Session (`mainSessionId`) and one Session per Assignment (a worker). `src/app/sessions.ts` owns both.

**9. Tools.** `ctx.tools.register({ name, description, parameters, execute })`, where `parameters` is a JSON Schema (`z.toJSONSchema` over a zod schema) and `execute` returns a JSON-serialisable result. An Agent's own `agent.ctx.tools` scopes the tool to that Session, and `tools.restrict` removes DSH's built-in tools it should not have.

**10. System prompt and skills.** `ctx.systemPrompt.section({ name, order, text })` adds one part of an Agent's prompt; `ctx.skills` registers reusable procedures it can load. The prompt is composed per Session at creation, which is why editing a prompt takes effect on the next Session, not the next message.

Also injected and used directly: `ctx.llm` (resolve a route's call config and stream a completion), `ctx.subprocess` (shell commands and tmux), `ctx.webServer` (the panel's HTTP routes), `ctx.sessionPersistence` and `ctx.workspaceRegistry` (state and directories), and `ctx.permissionPresets` (what an Agent may do without asking).

## Four APIs the documents never name

**`Service`** — `class Runtime extends Service`. It is a Cordis base class, not a DSH concept: it supplies `this.ctx`, registers the instance under the name you pass `super`, and gives `this.lifetime` (the abort signal of the plugin). Anything extending it is a service other plugins can `inject`.

**`ctx.fiber`** — the current plugin instance's handle. `fiber.restart()` re-applies the plugin; `fiber.dispose()` unloads it. Reach for it when a configuration change cannot be applied in place; do not restart from inside an effect, which is being torn down at the time.

**`ctx.get(name)`** — an untyped lookup, for a service the plugin does not `inject` (an optional one, or one it uses only on a rare path). It returns `undefined` when absent, which is the point: `src/app/sessions.ts` uses it for `agentPresets` and `sessionProjections`, and `src/app/role-models.ts` for `llm`. Prefer `ctx.<service>` with `inject`; use `ctx.get` when absence is a supported state, and cast at the boundary.

**`ctx.effect(fn)`** — registers a disposer. `fn` runs now and returns the cleanup (or a promise of it). The second argument is a label that shows in diagnostics. Forgetting it is the most common source of "it worked until I restarted"; the pattern to copy is `ctx.effect(() => ctx.orchestrator.sources.register(kind), 'feishu: source kind')`.

## Where to go next

- How the domain uses all this: [001 Domain model](001-domain.md) through [003 Execution](003-execution.md).
- How the pieces are wired: [007 Architecture](007-architecture.md).
- How to add a Source: [008 Cookbook](008-cookbook.md).
- Names used in this repository: `docs/GLOSSARY.md`, linked from the repository README.
