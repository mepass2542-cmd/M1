import express from 'express';
import cors from 'cors';
import path from 'path';
import * as dotenv from 'dotenv';
import { router } from './routes';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = parseInt(process.env.PORT ?? '5000', 10);

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use('/api', router);

const distPath = path.join(__dirname, '../dist');
app.use(express.static(distPath));
app.get('/*path', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[dashboard] Running at http://0.0.0.0:${PORT}`);
  console.log(`[dashboard] Network: ${process.env.NETWORK ?? 'mainnet'}`);
});
