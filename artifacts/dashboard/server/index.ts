import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import * as dotenv from 'dotenv';
import { router } from './routes';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = parseInt(process.env.PORT ?? '5000', 10);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/api', router);

// Return JSON for body-parse errors (SyntaxError from malformed JSON, etc.)
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
// Always serve fresh HTML so browsers pick up new JS bundle hashes
app.get('/*path', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[dashboard] Running at http://0.0.0.0:${PORT}`);
  console.log(`[dashboard] Network: ${process.env.NETWORK ?? 'mainnet'}`);
});
