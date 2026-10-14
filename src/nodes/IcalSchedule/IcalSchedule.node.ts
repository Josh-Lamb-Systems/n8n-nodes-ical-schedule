import {
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	NodeConnectionTypes,
	NodeOperationError,
} from 'n8n-workflow';

import { buildSchedule, type DayEvent } from '../../ical/ICal';
import { addDays, formatIsoOffset, formatYmd, instantToWall, isValidTimeZone, midnight, wall } from '../../ical/localTime';

type Range = 'today' | 'tomorrow' | 'nextDays' | 'custom';
type Output = 'summary' | 'days' | 'events';

export class IcalSchedule implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'iCal Schedule',
		name: 'icalSchedule',
		icon: 'file:icalSchedule.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ { today: "Today", tomorrow: "Tomorrow", nextDays: "Next " + $parameter["days"] + " days", custom: "Custom range" }[$parameter["range"]] }}',
		description: 'Read an iCal (.ics) feed and list the appointments for today or a range of days',
		defaults: { name: 'iCal Schedule' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		properties: [
			{
				displayName: 'Source',
				name: 'source',
				type: 'options',
				options: [
					{ name: 'Feed URL', value: 'url', description: 'Download the .ics from a URL (https:// or webcal://)' },
					{ name: 'iCal Text', value: 'text', description: 'Use .ics text from an earlier node, e.g. an HTTP Request' },
				],
				default: 'url',
			},
			{
				displayName: 'Feed URL',
				name: 'url',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://calendar.google.com/calendar/ical/.../basic.ics',
				description: 'Secret iCal address of the calendar. Anyone with this URL can read the calendar.',
				displayOptions: { show: { source: ['url'] } },
			},
			{
				displayName: 'iCal Text',
				name: 'icsText',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '={{ $json.data }}',
				required: true,
				description: 'The raw .ics content',
				displayOptions: { show: { source: ['text'] } },
			},
			{
				displayName: 'Range',
				name: 'range',
				type: 'options',
				options: [
					{ name: 'Today', value: 'today' },
					{ name: 'Tomorrow', value: 'tomorrow' },
					{ name: 'Next X Days', value: 'nextDays', description: 'Starting today' },
					{ name: 'Custom', value: 'custom' },
				],
				default: 'today',
			},
			{
				displayName: 'Days',
				name: 'days',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 366 },
				default: 7,
				description: 'Number of days to include, counting the first day',
				displayOptions: { show: { range: ['nextDays', 'custom'] } },
			},
			{
				displayName: 'Start Date',
				name: 'startDate',
				type: 'string',
				default: '={{ $today.toFormat("yyyy-MM-dd") }}',
				placeholder: 'yyyy-MM-dd',
				description: 'First day of the range, as yyyy-MM-dd',
				displayOptions: { show: { range: ['custom'] } },
			},
			{
				displayName: 'Output',
				name: 'output',
				type: 'options',
				options: [
					{
						name: 'Summary',
						value: 'summary',
						description: 'One item with the events and a sentence ready to be read aloud (good for voice agents)',
					},
					{ name: 'One Item per Day', value: 'days', description: 'Like trmnl-calendar: each day with its events' },
					{ name: 'One Item per Event', value: 'events' },
				],
				default: 'summary',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Time Zone',
						name: 'timeZone',
						type: 'string',
						default: '',
						placeholder: 'America/New_York',
						description: "IANA time zone used to decide what 'today' is and to show times. Leave empty to use the workflow's time zone.",
					},
					{
						displayName: 'Include All-Day Events',
						name: 'includeAllDay',
						type: 'boolean',
						default: true,
					},
					{
						displayName: 'Skip Cancelled Events',
						name: 'skipCancelled',
						type: 'boolean',
						default: true,
						description: 'Whether to leave out events marked STATUS:CANCELLED',
					},
					{
						displayName: 'Include Descriptions',
						name: 'includeDescription',
						type: 'boolean',
						default: false,
						description: 'Whether to include each event’s description (can be long)',
					},
					{
						displayName: 'Time Format',
						name: 'timeFormat',
						type: 'options',
						options: [
							{ name: '12-Hour (9:00 AM)', value: '12h' },
							{ name: '24-Hour (09:00)', value: '24h' },
						],
						default: '12h',
						description: 'Format for the "time" fields and the summary sentence',
					},
					{
						displayName: 'Timeout (ms)',
						name: 'timeout',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 15000,
						description:
							'How long to wait for the feed before giving up. Combine a short timeout with Settings → Retry On Fail to retry slow requests.',
					},
					{
						displayName: 'Match Original PHP Output Exactly',
						name: 'phpCompat',
						type: 'boolean',
						default: false,
						description:
							'Whether to reproduce the trmnl-calendar PHP parser bug-for-bug (time zones in TZID ignored, 500-occurrence cap, etc.). Only useful for comparing results.',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const feedCache = new Map<string, string>();

		for (let i = 0; i < items.length; i++) {
			try {
				const source = this.getNodeParameter('source', i) as 'url' | 'text';
				const range = this.getNodeParameter('range', i) as Range;
				const output = this.getNodeParameter('output', i) as Output;
				const options = this.getNodeParameter('options', i, {}) as {
					timeZone?: string;
					includeAllDay?: boolean;
					skipCancelled?: boolean;
					includeDescription?: boolean;
					timeFormat?: '12h' | '24h';
					timeout?: number;
					phpCompat?: boolean;
				};

				const timeZone = (options.timeZone || this.getTimezone() || 'UTC').trim();
				if (!isValidTimeZone(timeZone)) {
					throw new NodeOperationError(this.getNode(), `Unknown time zone "${timeZone}"`, { itemIndex: i });
				}

				// ---- get the .ics text ----
				let ics: string;
				if (source === 'url') {
					let url = String(this.getNodeParameter('url', i)).trim();
					if (/^webcals?:\/\//i.test(url)) url = url.replace(/^webcals?:\/\//i, 'https://');
					if (!/^https?:\/\//i.test(url)) {
						throw new NodeOperationError(this.getNode(), 'Feed URL must start with https://, http:// or webcal://', { itemIndex: i });
					}
					if (!feedCache.has(url)) {
						const timeout = Math.max(1, Math.floor(options.timeout ?? 15000));
						let body: unknown;
						try {
							body = await this.helpers.httpRequest({
								method: 'GET',
								url,
								json: false,
								encoding: 'text',
								timeout,
								headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1' },
							});
						} catch (error) {
							if ((error as { code?: string }).code === 'ECONNABORTED' || /timeout of \d+ms exceeded/.test((error as Error).message)) {
								throw new NodeOperationError(this.getNode(), `The feed did not respond within ${timeout} ms`, {
									itemIndex: i,
									description: 'Raise Options → Timeout (ms), or turn on Settings → Retry On Fail to try again.',
								});
							}
							throw error;
						}
						feedCache.set(url, typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
					}
					ics = feedCache.get(url)!;
				} else {
					ics = String(this.getNodeParameter('icsText', i) ?? '');
				}
				if (!ics.includes('BEGIN:VCALENDAR')) {
					throw new NodeOperationError(
						this.getNode(),
						'The feed did not return iCal data (no BEGIN:VCALENDAR). Check the URL or the input field.',
						{ itemIndex: i },
					);
				}

				// ---- work out the date range ----
				const todayWall = midnight(instantToWall(Date.now(), timeZone));
				let startDate: string;
				let days = 1;
				if (range === 'today') startDate = formatYmd(todayWall);
				else if (range === 'tomorrow') startDate = formatYmd(addDays(todayWall, 1));
				else {
					days = Math.max(1, Math.min(366, Math.floor(this.getNodeParameter('days', i, 7) as number)));
					if (range === 'custom') {
						startDate = String(this.getNodeParameter('startDate', i)).trim().slice(0, 10);
						if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
							throw new NodeOperationError(this.getNode(), `Start Date must be yyyy-MM-dd, got "${startDate}"`, { itemIndex: i });
						}
					} else startDate = formatYmd(todayWall);
				}

				// ---- parse ----
				const schedule = buildSchedule(ics, {
					timeZone,
					startDate,
					days,
					phpCompat: !!options.phpCompat,
					skipCancelled: options.skipCancelled !== false,
				});

				const timeFmt = options.timeFormat ?? '12h';
				const includeAllDay = options.includeAllDay !== false;
				const dayList = [...schedule.entries()].map(([date, events]) => ({
					date,
					label: dayLabel(date, todayWall),
					events: events
						.filter((e) => includeAllDay || !e.fullday)
						.map((e) => toEventJson(e, timeZone, timeFmt, !!options.includeDescription)),
				}));

				if (output === 'events') {
					for (const d of dayList) {
						for (const e of d.events) returnData.push({ json: { date: d.date, ...e }, pairedItem: { item: i } });
					}
				} else if (output === 'days') {
					for (const d of dayList) {
						returnData.push({
							json: {
								date: d.date,
								label: d.label,
								count: d.events.filter((e) => !e.allDay).length,
								events: d.events,
								summary: daySentence(d),
							},
							pairedItem: { item: i },
						});
					}
				} else {
					const total = dayList.reduce((n, d) => n + d.events.filter((e) => !e.allDay).length, 0);
					returnData.push({
						json: {
							timeZone,
							startDate,
							days,
							count: total,
							...(days === 1 ? { date: dayList[0].date, label: dayList[0].label, events: dayList[0].events } : { schedule: dayList }),
							summary: dayList.map(daySentence).join(' '),
						},
						pairedItem: { item: i },
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				if (error instanceof NodeOperationError) throw error;
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return [returnData];
	}
}

// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function dayLabel(date: string, todayWall: number): string {
	const w = wall(+date.slice(0, 4), +date.slice(5, 7), +date.slice(8, 10));
	const d = new Date(w);
	const base = `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
	const diff = Math.round((w - todayWall) / 86_400_000);
	if (diff === 0) return `today, ${base}`;
	if (diff === 1) return `tomorrow, ${base}`;
	return base;
}

function to12h(hhmm: string): string {
	const [h, m] = hhmm.split(':').map(Number);
	const suffix = h < 12 ? 'AM' : 'PM';
	return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function toEventJson(e: DayEvent, tz: string, fmt: '12h' | '24h', withDescription: boolean): IDataObject {
	const toWall = (s: string) =>
		wall(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16), +s.slice(17, 19));
	const out: IDataObject = {
		title: e.title,
		allDay: e.fullday,
		time: e.fullday ? 'All day' : fmt === '12h' ? to12h(e.start) : e.start,
		endTime: e.fullday ? '' : fmt === '12h' ? to12h(e.end) : e.end,
		start: formatIsoOffset(toWall(e.startDateTime), tz),
		end: formatIsoOffset(toWall(e.endDateTime), tz),
	};
	if (e.location) out.location = e.location;
	if (withDescription && e.description) out.description = e.description;
	if (e.status) out.status = e.status;
	if (e.uid) out.uid = e.uid;
	return out;
}

function daySentence(d: { label: string; events: IDataObject[] }): string {
	const timed = d.events.filter((e) => !e.allDay);
	const allDay = d.events.filter((e) => e.allDay);
	const label = d.label.startsWith('today') || d.label.startsWith('tomorrow') ? d.label : `on ${d.label}`;
	if (!timed.length && !allDay.length) return `No appointments ${label}.`;
	const parts: string[] = [];
	if (timed.length) {
		parts.push(
			`${timed.length} appointment${timed.length === 1 ? '' : 's'} ${label}: ` +
				timed.map((e) => `${e.time}, ${e.title}`).join('; ') +
				'.',
		);
	} else parts.push(`No timed appointments ${label}.`);
	if (allDay.length) parts.push(`All day: ${allDay.map((e) => e.title).join('; ')}.`);
	return parts.join(' ');
}
