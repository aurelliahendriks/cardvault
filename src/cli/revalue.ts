import { pool } from '../db.js';
import { revalueAll } from '../valuation/engine.js';

const onlyHeld = process.argv.includes('--held');
const n = await revalueAll({ onlyHeld });
console.log(`${n} valuations written${onlyHeld ? ' (held only)' : ''}`);
await pool.end();
