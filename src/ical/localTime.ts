/**
 * Wall-clock time helpers.
 *
 * The PHP parser does all of its arithmetic with strtotime()/DateTime in the
 * server's default time zone (date_default_timezone_set). "+1 week", "last
 * monday", "first tuesday of 2026-10" etc. all operate on local wall-clock
 * time. We reproduce that by representing a local time as a "wall" number:
 * the milliseconds Date.UTC() would give for the same Y-m-d H:i:s. Calendar
 * arithmetic on that number (via the UTC getters/setters) is then exactly
 * PHP's local-time arithmetic, including month overflow (Jan 31 + 1 month =
 * Mar 3), with no DST surprises. Real instants are only computed at the edges.
 */

export type Wall = number;

const DAY_MS = 86_400_000;
const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(tz: string): Intl.DateTimeFormat {
	let f = dtfCache.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
		dtfCache.set(tz, f);
	}
	return f;
}

export function isValidTimeZone(tz: string | undefined | null): tz is string {
	if (!tz) return false;
	try {
		dtf(tz);
		return true;
	} catch {
		return false;
	}
}

export function wall(y: number, m: number, d: number, h = 0, i = 0, s = 0): Wall {
	return Date.UTC(y, m - 1, d, h, i, s);
}

// UTC-offset cache. Real-world offset changes happen on 15-minute boundaries,
// so the offset is constant within each 15-minute bucket of real time.
const BUCKET = 900_000;
const offsetCache = new Map<string, Map<number, number>>();

function offsetAt(ms: number, tz: string): number {
	let byTz = offsetCache.get(tz);
	if (!byTz) offsetCache.set(tz, (byTz = new Map()));
	const b = Math.floor(ms / BUCKET);
	let off = byTz.get(b);
	if (off === undefined) {
		const t = b * BUCKET;
		const p: Record<string, number> = {};
		for (const part of dtf(tz).formatToParts(new Date(t))) {
			if (part.type !== 'literal') p[part.type] = Number(part.value);
		}
		off = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
		if (byTz.size > 200_000) byTz.clear();
		byTz.set(b, off);
	}
	return off;
}

/** Real instant (epoch ms) -> wall clock in tz. */
export function instantToWall(ms: number, tz: string): Wall {
	return ms + offsetAt(ms, tz);
}

/** Wall clock in tz -> real instant (epoch ms). Gap times move forward like PHP does. */
export function wallToInstant(w: Wall, tz: string): number {
	let guess = w;
	for (let k = 0; k < 3; k++) {
		const offset = instantToWall(guess, tz) - guess; // local - utc
		const next = w - offset;
		if (next === guess) break;
		guess = next;
	}
	return guess;
}

// ---- getters ----
export const year = (w: Wall) => new Date(w).getUTCFullYear();
export const month = (w: Wall) => new Date(w).getUTCMonth() + 1;
export const day = (w: Wall) => new Date(w).getUTCDate();
/** 0 = Sunday ... 6 = Saturday (PHP date('w')) */
export const weekday = (w: Wall) => new Date(w).getUTCDay();
export const timeOfDay = (w: Wall) => ((w % DAY_MS) + DAY_MS) % DAY_MS;
export const midnight = (w: Wall) => w - timeOfDay(w);

// ---- PHP-style relative arithmetic (all keep the time of day) ----
export function addDays(w: Wall, n: number): Wall {
	const d = new Date(w);
	d.setUTCDate(d.getUTCDate() + n);
	return d.getTime();
}
export function addMonths(w: Wall, n: number): Wall {
	const d = new Date(w);
	d.setUTCMonth(d.getUTCMonth() + n); // overflows exactly like PHP "+N month"
	return d.getTime();
}
export function addYears(w: Wall, n: number): Wall {
	const d = new Date(w);
	d.setUTCFullYear(d.getUTCFullYear() + n); // Feb 29 + 1 year = Mar 1, like PHP
	return d.getTime();
}

export const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export function dayCodeToIndex(code: string): number {
	return DAY_CODES.indexOf(code as (typeof DAY_CODES)[number]);
}

/** strtotime('<dayname>', w): that weekday at 00:00, today if w is already that day. */
export function thisOrNextWeekday(w: Wall, dow: number): Wall {
	const m = midnight(w);
	return addDays(m, (dow - weekday(m) + 7) % 7);
}
/** strtotime('last monday', w): the previous Monday (strictly before), at 00:00. */
export function lastWeekdayStrict(w: Wall, dow: number): Wall {
	const m = midnight(w);
	let diff = (weekday(m) - dow + 7) % 7;
	if (diff === 0) diff = 7;
	return addDays(m, -diff);
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');
export function formatYmd(w: Wall): string {
	return `${year(w)}-${pad(month(w))}-${pad(day(w))}`;
}
export function formatHi(w: Wall): string {
	const d = new Date(w);
	return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function formatYmdHis(w: Wall): string {
	const d = new Date(w);
	return `${formatYmd(w)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
/** ISO 8601 with the real UTC offset for tz, e.g. 2026-10-13T09:00:00-04:00 */
export function formatIsoOffset(w: Wall, tz: string): string {
	const instant = wallToInstant(w, tz);
	const off = Math.round((instantToWall(instant, tz) - instant) / 60_000);
	const sign = off < 0 ? '-' : '+';
	const abs = Math.abs(off);
	const local = instantToWall(instant, tz);
	return `${formatYmdHis(local).replace(' ', 'T')}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
/** PHP date_diff(...)->format('%a') between two wall times. */
export function wholeDaysBetween(a: Wall, b: Wall): number {
	return Math.floor(Math.abs(b - a) / DAY_MS);
}

export { DAY_MS };
