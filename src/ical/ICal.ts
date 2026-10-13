/**
 * TypeScript port of the PHP iCal parser used by trmnl-calendar
 * (server/ical.php, itself based on https://gist.github.com/seebz/c00a38d9520e035a6a8c)
 * plus the day-grouping logic from trmnl-calendar's server/index.php getEvents().
 *
 * The structure and recurrence algorithm follow the PHP code method by method.
 * With `phpCompat: true` the output matches the PHP original exactly (that is
 * what the parity tests check). With the default options a handful of clear
 * bugs in the PHP are fixed; each fix is listed in ParseOptions and is a
 * no-op for calendars the PHP already handled correctly.
 */
import {
	addDays,
	addMonths,
	addYears,
	DAY_MS,
	dayCodeToIndex,
	formatHi,
	formatYmd,
	formatYmdHis,
	instantToWall,
	isValidTimeZone,
	lastWeekdayStrict,
	midnight,
	month,
	thisOrNextWeekday,
	timeOfDay,
	type Wall,
	wall,
	wallToInstant,
	weekday,
	wholeDaysBetween,
	year,
	day as dayOfMonth,
	DAY_CODES,
} from './localTime';

export interface ParseOptions {
	/** Time zone the calendar is evaluated in (PHP: date_default_timezone_set). */
	timeZone: string;
	/** "Now", used only where the PHP uses the current time (monthly BYDAY search horizon). */
	now?: Date;
	/**
	 * Reproduce the PHP output exactly, bugs included. Overrides every fix below.
	 * Only meant for parity testing.
	 */
	phpCompat?: boolean;

	// ---- fixes (all on by default unless phpCompat) ----
	/** Honour DTSTART;TZID=... instead of assuming every floating time is in `timeZone`. */
	fixTzid?: boolean;
	/** Read every date in comma-separated EXDATE lists (PHP reads only the first). */
	fixExdateLists?: boolean;
	/** Never-ending rules: expand up to the requested range instead of stopping after 500 occurrences. */
	fixOpenEndedRules?: boolean;
	/** RRULE UNTIL is inclusive (RFC 5545); PHP drops an occurrence that starts exactly at UNTIL. */
	fixUntilInclusive?: boolean;
	/** A moved instance (RECURRENCE-ID) also removes the original slot when moved to a different day. */
	fixMovedInstances?: boolean;
	/** All-day occurrences keep whole-day lengths across DST changes (PHP turned them into 00:00-23:00 timed events). */
	fixDstDurations?: boolean;
	/** Monthly "last Friday"-style rules no longer skip months after the 29th-31st. */
	fixMonthlyStepping?: boolean;
	/** Unfold LF-only and tab-folded lines, and unescape \, \; \n in text. */
	fixTextParsing?: boolean;
	/** Events with no DTEND: all-day lasts one day, timed has zero length (PHP produced garbage). */
	fixMissingEnd?: boolean;
}

type Rec = {
	freq?: string;
	until?: string;
	count?: number;
	interval?: number;
	byday?: string[];
	bymonthday?: string;
	[k: string]: unknown;
};

const RE = {
	uid: /^UID:(.*)$/m,
	summary: /^SUMMARY:(.*)$/m,
	description: /^DESCRIPTION:(.*)$/m,
	dtstart: /^DTSTART(?:;.+)?:([0-9]+(T[0-9]+Z?)?)/m,
	dtend: /^DTEND(?:;.+)?:([0-9]+(T[0-9]+Z?)?)/m,
	recurrenceId: /^RECURRENCE-ID(?:;.+)?:([0-9]+(T[0-9]+Z?)?)/m,
	exdate: /^EXDATE(;.+)?:([0-9]+(T[0-9]+Z?)?)/gm,
	exdateFull: /^EXDATE(;[^\r\n]+)?:([0-9TZ,]+)/gm,
	rrule: /^RRULE:(.*)/m,
	location: /^LOCATION:(.*)$/m,
	status: /^STATUS:(.*)$/m,
	created: /^CREATED:(.*)/m,
	updated: /^LAST-MODIFIED:(.*)/m,
};

/** PHP trim() default character set. */
const phpTrim = (s: string) => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
const unescapeText = (s: string) =>
	s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

interface Ctx {
	tz: string;
	nowWall: Wall;
	compat: boolean;
	fix: Required<Omit<ParseOptions, 'timeZone' | 'now' | 'phpCompat'>>;
	horizon: Wall | null; // last wall time that needs expanding (fixOpenEndedRules)
}

/**
 * strtotime() for the compact iCal date forms the PHP regexes capture
 * (YYYYMMDD, YYYYMMDDTHHMMSS, YYYYMMDDTHHMMSSZ), returned as wall time in ctx.tz.
 */
function icalToWall(value: string, ctx: Ctx, tzid?: string): Wall | null {
	const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
	if (!m) {
		// strtotime fallback for odd values (e.g. CREATED in another format)
		const t = Date.parse(value);
		return Number.isNaN(t) ? null : instantToWall(t, ctx.tz);
	}
	const [, y, mo, d, h, i, s, z] = m;
	const w = wall(+y, +mo, +d, +(h ?? 0), +(i ?? 0), +(s ?? 0));
	if (z) return instantToWall(w, ctx.tz); // UTC instant -> local
	if (h !== undefined && tzid && ctx.fix.fixTzid && tzid !== ctx.tz && isValidTimeZone(tzid)) {
		return instantToWall(wallToInstant(w, tzid), ctx.tz);
	}
	return w; // floating / date-only: PHP reads it as local time
}

function tzidOf(params: string | undefined): string | undefined {
	if (!params) return undefined;
	const m = /;TZID=("?)([^;:"]+)\1/i.exec(params);
	return m?.[2];
}

function lineParams(content: string, prop: string): string | undefined {
	const m = new RegExp(`^${prop}(;[^\\r\\n]*?)?:`, 'm').exec(content);
	return m?.[1];
}

export class ICalEvent {
	uid?: string;
	summary?: string;
	description?: string;
	dateStart?: string;
	dateEnd?: string;
	recurrenceId?: string;
	exdate: string[] = [];
	recurrence?: Rec;
	location?: string;
	status?: string;
	created?: string;
	updated?: string;
	/** true when DTSTART was a DATE (no time) */
	dateOnly = false;

	/** wall times (PHP: $_timeStart etc. are unix timestamps; see localTime.ts) */
	_timeStart?: Wall;
	_timeEnd?: Wall;
	_recurrenceId?: Wall;
	protected _occurrences?: Wall[];

	constructor(
		content: string | null,
		protected ctx: Ctx,
	) {
		if (content) this.parse(content);
	}

	title() {
		return this.summary;
	}

	occurrences(): Wall[] {
		if (!this._occurrences || this._occurrences.length === 0) {
			this._occurrences = this._calculateOccurrences();
		}
		return this._occurrences;
	}

	/** PHP: $_timeEnd - $_timeStart in seconds (real elapsed time). */
	duration(): number {
		const { ctx } = this;
		if (this._timeEnd === undefined || this._timeStart === undefined) return 0;
		// RFC 5545: all-day spans are nominal days; timed spans are exact elapsed time.
		if (ctx.fix.fixDstDurations && this.dateOnly) return this._timeEnd - this._timeStart; // wall-clock ms
		return wallToInstant(this._timeEnd, ctx.tz) - wallToInstant(this._timeStart, ctx.tz); // real ms
	}

	parse(content: string): this {
		const { ctx } = this;
		content = ctx.fix.fixTextParsing ? content.replace(/\r?\n[ \t]/g, '') : content.split('\r\n ').join('');
		const text = (s: string) => (ctx.fix.fixTextParsing ? unescapeText(phpTrim(s)) : phpTrim(s));
		let m: RegExpExecArray | null;

		if ((m = RE.uid.exec(content))) this.uid = phpTrim(m[1]);
		if ((m = RE.summary.exec(content))) this.summary = text(m[1]);
		if ((m = RE.description.exec(content))) this.description = text(m[1]);

		if ((m = RE.dtstart.exec(content))) {
			this.dateOnly = m[2] === undefined;
			const w = icalToWall(m[1], ctx, tzidOf(lineParams(content, 'DTSTART')));
			if (w !== null) {
				this._timeStart = w;
				this.dateStart = formatYmdHis(w);
			}
		}
		if ((m = RE.dtend.exec(content))) {
			const w = icalToWall(m[1], ctx, tzidOf(lineParams(content, 'DTEND')));
			if (w !== null) {
				this._timeEnd = w;
				this.dateEnd = formatYmdHis(w);
			}
		} else if (ctx.fix.fixMissingEnd && this._timeStart !== undefined) {
			this._timeEnd = this.dateOnly ? addDays(this._timeStart, 1) : this._timeStart;
			this.dateEnd = formatYmdHis(this._timeEnd);
		}

		if ((m = RE.recurrenceId.exec(content))) {
			const w = icalToWall(m[1], ctx, tzidOf(lineParams(content, 'RECURRENCE-ID')));
			if (w !== null) {
				this._recurrenceId = w;
				this.recurrenceId = formatYmdHis(w);
			}
		}

		if (ctx.fix.fixExdateLists) {
			for (const em of content.matchAll(RE.exdateFull)) {
				const tzid = tzidOf(em[1]);
				for (const d of em[2].split(',')) {
					const w = icalToWall(d, ctx, tzid);
					if (w !== null) this.exdate.push(formatYmd(w));
				}
			}
		} else {
			for (const em of content.matchAll(RE.exdate)) {
				const tzid = tzidOf(em[1]);
				const w = icalToWall(em[2], ctx, tzid);
				if (w !== null) this.exdate.push(formatYmd(w));
			}
		}

		if ((m = RE.rrule.exec(content))) {
			const rules: Rec = {};
			for (const r of phpTrim(m[1]).split(';')) {
				const [key, value] = r.split('=');
				if (key) rules[key.toLowerCase()] = value;
			}
			if (rules.until !== undefined) {
				const w = icalToWall(String(rules.until), ctx, tzidOf(lineParams(content, 'DTSTART')));
				rules.until = w === null ? undefined : formatYmdHis(w);
			}
			if (rules.count !== undefined) rules.count = parseInt(String(rules.count), 10) || 0;
			if (rules.interval !== undefined) rules.interval = parseInt(String(rules.interval), 10) || 0;
			if (rules.byday !== undefined) rules.byday = String(rules.byday).split(',');

			// Avoid infinite recurrences
			if (rules.until === undefined && rules.count === undefined) {
				if (ctx.fix.fixOpenEndedRules && ctx.horizon !== null) {
					rules.until = formatYmdHis(ctx.horizon);
					rules._openEnded = true;
				} else {
					rules.count = 500;
				}
			}
			this.recurrence = rules;
		}

		if ((m = RE.location.exec(content))) this.location = text(m[1]);
		if ((m = RE.status.exec(content))) this.status = phpTrim(m[1]);
		if ((m = RE.created.exec(content))) {
			const w = icalToWall(phpTrim(m[1]), ctx);
			if (w !== null) this.created = formatYmdHis(w);
		}
		if ((m = RE.updated.exec(content))) {
			const w = icalToWall(phpTrim(m[1]), ctx);
			if (w !== null) this.updated = formatYmdHis(w);
		}
		return this;
	}

	isRecurrent(): boolean {
		return !!this.recurrence && ['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY'].includes(String(this.recurrence.freq));
	}

	clone(): ICalEvent {
		const e = Object.create(Object.getPrototypeOf(this)) as ICalEvent;
		Object.assign(e, this);
		return e;
	}

	/** Move this (cloned) event to the date of an occurrence, keeping start time and duration. */
	fixOccurringDate(timestamp: Wall): void {
		if (this._timeStart === undefined || timestamp === this._timeStart) return;
		const duration = this.duration();
		// keep the original time of day, take the occurrence's date
		this._timeStart = midnight(timestamp) + timeOfDay(this._timeStart);
		this.dateStart = formatYmdHis(this._timeStart);
		if (this.ctx.fix.fixDstDurations && this.dateOnly) {
			this._timeEnd = this._timeStart + duration;
		} else {
			// PHP: $_timeEnd = $_timeStart + $duration, in real seconds
			this._timeEnd = instantToWall(wallToInstant(this._timeStart, this.ctx.tz) + duration, this.ctx.tz);
		}
		this.dateEnd = formatYmdHis(this._timeEnd);
	}

	protected _isExdate(date: Wall): boolean {
		return this.exdate.includes(formatYmd(date));
	}

	protected _calculateOccurrences(): Wall[] {
		if (this._timeStart === undefined) return [];
		let occurrences: Wall[] = [this._timeStart];

		if (this.isRecurrent()) {
			const rec = this.recurrence!;
			let count = rec.count ?? null;
			const until = rec.until !== undefined ? icalToWall(String(rec.until).replace(/[-: ]/g, '').replace(/^(\d{8})(\d{6})$/, '$1T$2'), this.ctx) : null;
			const freq = String(rec.freq);
			const next = (o: Wall) =>
				freq === 'YEARLY'
					? this._nextYearlyOccurrence(o)
					: freq === 'MONTHLY'
						? this._nextMonthlyOccurrence(o)
						: freq === 'WEEKLY'
							? this._nextWeeklyOccurrence(o)
							: this._nextDailyOccurrence(o);

			// UNTIL comparison: PHP compares the raw step value with "<"; the fix compares
			// the real start of the occurrence (time of day applied) with "<=".
			const inclusive = this.ctx.fix.fixUntilInclusive && !rec._openEnded;
			const startTod = timeOfDay(this._timeStart);
			const beforeUntil = (o: Wall) =>
				inclusive ? midnight(o) + startTod <= until! : o < until!;

			let offset: Wall = this._timeStart;
			let occurrence: Wall | undefined;
			let guard = 0;
			let cont = until !== null ? beforeUntil(offset) : (count ?? 0) > 1;
			while (cont) {
				if (occurrence !== undefined) {
					if (!this._isExdate(occurrence)) {
						occurrences.push(occurrence);
						if (count !== null) count--;
					}
				}
				const n = next(offset);
				// PHP walks into 1970 here and the series effectively ends; stop instead.
				if (n === undefined || ++guard > 200_000) break;
				occurrence = n;
				offset = n;
				cont = until !== null ? beforeUntil(offset) : (count ?? 0) > 1;
			}
		}

		if (occurrences.length && this._isExdate(occurrences[0])) {
			occurrences = occurrences.slice(1);
		}
		return occurrences;
	}

	protected _interval(): number {
		const i = this.recurrence?.interval;
		return i === undefined ? 1 : i;
	}

	protected _nextYearlyOccurrence(offset: Wall): Wall {
		return addYears(offset, this._interval());
	}

	protected _nextMonthlyOccurrence(offset: Wall): Wall | undefined {
		let interval = this._interval();
		const rec = this.recurrence!;

		// INTERVAL IS BY (COUNT)DAYNAME
		if (rec.byday) {
			const dates: (Wall | undefined)[] = [];
			const horizonMonth = (() => {
				const h = addMonths(this.ctx.nowWall, interval * 12);
				return year(h) * 100 + month(h);
			})();
			for (const pattern of rec.byday) {
				const m = /([-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)/m.exec(pattern);
				if (!m) continue;
				// PHP: unmatched optional group is "" and isset("") is true, so (int)"" = 0
				const recurrenceOffset = m[1] !== undefined ? parseInt(m[1], 10) : 0;
				const dow = dayCodeToIndex(m[2]);

				let forDT: Wall = this.ctx.fix.fixMonthlyStepping ? wall(year(offset), month(offset), 1) : offset;
				for (
					let ym = year(offset) * 100 + month(offset);
					ym <= horizonMonth;
					forDT = addMonths(forDT, interval), ym = year(forDT) * 100 + month(forDT)
				) {
					const first = thisOrNextWeekday(wall(year(forDT), month(forDT), 1), dow);
					const daysInMonth: Wall[] = [];
					for (let d = first; month(d) === month(forDT); d = addDays(d, 7)) daysInMonth.push(d);
					dates.push(
						recurrenceOffset < 0
							? daysInMonth[daysInMonth.length + recurrenceOffset]
							: daysInMonth[recurrenceOffset - 1],
					);
				}
			}
			// PHP sort(): nulls sort first and never pass "> $offset"
			const valid = dates.filter((d): d is Wall => d !== undefined).sort((a, b) => a - b);
			for (const date of valid) if (date > offset) return date;
		}

		// INTERVAL IS BY DAYNUMBER OF MONTH
		const bymonthday =
			rec.bymonthday !== undefined ? String(rec.bymonthday).split(',') : [String(dayOfMonth(offset)).padStart(2, '0')];
		const start = wall(year(offset), month(offset), 1) + timeOfDay(offset);

		if (!this.ctx.compat && this.ctx.fix.fixMonthlyStepping) {
			// Correct version: smallest valid month-day > offset, stepping `interval` months.
			const candidates: Wall[] = [];
			for (let k = 0; k <= 48 && candidates.length === 0; k += interval || 1) {
				const base = addMonths(start, k);
				if (month(base) !== ((month(start) - 1 + k) % 12) + 1) continue;
				for (const raw of bymonthday) {
					const n = parseInt(raw, 10);
					if (!n) continue;
					const dim = dayOfMonth(addDays(addMonths(wall(year(base), month(base), 1), 1), -1));
					const dnum = n > 0 ? n : dim + n + 1;
					if (dnum < 1 || dnum > dim) continue;
					const w = wall(year(base), month(base), dnum) + timeOfDay(offset);
					if (w > offset) candidates.push(w);
				}
			}
			candidates.sort((a, b) => a - b);
			return candidates[0];
		}

		const dates: Wall[] = [];
		for (const d of bymonthday) {
			const dayN = parseInt(d, 10) || 0;
			// this month
			dates.push(addDays(start, dayN - 1));
			// next 'interval' month
			let tmp = addMonths(start, interval);
			let time = addDays(tmp, dayN - 1);
			if (dayOfMonth(time) === dayN) dates.push(time);
			// 2x 'interval' month (PHP compares string === int here, so this never adds a date)
			interval *= 2;
			tmp = addMonths(start, interval);
			time = addDays(tmp, dayN - 1);
		}
		dates.sort((a, b) => a - b);
		for (const date of dates) if (date > offset) return date;
		return undefined;
	}

	protected _nextWeeklyOccurrence(offset: Wall): Wall | undefined {
		const interval = this._interval();
		const byday = this.recurrence?.byday ?? [DAY_CODES[weekday(offset)]];
		const start = weekday(offset) !== 1 ? lastWeekdayStrict(offset, 1) : offset;

		const dates: Wall[] = [];
		for (const code of byday) {
			const dow = dayCodeToIndex(code);
			if (dow < 0) continue;
			// this week
			dates.push(thisOrNextWeekday(start, dow));
			// next 'interval' week
			dates.push(thisOrNextWeekday(addDays(start, 7 * interval), dow));
		}
		dates.sort((a, b) => a - b);
		for (const date of dates) if (date > offset) return date;
		return undefined;
	}

	protected _nextDailyOccurrence(offset: Wall): Wall {
		return addDays(offset, this._interval());
	}
}

export class ICal {
	title: string | null = null;
	description: string | null = null;
	events: ICalEvent[] = [];
	protected _eventsByDate?: Map<string, ICalEvent[]>;
	protected ctx: Ctx;

	constructor(content: string, options: ParseOptions & { horizon?: Wall | null }) {
		const compat = !!options.phpCompat;
		const on = (v: boolean | undefined) => (compat ? false : v !== false);
		this.ctx = {
			tz: options.timeZone,
			nowWall: instantToWall((options.now ?? new Date()).getTime(), options.timeZone),
			compat,
			fix: {
				fixTzid: on(options.fixTzid),
				fixExdateLists: on(options.fixExdateLists),
				fixOpenEndedRules: on(options.fixOpenEndedRules),
				fixUntilInclusive: on(options.fixUntilInclusive),
				fixMovedInstances: on(options.fixMovedInstances),
				fixDstDurations: on(options.fixDstDurations),
				fixMonthlyStepping: on(options.fixMonthlyStepping),
				fixTextParsing: on(options.fixTextParsing),
				fixMissingEnd: on(options.fixMissingEnd),
			},
			horizon: options.horizon ?? null,
		};
		if (content) this.parse(content);
	}

	parse(content: string): this {
		content = this.ctx.fix.fixTextParsing ? content.replace(/\r?\n[ \t]/g, '') : content.split('\r\n ').join('');
		let m = /^X-WR-CALNAME:(.*)$/m.exec(content);
		this.title = m ? phpTrim(m[1]) : null;
		m = /^X-WR-CALDESC:(.*)$/m.exec(content);
		this.description = m ? phpTrim(m[1]) : null;
		// PHP: preg_match_all('`BEGIN:VEVENT(.+)END:VEVENT`Us') - ungreedy, dot matches newlines
		for (const em of content.matchAll(/BEGIN:VEVENT([\s\S]+?)END:VEVENT/g)) {
			this.events.push(new ICalEvent(em[0], this.ctx));
		}
		return this;
	}

	eventsByDate(): Map<string, ICalEvent[]> {
		if (this._eventsByDate) return this._eventsByDate;
		const tmp = new Map<string, { key: Wall; seq: number; ev: ICalEvent }[]>();
		let seq = 0;
		for (const event of this.events) {
			for (const occurrence of event.occurrences()) {
				const date = formatYmd(occurrence);
				const ne = event.clone();
				ne.fixOccurringDate(occurrence);
				if (!tmp.has(date)) tmp.set(date, []);
				tmp.get(date)!.push({ key: ne._timeStart!, seq: seq++, ev: ne });
			}
		}
		const sortedDates = [...tmp.keys()].sort();
		const out = new Map<string, ICalEvent[]>();
		for (const d of sortedDates) {
			out.set(
				d,
				tmp
					.get(d)!
					.sort((a, b) => a.key - b.key || a.seq - b.seq)
					.map((x) => x.ev),
			);
		}

		// prevent duplicates for edited dates in recurring events
		for (const [dateKey, list] of out) {
			const overrides = list.filter((e) => e.recurrenceId);
			if (!overrides.length) continue;
			const uids = new Set(overrides.map((e) => e.uid));
			out.set(
				dateKey,
				list.filter((e) => !(uids.has(e.uid) && !e.recurrenceId)),
			);
		}
		if (this.ctx.fix.fixMovedInstances) {
			// also drop the original slot of an instance that was moved to another day
			const moved = new Set<string>();
			for (const e of this.events) {
				if (e.recurrenceId && e.uid && e._recurrenceId !== undefined) moved.add(`${e.uid}|${formatYmd(e._recurrenceId)}`);
			}
			if (moved.size) {
				for (const [dateKey, list] of out) {
					out.set(
						dateKey,
						list.filter((e) => e.recurrenceId || !moved.has(`${e.uid}|${dateKey}`)),
					);
				}
			}
		}
		this._eventsByDate = out;
		return out;
	}

	/** PHP eventsByDateUntil(): every date up to and including `end` (yyyy-mm-dd). */
	eventsByDateUntil(end: string): Map<string, ICalEvent[]> {
		const out = new Map<string, ICalEvent[]>();
		for (const [date, events] of this.eventsByDate()) if (date <= end) out.set(date, events);
		return out;
	}

	/** PHP eventsByDateBetween(): start <= date < end. */
	eventsByDateBetween(start: string, end: string): Map<string, ICalEvent[]> {
		const out = new Map<string, ICalEvent[]>();
		for (const [date, events] of this.eventsByDate()) if (start <= date && date < end) out.set(date, events);
		return out;
	}
}

// ---------------------------------------------------------------------------
// index.php getEvents() port: group events into days, spreading multi-day ones
// ---------------------------------------------------------------------------

export interface DayEvent {
	title: string;
	fullday: boolean;
	/** "HH:mm" for timed events, "YYYY-MM-DD" for full-day ones (as in trmnl-calendar) */
	start: string;
	end: string;
	location?: string;
	description?: string;
	status?: string;
	uid?: string;
	/** wall-clock start/end, "YYYY-MM-DD HH:mm:ss" in the chosen time zone */
	startDateTime: string;
	endDateTime: string;
}

export interface ScheduleOptions extends ParseOptions {
	/** First day, YYYY-MM-DD in timeZone. Defaults to today. */
	startDate?: string;
	/** Number of days including startDate. */
	days: number;
	/** Drop STATUS:CANCELLED events. */
	skipCancelled?: boolean;
}

export function buildSchedule(icsText: string, opts: ScheduleOptions): Map<string, DayEvent[]> {
	const tz = opts.timeZone;
	const nowWall = instantToWall((opts.now ?? new Date()).getTime(), tz);
	const first = opts.startDate
		? wall(+opts.startDate.slice(0, 4), +opts.startDate.slice(5, 7), +opts.startDate.slice(8, 10))
		: midnight(nowWall);
	const lastDay = addDays(first, Math.max(1, opts.days) - 1);
	const horizon = addDays(lastDay, 1) - 1000; // 23:59:59 on the last day

	const ical = new ICal(icsText, { ...opts, horizon });
	const schedule = ical.eventsByDateUntil(formatYmd(lastDay));

	const temp = new Map<string, DayEvent[]>();
	for (let i = 0; i < Math.max(1, opts.days); i++) temp.set(formatYmd(addDays(first, i)), []);

	const fmt = (e: ICalEvent, fullday: boolean): DayEvent => {
		const s = e._timeStart!;
		const en = e._timeEnd ?? e._timeStart!;
		const out: DayEvent = {
			title: e.summary ?? '',
			fullday,
			start: fullday ? formatYmd(s) : formatHi(s),
			end: fullday ? formatYmd(en) : formatHi(en),
			startDateTime: formatYmdHis(s),
			endDateTime: formatYmdHis(en),
		};
		if (e.location !== undefined) out.location = e.location;
		if (e.description !== undefined) out.description = e.description;
		if (e.status !== undefined) out.status = e.status;
		if (e.uid !== undefined) out.uid = e.uid;
		return out;
	};

	for (const events of schedule.values()) {
		for (const event of events) {
			if (event._timeStart === undefined) continue;
			if (opts.skipCancelled && String(event.status ?? '').toUpperCase() === 'CANCELLED') continue;
			const end = event._timeEnd ?? event._timeStart;
			const dateDiff = wholeDaysBetween(event._timeStart, end);
			if (dateDiff === 0) {
				const key = formatYmd(event._timeStart);
				temp.get(key)?.push(fmt(event, false));
			} else {
				for (let i = 0; i < dateDiff; i++) {
					const key = formatYmd(addDays(event._timeStart, i));
					temp.get(key)?.push(fmt(event, true));
				}
			}
		}
	}
	return temp;
}

export { DAY_MS };
