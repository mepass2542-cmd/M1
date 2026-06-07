---
name: Replit api-server artifact routing
description: Replit auto-creates an api-server artifact on port 8080 that intercepts all /api/* browser requests, causing 404s even when the real server works fine via curl.
---

## The Rule
When Replit auto-creates an `artifacts/api-server` artifact (kind: api, preview path: /api), it configures its proxy to route ALL `/api/*` requests from the browser to port 8080 — not to the dashboard server on port 5000.

**Why:** curl tests go directly to localhost:5000, bypassing the Replit proxy. Browser requests go through the proxy and hit port 8080 first. This caused a days-long debugging loop because curl always worked but the browser always got 404.

**How to apply:** Whenever a Replit project has both a dashboard (serving static + API on one port) and an auto-created api-server artifact, the api-server must be turned into a transparent proxy to the real server. Add this to `artifacts/api-server/src/app.ts`:

```typescript
import http from "http";
app.use((req, res) => {
  const proxy = http.request({ hostname: "localhost", port: DASHBOARD_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `localhost:${DASHBOARD_PORT}` } }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on("error", () => res.status(502).json({ error: "Dashboard unavailable" }));
  req.pipe(proxy, { end: true });
});
```
