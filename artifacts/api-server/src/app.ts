import express, { type Express, type Request, type Response } from "express";
import http from "http";

const app: Express = express();

const DASHBOARD_PORT = 5000;

app.use((req: Request, res: Response) => {
  const options = {
    hostname: "localhost",
    port: DASHBOARD_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `localhost:${DASHBOARD_PORT}`,
    },
  };

  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxy.on("error", () => {
    res.status(502).json({ error: "Dashboard unavailable" });
  });

  req.pipe(proxy, { end: true });
});

export default app;
