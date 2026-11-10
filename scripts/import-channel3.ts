import { importChannel3 } from '../src/services/channel3.js';

// npm run seed:channel3 -- "laptop" "running shoes" "wireless headphones"
// Optional: search is already live at chat time. This only pre-fills the cache.
const queries = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!queries.length) queries.push('laptop', 'smartphone', 'wireless headphones', 'running shoes', 'perfume');
try {
  const s = await importChannel3(queries, 10);
  console.log(`Done. queries=${s.queries} saved=${s.saved}`);
} catch (e) {
  console.error('Import failed:', e instanceof Error ? e.message : e);
  process.exit(1);
}
