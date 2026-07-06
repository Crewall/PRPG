// Standalone migration runner: `npm run migrate`.
import { loadConfig } from '../src/config/config.ts';
import { openDb, migrate } from '../src/db/db.ts';

const config = loadConfig(process.env.PRPG_CONFIG ?? 'config.json');
const db = openDb(config.db.path);
const applied = migrate(db);
if (applied.length === 0) {
  console.log('Database already up to date.');
} else {
  console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
}
db.close();
