import * as cron from 'node-cron';
import * as dotenv from 'dotenv';
import { log, logError } from './logger';
import { loadAllWallets, WalletInfo } from './wallet';
import { runCheckinForAll } from './checkin';

dotenv.config();

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 9 * * *';
const NETWORK = process.env.NETWORK || 'mainnet';

async function main() {
  log('Meta Earth Check-in Bot starting...');
  log(`Network : ${NETWORK}`);
  log(`Schedule: ${CRON_SCHEDULE} (UTC)`);

  let wallets: WalletInfo[];
  try {
    wallets = await loadAllWallets();
    log(`Loaded ${wallets.length} wallet(s).`);
  } catch (err: any) {
    logError('No wallets configured — set MNEMONIC or PRIVATE_KEY in Replit Secrets.', err);
    process.exit(1);
  }

  if (process.env.RUN_ON_START === 'true') {
    log('RUN_ON_START=true — running check-in immediately...');
    await runCheckinForAll(wallets, NETWORK);
  }

  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      log('Cron triggered — running daily check-in...');
      try {
        await runCheckinForAll(wallets, NETWORK);
      } catch (err) {
        logError('Unexpected error during scheduled check-in', err);
      }
    },
    { timezone: 'UTC' },
  );

  const next = getNextRun(CRON_SCHEDULE);
  log(`Bot running — next scheduled run: ${next}`);
}

function getNextRun(schedule: string): string {
  try {
    const task = cron.schedule(schedule, () => {}, { scheduled: false });
    return 'per schedule';
  } catch {
    return 'unknown';
  }
}

main().catch((err) => {
  logError('Fatal error during startup', err);
  process.exit(1);
});
