# Vigil

**A from-scratch Application Performance Monitor for Node.js — it times every HTTP request, and automatically attaches every SQL query that ran inside it, with zero changes to the application being monitored.**

<p>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-async__hooks-339933?logo=node.js&logoColor=white">
  <img alt="Express" src="https://img.shields.io/badge/Express-5.x-000000?logo=express&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue">
</p>

---

## Why this exists

Logging that a request took 900ms tells you almost nothing. The question you
actually have during an incident is *"900ms **doing what**?"* — and answering it
means knowing which database queries ran inside that specific request, while the
server was juggling fifty others.

That correlation is the entire product. Everything else — dashboards, alerts,
percentile charts — is elaboration on it.

Vigil is a small, readable implementation of how real APMs (Datadog, New Relic,
OpenTelemetry) solve that problem: **`AsyncLocalStorage` for per-request context**
plus **monkey-patched database drivers** that push their timings into it. It's
built by hand, on purpose — the point is to understand the mechanism, not to
install one.

---

## What it does today

- ⏱️ **Times every request** with a monotonic clock, measured to the moment the
  response actually finishes — not to the moment your handler returns.
- 🔗 **Correlates every SQL query to its request**, automatically, across `await`
  boundaries, under concurrency, and — the part that took real work — across the
  connection pool's internal handoffs. No request-id threading, no changes to
  your route handlers.
- 🧬 **Auto-instruments `pg`** by patching the driver — promise *and* callback
  call styles, idempotent, and reversible.
- 🗂️ **Normalizes routes to their patterns** (`/users/:id`, not `/users/1`,
  `/users/2`, `/users/3`…) so the data stays groupable.
- 🛡️ **Never blocks and never crashes the host app.** Telemetry is written after
  the response is sent, in a context that can't recurse into itself, behind a
  swallow-everything error boundary.
- 🐘 **Persists to Postgres** in a two-table relational model built for
  percentile aggregation.

**Not built yet:** the read API, the dashboard, and distribution as an installable
package. See [Roadmap](#roadmap).

---

## Architecture

```
                   ┌──────────────────────────────────────────────┐
  HTTP request ───►│  apm middleware                              │
                   │   • t0 = process.hrtime.bigint()             │
                   │   • als.run({ queries: [] }, () => next())   │
                   └───────────────────┬──────────────────────────┘
                                       │   context propagates automatically
                                       │   through every await below
                   ┌───────────────────▼──────────────────────────┐
                   │  your route handler (untouched)              │
                   │     await pool.query(...)  ──────┐           │
                   └──────────────────────────────────┼───────────┘
                                                      │
                   ┌──────────────────────────────────▼───────────┐
                   │  patched Pool.prototype.connect              │
                   │   • the pool may park this callback and let  │
                   │     another request run it later             │
                   │   • AsyncResource.bind pins it to the asker  │
                   └──────────────────────────────────┬───────────┘
                                                      │
                   ┌──────────────────────────────────▼───────────┐
                   │  patched Client.prototype.query              │
                   │   • start timer, capture ctx up front        │
                   │   • call through to the original             │
                   │   • on settle: ctx.queries.push({ sql, ms }) │
                   │   • return the original's result UNCHANGED   │
                   └──────────────────────────────────────────────┘
                                       │
  HTTP response ◄──────────────────────┘
                                       │  res.on('finish')
                   ┌───────────────────▼──────────────────────────┐
                   │  als.exit(...)  ← so Vigil's own writes      │
                   │                    aren't recorded as spans  │
                   │   INSERT INTO requests  → request_id         │
                   │   INSERT INTO queries   (bulk, FK to request)│
                   └──────────────────────────────────────────────┘
```

| File | Responsibility |
| --- | --- |
| [`src/middlewares/apm.ts`](src/middlewares/apm.ts) | Opens the request context, times the cycle, persists on finish |
| [`src/lib/als.ts`](src/lib/als.ts) | The `AsyncLocalStorage` instance and the `getCtx()` accessor |
| [`src/instrumentation/pg.ts`](src/instrumentation/pg.ts) | The `pg` driver patch — query timing, plus the pool-handoff context bind |
| [`src/lib/routePattern.ts`](src/lib/routePattern.ts) | Rebuilds the declared route pattern from an Express request |
| [`src/config/database.ts`](src/config/database.ts) | Telemetry connection pool with bounded timeouts |
| [`docker/schema.sql`](docker/schema.sql) | The two-table telemetry schema |

---

## Quick start

**Requirements:** Node.js 20+ (for `--env-file`), Docker.

```bash
git clone https://github.com/MilanAnilAnthore/Vigil.git
cd Vigil
npm install
```

**1. Start Postgres.** The schema is applied automatically on first boot.

```bash
cd docker
cp .env.example .env      # set POSTGRES_PASSWORD / POSTGRES_DB
docker compose up -d
cd ..
```

**2. Point Vigil at it.**

```bash
cp .env.example .env      # DATABASE_URL=postgresql://postgres:<pw>@localhost:5432/apm
```

**3. Run the instrumented demo app.**

```bash
npm run dev
```

**4. Generate some traffic.**

```bash
curl http://localhost:3000/
```

**5. Look at what was recorded.**

```bash
docker exec -it apm-postgres psql -U postgres -d apm
```

```sql
SELECT r.request_id, r.method, r.route, r.status, r.duration_ms,
       q.query_text, q.duration_ms AS query_ms
FROM requests r
LEFT JOIN queries q ON q.request_id = r.request_id
ORDER BY r.request_id DESC;
```

One request row, plus one row per query that ran inside it — linked by a foreign
key that nothing in the application code had to provide.

### Wiring it into an app

Two lines, and every route below them is instrumented:

```ts
import express from "express";
import apm from "./middlewares/apm";
import { instrumentPg } from "./instrumentation/pg";

instrumentPg();          // patch the driver before anything opens a connection
const app = express();
app.use(apm);            // mount first, so it wraps every downstream handler
```

---

## How the instrumentation works

This is the part worth reading. Three mechanisms, each solving a specific problem.

### 1. Request context — `AsyncLocalStorage`

**The problem.** A slow query happens four function calls deep, after two
`await`s, while the server is handling fifty other requests. Which request does
it belong to? You can't answer that by threading a request-id parameter through
every function — that requires modifying the application, which defeats the
purpose of an *automatic* monitor.

**The mechanism.** `AsyncLocalStorage` (from `node:async_hooks`) is effectively
thread-local storage for async JavaScript. The middleware wraps `next()` in
`als.run(store, ...)`, and Node propagates that store down the entire async
call chain — through promises, timers, callbacks, everything spawned inside it:

```ts
const store: StoreContext = { queries: [] };
als.run(store, () => {
  res.on("finish", async () => { /* ...read store.queries here... */ });
  next();
});
```

Any code, anywhere downstream, can call `getCtx()` and get back *that request's*
store. Concurrent requests never see each other's, because each lives in its own
async resource tree — V8 and Node's async-hooks machinery track the parent-child
relationship of async operations and carry the store along each branch.

**The pitfall that teaches the concept:** `next()` must be called *inside*
`run()`. Register the listener or call `next()` outside it and `getStore()`
silently returns `undefined` downstream — no error, just an APM that records
requests with zero queries forever.

### 2. Query capture — monkey-patching `pg`

**The mechanism.** Replace `Client.prototype.query` with a wrapper that starts a
timer, calls through to the original, records the duration into the current
request's context, and returns exactly what the original returned. Because
`pg.Pool` delegates to `Client` internally, patching the prototype covers
`pool.query()` too — one patch point, full coverage.

The details that make it safe:

**Return the original result, unchanged.** The single most dangerous line in the
file. Forget the `return` and every query in the host application resolves to
`undefined` — not an exception, not a stack trace pointing at the monitor, just
data mysteriously vanishing in code you never touched. A monitoring tool that
breaks the thing it monitors is worse than no monitoring tool.

**Capture the context up front, not at settle time.** `const ctx = getCtx()` runs
synchronously at call time, while we're still provably inside the request's
async scope. The `pg` connection is pooled and long-lived — it was created
outside any request — so by the time the promise settles, the ambient context is
no longer guaranteed to be the right one. Grabbing the reference early is
necessary. It is not, on its own, sufficient — which is what §3 is about.

**Handle both call styles.** `pg` accepts `query(text)`, `query(text, values)`,
`query(config)`, and callback forms. The patch sniffs for a trailing function
argument and wraps *that* callback so the timer stops when the database actually
answers; otherwise it hangs a `.finally()` on the returned promise. The
`.catch(() => {})` after it exists so that observing the promise never converts a
handled rejection into an unhandled one in the host app.

**Store the SQL text, never the parameter values.** Vigil records
`SELECT * FROM orders WHERE user_id = $1` — never the actual user id. Parameter
values are PII, and they'd turn one query shape into unbounded distinct strings.

**Patch exactly once.** The guard uses `Symbol.for("vigil.pg.patched")` — a
symbol from the *global* registry, so it survives the module being loaded twice
under different resolved paths (a monorepo, a duplicated transitive dependency).
A module-local boolean wouldn't; you'd double-wrap and double-count. The original
is stashed under a matching symbol so [`uninstrumentPg()`](src/instrumentation/pg.ts)
can cleanly restore it, which is what makes the patch testable.

### 3. Surviving the connection pool

Sections 1 and 2 look complete on their own: the request has a context, and the
patch reads it at call time. They were still wrong *together*, and the bug is
worth walking through, because it is precisely the class of failure this project
exists to catch.

`pool.query()` is not one operation. It is two:

```js
// pg-pool
query(text, values, cb) {
  this.connect((err, client) => {        // ① get me a connection
    client.query(text, values, ...)      // ② run it  ← the patched method
  })
  return response.result                 // returns before ② has happened at all
}
```

Step ① is not instant. A pool is finite. Once `max` connections exist and all of
them are busy, `connect()` **parks your callback on `_pendingQueue` and returns**,
having executed nothing. Your query then sits there until some *other* request
finishes and calls `client.release()` — which synchronously drives
`_pulseQueue()`, shifts your callback off the front of the queue, and runs it
**on that other request's stack**.

So `const ctx = getCtx()` — correct-looking, and genuinely correct in every
one-request-at-a-time test — was reading whichever context happened to be live
at *rescue* time. Worse, the rescuing stack originates in a socket `'data'`
event, and a socket carries the context it was **created** in for its entire
life. So the inherited store was typically a long-dead request's, or `undefined`
for connections opened at boot — in which case `ctx?.queries.push(...)` silently
no-ops and the query disappears without a trace.

Measured against pg-pool's real queueing logic, `max: 1`, four concurrent
requests, showing which request's store each query landed in:

| | A | B | C | D |
| --- | --- | --- | --- | --- |
| before | A ✅ | **A** ❌ | **A** ❌ | **A** ❌ |
| after | A ✅ | B ✅ | C ✅ | D ✅ |

The fix is to stop asking *"whose context is live now?"* and start recording
*"who asked for this?"* — at a point where that answer is provably right.
`pool.connect()` is called on the requesting handler's own stack, so that is the
place to capture:

```ts
Pool.prototype.connect = function (cb) {
  return typeof cb === "function"
    ? original.call(this, AsyncResource.bind(cb))
    : original.call(this, cb);
};
```

`AsyncResource.bind` snapshots the live context and re-enters it whenever the
callback is eventually invoked, from whosever stack. The promise form
(`await pool.connect()`) is deliberately left unbound: an awaited promise already
resumes in the *awaiter's* context rather than the resolver's, so binding it
would be a no-op. This is what `@opentelemetry/instrumentation-pg` does, and for
this exact reason.

**Why this is the instructive bug.** It cannot occur below `max` concurrent
connections — so it is invisible in development, invisible to a `curl`, and
invisible to any test that doesn't deliberately saturate the pool. It then
degrades in proportion to traffic, and reports nothing while doing so. A monitor
whose correlation quietly thins out under exactly the load it was built to
observe is the worst failure mode available to it, and finding it meant reading
the pool's source rather than trusting that `getStore()` meant what it appeared
to mean.

### 4. Route patterns — the cardinality problem

Metrics have to be keyed on the route **pattern** (`/users/:id`), not the
concrete path (`/users/1`). Key on the path and every user id becomes its own
time series: unbounded storage, and no row with enough samples to compute a
meaningful p99.

Express hands you *half* of the pattern. `req.route.path` is the path as declared
on the router that owns the route — a router mounted at `/api/users` declares its
routes as `/` and `/:id`, with no knowledge of where it was mounted. The prefix
lives separately in `req.baseUrl`.

[`routePattern.ts`](src/lib/routePattern.ts) rejoins them and normalizes the
result:

| Request URL | Naive `req.route?.path` | Vigil |
| --- | --- | --- |
| `/api/users` | `/` ⚠️ | `/api/users` |
| `/api/users/` | `/` ⚠️ | `/api/users` |
| `/api/users/42` | `/:id` ⚠️ | `/api/users/:id` |
| `/api/orders/42` | `/:id` ⚠️ | `/api/orders/:id` |
| `/alias-b` (array path) | `/alias-a,/alias-b` ⚠️ | `/alias-a` |
| `/nope` (404) | `undefined` → SQL `NULL` ⚠️ | `(unmatched)` |

Read the ⚠️ rows as a group. The naive version doesn't *explode* cardinality — it
**collapses** it, merging two unrelated endpoints in two unrelated routers into a
single `/:id` bucket. That's the worse failure: an exploded dashboard showing
40,000 routes announces itself immediately, while a collapsed one shows `/:id`
at a healthy-looking p99 of 340ms that is actually a 2s endpoint hiding
underneath an 8ms one. **A monitoring tool that is visibly broken costs you an
afternoon; one that is plausibly broken costs you the incident.**

Two smaller decisions in there earn their keep:

- **404s record `"(unmatched)"`, not `NULL`.** SQL `NULL` isn't comparable —
  `WHERE route = …` never matches it and `GROUP BY` dumps it into an unlabeled
  bucket, so your 404s end up simultaneously counted and unqueryable. A sentinel
  string stays groupable, filterable, and chartable.
- **Trailing slashes are trimmed.** Otherwise a mounted router's `"/"` route
  records as `/api/users/`, which `GROUP BY route` treats as a different endpoint
  from `/api/users`. One character, two split time series.

This bug also survived TypeScript strict mode, which is its own lesson:
`@types/express` declares `req.route` as `any`, and `any` launders `undefined`
into a `string` parameter without complaint. The fix that actually re-enabled
type checking was annotating the helper's return type as `: string` —
*`any` at an I/O boundary is where strict mode goes to die.*

### 5. Not hurting the host application

An APM has to be invisible to the app it watches. Three guarantees:

**It never adds latency.** All telemetry writes happen in `res.on("finish")` —
after the response bytes are out the door. The user has already been served.

**It can't take the app down.** The whole write path sits in a `try/catch` that
swallows. If the telemetry database is unreachable, the monitored app doesn't
notice.

**It doesn't monitor itself.** This one is subtle. The `finish` handler was
registered *inside* `als.run`, so it inherits the request's context — meaning
Vigil's own `INSERT`s would flow through the patched `pg` driver, find a live
context, and push themselves in as queries. Wrapping the writes in
`als.exit(...)` runs them outside any store, so `getCtx()` returns `undefined`
and the instrumentation correctly ignores them. Without it, an APM that writes
two rows per request would report every request as containing two extra queries
it never ran.

**Bounded blast radius.** The telemetry pool is capped (`max: 20`) with a
`query_timeout` of 3s, so a degraded telemetry database can't accumulate
connections or hang handlers indefinitely.

---

## Data model

Relational, with query rows foreign-keyed to their request — not a JSONB blob on
the request row. The tradeoff: JSONB is a single write and a simpler schema, but
"show me the slowest queries across all endpoints" becomes a JSON-unnesting scan
instead of an indexed `GROUP BY`. Since finding slow queries *is* the product,
the query shape wins.

```sql
CREATE TABLE requests (
  request_id  BIGSERIAL PRIMARY KEY,
  method      TEXT,
  route       TEXT,              -- always the pattern, never NULL
  status      INT,
  duration_ms DOUBLE PRECISION,
  ts          TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE queries (
  query_id    BIGSERIAL PRIMARY KEY,
  request_id  BIGINT NOT NULL REFERENCES requests(request_id) ON DELETE CASCADE,
  query_text  TEXT,              -- SQL shape only, values stripped
  duration_ms DOUBLE PRECISION
);
```

Query rows are inserted in a **single statement** via `unnest()` over parallel
arrays, rather than one `INSERT` per query — a request with twenty queries costs
two round trips, not twenty-one.

Raw samples are kept rather than pre-aggregated, which is what keeps percentiles
honest:

```sql
SELECT route,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99,
       count(*)                              AS requests,
       count(*) FILTER (WHERE status >= 500) AS errors
FROM requests
WHERE ts > now() - interval '1 hour'
GROUP BY route
ORDER BY p99 DESC;
```

> **Why raw:** percentiles are not composable. You cannot average sixty per-minute
> p95s to get the hour's p95 — that's mathematically meaningless. Pre-aggregating
> requires keeping raw samples or storing mergeable structures (histograms,
> t-digest). Storing raw is the honest MVP; the sketch layer is a deliberate
> later decision, not an oversight.

And averages are the reason p99 exists at all: 99 requests at 50ms plus one at
5000ms averages to a comfortable 99.5ms, and one user is furious.

---

## Known limitations

Documented rather than hidden — these are deliberate scope boundaries, not bugs
in waiting.

- **Params in *mount* paths still split buckets.** `app.get("/posts/:id", h)` is
  fine. `app.use("/posts/:id/comments", router)` records
  `/posts/7/comments/:cid` — one bucket per post id. Root cause: `req.baseUrl` is
  already-matched *text*, not a pattern, and Express 5's `Layer` never stores its
  declared path (it goes into a matcher closure, and `layer.path` is later
  overwritten with the matched text). It genuinely cannot be reconstructed after
  routing — it has to be captured at registration time, which means patching the
  router itself. That's a larger blast radius than the bug currently justifies,
  so it's deferred behind a documented tripwire.
- **`pg` only.** Redis, HTTP client calls, and other drivers aren't instrumented
  yet. The context layer is driver-agnostic; only the patch is `pg`-specific.
- **`pg`'s standard classes only.** The patch targets `Client` and `Pool` as
  exported by `pg`. `pg.native` builds separate classes, and a dependency that
  requires `pg-pool` directly bypasses `pg`'s wrapper — neither is instrumented.
- **The monitored app and Vigil share one pool.** Telemetry writes contend for
  the same connections as the app's own queries — two extra checkouts per
  request — and Vigil's `query_timeout` is imposed on the host's queries as a
  side effect. Splitting the pools is part of the packaging work.
- **Single process.** No trace propagation across service boundaries.
- **No retention policy.** Raw samples grow unbounded; there's no rollup or TTL yet.
- **Not yet packaged.** Vigil currently lives inside the app it instruments rather
  than being an installable dependency.

---

## Roadmap

- [x] Request timing and persistence
- [x] Per-request context via `AsyncLocalStorage`
- [x] Automatic `pg` instrumentation with request correlation
- [x] Route-pattern normalization
- [ ] Aggregation API — p50/p95/p99, throughput and error rate per route
- [ ] Dashboard — slowest endpoints, latency over time, and the slowest *queries*
      per endpoint (surfacing the correlation is the whole point)
- [ ] Distribution as drop-in middleware: `app.use(vigil({ dsn, serviceName }))`
- [ ] Test suite and CI
- [ ] Grounded anomaly explanation — detect a p99 spike, gather the real traces
      from that window, and have an LLM reason *only* from that data

---

## Prior art

[OpenTelemetry](https://opentelemetry.io/) is the industry framework that does
all of this for you, and in production you should use it. Vigil rebuilds a small
version by hand deliberately — the value is in knowing exactly what those
auto-instrumentation packages are doing under the hood.

---

## License

MIT © Milan Anil Anthore — see [LICENSE](LICENSE).
