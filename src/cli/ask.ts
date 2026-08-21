import { ask } from '../ai/nlQuery.js';
import { pool } from '../db.js';

const question = process.argv.slice(2).join(' ');
if (!question) {
  console.error(`usage: npm run ask -- "what should I sell this week"

examples:
  "what should I sell this week"
  "which Mexico cards am I holding and what are they worth"
  "show me holdings where the 30 day trend is down more than 10 percent"
  "what is my total portfolio value and how much of it is backed by real comps"
  "which of my cards are worth grading"
  "where should I sell my Kabooms"`);
  process.exit(1);
}

const r = await ask(question);
console.log(`\n${r.answer}\n`);
if (r.sql) console.log(`--- SQL ---\n${r.sql}\n`);
if (r.rows.length) {
  console.table(r.rows.slice(0, 25));
  if (r.rows.length > 25) console.log(`... ${r.rows.length - 25} more rows`);
}
if (r.error) console.error(`error: ${r.error}`);
await pool.end();
