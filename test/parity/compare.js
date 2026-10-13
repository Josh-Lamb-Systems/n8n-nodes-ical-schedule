// node compare.js <ics> <tz> <days> <dates,...> <php.json>  -> prints mismatches
const fs = require('fs');
const { buildSchedule } = require('../../dist/ical/ICal.js');
const [,, file, tz, days, dates, phpFile] = process.argv;
const php = JSON.parse(fs.readFileSync(phpFile, 'utf8'));
const ics = fs.readFileSync(file, 'utf8');
let bad = 0, checked = 0, events = 0;
for (const d of dates.split(',')) {
  const m = buildSchedule(ics, { timeZone: tz, startDate: d, days: +days, phpCompat: true, skipCancelled: false });
  const mine = {};
  for (const [k, v] of m) mine[k] = v.map(e => { const o = { title: e.title, fullday: e.fullday, start: e.start, end: e.end }; if (e.location !== undefined) o.location = e.location; return o; });
  const a = JSON.stringify(mine), b = JSON.stringify(php[d]);
  checked++; events += Object.values(mine).reduce((s, x) => s + x.length, 0);
  if (a !== b) { bad++; if (bad <= 3) { console.log('MISMATCH', file, tz, d); console.log(' php:', b); console.log(' ts :', a); } }
}
console.log(JSON.stringify({ file: file.split('/').pop(), tz, checked, events, bad }));
process.exitCode = bad ? 1 : 0;
