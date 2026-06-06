import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import * as dotenv from 'dotenv';
import { initDb, pool } from './db';
import { loadEnvWallet } from './store';
import { router } from './routes';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = parseInt(process.env.PORT ?? '5000', 10);

app.use(cors());
// Parse JSON bodies
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Parse plain-text bodies (used by the wallet import endpoint)
app.use(express.text({ type: 'text/plain', limit: '10mb' }));

app.use('/api', router);

// Global error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status ?? err.statusCode ?? 500;
  const message = err.type === 'entity.parse.failed'
    ? 'Invalid JSON body — if you have special characters in your text, try again'
    : (err.message ?? 'Internal server error');
  console.error('[server] Error:', err.message);
  res.status(status).json({ error: message });
});

const distPath = path.join(__dirname, '../dist');
app.use(express.static(distPath));
app.get('/*path', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(distPath, 'index.html'));
});

async function start() {
  try {
    await initDb();
    await loadEnvWallet();
  } catch (e) {
    console.error('[server] DB init error:', e);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[dashboard] Running at http://0.0.0.0:${PORT}`);
    console.log(`[dashboard] Network: ${process.env.NETWORK ?? 'mainnet'}`);
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason);
});

start();
