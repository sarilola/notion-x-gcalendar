/***********************************
 script made by sari on dc ;)
************************************/

import * as dotenv from 'dotenv';
import path from 'node:path';

// load environment variables from a local .env file
dotenv.config({ path: path.resolve(__dirname, '.env') });

import {
  Client,
  isFullPage,
  isNotionClientError,
  APIErrorCode,
} from '@notionhq/client';
import { google, calendar_v3 } from 'googleapis';
import {
  PageObjectResponse,
  QueryDataSourceParameters,
  QueryDataSourceResponse,
} from '@notionhq/client';

// initialize the Notion client pinned to the current stable API version (v5 SDK default)
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  notionVersion: '2025-09-03',
});

// configure Google OAuth2 client with credentials and redirect URI
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);

// set persistent refresh token for Google API access
oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

// initialize Google Calendar API instance
const calendar = google.calendar({
  version: 'v3',
  auth: oauth2Client,
});

// define target databases and their corresponding Google Calendar names
const syncTargets = [
  { id: process.env.DATABASE_ID1 as string, name: 'Homework' },
  { id: process.env.DATABASE_ID2 as string, name: 'Assessments' },
];

// Notion query filter type supporting timestamp, property, and logical operators
type NotionQueryFilter =
  | { timestamp: 'last_edited_time'; last_edited_time: { on_or_after: string } }
  | { timestamp: 'created_time';     created_time:     { on_or_after: string } }
  | { property: string;              rich_text:        { is_empty: true } }
  | { or: Array<NotionQueryFilter> }
  | { and: Array<NotionQueryFilter> };

/**
 * Resolves the data_source_id and property schema for a given Notion database.
 */
async function getDataSourceInfo(databaseId: string): Promise<{ dataSourceId: string; hasGCalProp: boolean; gCalPropName: string }> {
  const db = await notion.databases.retrieve({ database_id: databaseId });

  const sources = (db as any).data_sources as Array<{ id: string; name: string }> | undefined;
  if (!sources || sources.length === 0) {
    throw new Error(`No data sources found for database ${databaseId}. Make sure the integration has access.`);
  }

  const props = (db as any).properties || {};
  let gCalPropName = 'GCal_ID';
  let hasGCalProp = false;

  for (const key of Object.keys(props)) {
    const normalized = key.toLowerCase().replace(/[-_ ]/g, '');
    if (normalized === 'gcalid' || normalized === 'googlecalendarid') {
      gCalPropName = key;
      hasGCalProp = true;
      break;
    }
  }

  if ('GCal_ID' in props) {
    gCalPropName = 'GCal_ID';
    hasGCalProp = true;
  }

  return {
    dataSourceId: sources[0].id,
    hasGCalProp,
    gCalPropName,
  };
}

/**
 * Fetches ALL pages from a Notion data source matching the filter, handling pagination.
 */
async function queryAllPages(
  dataSourceId: string,
  filter: NotionQueryFilter
): Promise<PageObjectResponse[]> {
  const results: PageObjectResponse[] = [];
  let cursor: string | undefined = undefined;

  do {
    const response = await (notion as any).dataSources.query({
      data_source_id: dataSourceId,
      filter,
      ...(cursor ? { start_cursor: cursor } : {}),
    }) as { results: unknown[]; has_more: boolean; next_cursor: string | null };

    for (const page of response.results) {
      if (isFullPage(page as any)) {
        results.push(page as PageObjectResponse);
      }
    }

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return results;
}

/**
 * Extracts task title flexibly regardless of column naming.
 */
function getTaskTitle(page: PageObjectResponse): string {
  const props = page.properties;
  const titleProp =
    props['Task'] ||
    props['Name'] ||
    props['Tarea'] ||
    props['Title'] ||
    props['Nombre'] ||
    Object.values(props).find((p) => p.type === 'title');

  if (titleProp && titleProp.type === 'title' && titleProp.title.length > 0) {
    return titleProp.title.map((t) => t.plain_text).join('').trim() || 'Untitled Task';
  }
  return 'Untitled Task';
}

/**
 * Extracts Due Date date object from page properties.
 */
function getDueDate(page: PageObjectResponse): { start: string; end: string | null } | null {
  const props = page.properties;
  const dateProp =
    props['Due Date'] ||
    props['Due date'] ||
    props['Date'] ||
    props['Fecha'] ||
    props['Fecha límite'] ||
    props['Entrega'] ||
    Object.values(props).find((p) => p.type === 'date');

  if (dateProp && dateProp.type === 'date' && dateProp.date) {
    return dateProp.date;
  }
  return null;
}

/**
 * Resolves the GCal_ID property name on a specific page.
 */
function getGCalPropName(page: PageObjectResponse): string {
  const props = page.properties;
  if ('GCal_ID' in props) return 'GCal_ID';
  if ('GCal ID' in props) return 'GCal ID';
  if ('gcal_id' in props) return 'gcal_id';
  const found = Object.keys(props).find((k) => k.toLowerCase().replace(/[-_ ]/g, '') === 'gcalid');
  return found || 'GCal_ID';
}

/**
 * Extracts GCal_ID from page properties if already synced.
 */
function getGCalId(page: PageObjectResponse): string | undefined {
  const propName = getGCalPropName(page);
  const prop = page.properties[propName];
  if (prop && prop.type === 'rich_text' && prop.rich_text.length > 0) {
    return prop.rich_text[0].plain_text.trim();
  }
  return undefined;
}

/**
 * Checks if task is marked as Done / Completed across various property types.
 */
function isTaskDone(page: PageObjectResponse): boolean {
  const props = page.properties;
  const statusProp =
    props['Status'] ||
    props['Estado'] ||
    props['Done'] ||
    Object.values(props).find(
      (p) =>
        p.type === 'status' ||
        p.type === 'checkbox' ||
        (p.type === 'select' && (p as any).name?.toLowerCase().includes('status'))
    );

  if (!statusProp) return false;

  const doneKeywords = ['done', 'completada', 'completado', 'listo', 'finalizada', 'hecho', 'finished', 'closed'];

  if (statusProp.type === 'status') {
    const name = statusProp.status?.name?.trim().toLowerCase() || '';
    return doneKeywords.includes(name);
  }

  if (statusProp.type === 'select') {
    const name = statusProp.select?.name?.trim().toLowerCase() || '';
    return doneKeywords.includes(name);
  }

  if (statusProp.type === 'checkbox') {
    return statusProp.checkbox === true;
  }

  return false;
}

/**
 * Computes exclusive end date for Google Calendar all-day events.
 * For all-day events, GCal expects end.date = day after the last active day.
 */
function formatAllDayEnd(startDate: string, endDate: string | null): string {
  const target = endDate || startDate;
  const [year, month, day] = target.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

/**
 * Computes end time for timed events, defaulting to +1 hour if end time is unspecified.
 */
function formatTimedEnd(startIso: string, endIso: string | null): string {
  if (endIso && endIso !== startIso) {
    return endIso;
  }
  const startDate = new Date(startIso);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  return endDate.toISOString();
}

/**
 * Creates a new event or updates an existing one in Google Calendar.
 */
async function upsertEvent(
  calendarId: string,
  dbName: string,
  page: PageObjectResponse,
  calendar: calendar_v3.Calendar
): Promise<void> {
  const taskName = getTaskTitle(page);
  const dueDate = getDueDate(page);
  const gCalId = getGCalId(page);
  const gCalPropName = getGCalPropName(page);

  if (!dueDate) {
    console.warn(`  [SKIP] "${taskName}" has no Due Date.`);
    return;
  }

  const isAllDay = !dueDate.start.includes('T');
  const start = isAllDay
    ? { date: dueDate.start }
    : { dateTime: dueDate.start, timeZone: 'America/Guayaquil' };
  const end = isAllDay
    ? { date: formatAllDayEnd(dueDate.start, dueDate.end) }
    : { dateTime: formatTimedEnd(dueDate.start, dueDate.end), timeZone: 'America/Guayaquil' };

  const eventBody: calendar_v3.Schema$Event = {
    summary: taskName,
    description: `Synced from Notion database with sari's script: ${dbName}`,
    start,
    end,
  };

  try {
    if (!gCalId) {
      // no GCal_ID stored → create new Google Calendar event
      const res = await calendar.events.insert({
        calendarId,
        requestBody: eventBody,
      });

      if (res.data.id) {
        // write new event ID back into Notion
        await notion.pages.update({
          page_id: page.id,
          properties: {
            [gCalPropName]: { rich_text: [{ text: { content: res.data.id } }] },
          },
        });
        console.log(`  [CREATED] ${taskName}`);
      }
    } else {
      // GCal_ID exists → update existing Google Calendar event
      await calendar.events.update({
        calendarId,
        eventId: gCalId,
        requestBody: eventBody,
      });
      console.log(`  [UPDATED] ${taskName}`);
    }
  } catch (error: unknown) {
    if (isNotionClientError(error)) {
      console.error(`  [ERROR] Notion error for "${taskName}":`, error.message);
      return;
    }

    const gcalError = error as { code?: number; message?: string };

    if (gcalError.code === 404) {
      // event was manually deleted from GCal — clear stale ID so next run recreates it
      console.warn(`  [WARN] "${taskName}" not found in GCal (404). Clearing ${gCalPropName} for recreation on next run.`);
      await notion.pages.update({
        page_id: page.id,
        properties: { [gCalPropName]: { rich_text: [] } },
      });
    } else {
      console.error(`  [ERROR] Failed to upsert "${taskName}":`, gcalError.message);
    }
  }
}

/**
 * Removes a Google Calendar event and clears its ID in Notion.
 */
async function deleteEvent(
  calendarId: string,
  page: PageObjectResponse,
  calendar: calendar_v3.Calendar
): Promise<void> {
  const taskName = getTaskTitle(page);
  const gCalId = getGCalId(page);
  const gCalPropName = getGCalPropName(page);

  // nothing to delete if the task was never synced to Google Calendar
  if (!gCalId) return;

  try {
    await calendar.events.delete({ calendarId, eventId: gCalId });

    await notion.pages.update({
      page_id: page.id,
      properties: { [gCalPropName]: { rich_text: [] } },
    });

    console.log(`  [DELETED] ${taskName}`);
  } catch (error: unknown) {
    const gcalError = error as { code?: number; message?: string };

    if (gcalError.code === 410 || gcalError.code === 404) {
      console.warn(`  [WARN] "${taskName}" already gone from GCal. Cleaning stale ${gCalPropName} in Notion.`);
      await notion.pages.update({
        page_id: page.id,
        properties: { [gCalPropName]: { rich_text: [] } },
      });
    } else {
      console.error(`  [ERROR] Failed to delete "${taskName}":`, gcalError.message);
    }
  }
}

/**
 * Orchestrates synchronization between Notion databases and Google Calendar.
 */
async function sync(): Promise<void> {
  // 4-hour (240 minutes) lookback window provides a wide buffer against GitHub Actions delays
  const lookbackMinutes = 240;
  const lookbackTimestamp = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString();

  console.log('====================================================');
  console.log('        NOTION X GOOGLE CALENDAR SYNC ENGINE');
  console.log('           DEVELOPED BY: Sara Chiriboga');
  console.log('            STARTING SYNCHRONIZATION...');
  console.log('====================================================\n');
  console.log(`[INIT] Lookback buffer: ${lookbackMinutes} min (changes since ${lookbackTimestamp})\n`);

  try {
    const calListResponse = await calendar.calendarList.list();
    const googleCalendars = calListResponse.data.items || [];

    for (const db of syncTargets) {
      if (!db.id) {
        console.warn(`[DATABASE] "${db.name}" has no database ID configured in environment variables. Skipping.`);
        continue;
      }

      console.log(`[DATABASE] "${db.name}"`);

      // --- Step 1: resolve data source and schema info ---
      let dbInfo: { dataSourceId: string; hasGCalProp: boolean; gCalPropName: string };
      try {
        dbInfo = await getDataSourceInfo(db.id);
        console.log(`  > Data source ID resolved: ${dbInfo.dataSourceId}`);
      } catch (err: any) {
        console.error(`  > [ERROR] Could not resolve data source for "${db.name}": ${err.message}`);
        continue;
      }

      // --- Step 2: find or create the matching Google Calendar ---
      const existingCal = googleCalendars.find(
        (cal: calendar_v3.Schema$CalendarListEntry) => cal.summary === db.name
      );

      let targetCalendarId: string;

      if (existingCal) {
        console.log(`  > Google Calendar: found existing`);
        targetCalendarId = existingCal.id!;
      } else {
        console.log(`  > Google Calendar: not found — creating`);
        const res = await calendar.calendars.insert({
          requestBody: {
            summary: db.name,
            timeZone: 'America/Guayaquil',
          },
        });
        targetCalendarId = res.data.id!;
        console.log(`  > Google Calendar: "${db.name}" created`);
      }

      // --- Step 3: query Notion for changed tasks OR unsynced tasks ---
      console.log(`  > Querying Notion for recent changes and unsynced tasks...`);

      // Build compound filter: (edited in lookback window) OR (has no GCal_ID yet)
      let queryFilter: NotionQueryFilter;
      if (dbInfo.hasGCalProp) {
        queryFilter = {
          or: [
            {
              timestamp: 'last_edited_time',
              last_edited_time: { on_or_after: lookbackTimestamp },
            },
            {
              property: dbInfo.gCalPropName,
              rich_text: { is_empty: true },
            },
          ],
        };
      } else {
        console.warn(`  > [NOTICE] Property "${dbInfo.gCalPropName}" not found in database. Using timestamp filter only.`);
        queryFilter = {
          timestamp: 'last_edited_time',
          last_edited_time: { on_or_after: lookbackTimestamp },
        };
      }

      let pages: PageObjectResponse[];
      try {
        pages = await queryAllPages(dbInfo.dataSourceId, queryFilter);
      } catch (err: any) {
        console.warn(`  > [WARN] Compound query failed (${err.message}). Retrying with timestamp-only filter...`);
        try {
          pages = await queryAllPages(dbInfo.dataSourceId, {
            timestamp: 'last_edited_time',
            last_edited_time: { on_or_after: lookbackTimestamp },
          });
        } catch (retryErr: any) {
          console.error(`  > [ERROR] Query failed for "${db.name}": ${retryErr.message}`);
          continue;
        }
      }

      console.log(`  > Found ${pages.length} page(s) to process\n`);

      if (pages.length === 0) {
        console.log(`  > No changes detected.\n`);
        continue;
      }

      // --- Step 4: process each changed page ---
      for (const page of pages) {
        if (isTaskDone(page)) {
          await deleteEvent(targetCalendarId, page, calendar);
        } else {
          await upsertEvent(targetCalendarId, db.name, page, calendar);
        }

        // respect Notion's rate limit of ~3 requests/second
        await new Promise((res) => setTimeout(res, 350));
      }

      console.log();
    }

    console.log('[FINISH] Synchronization complete.');
  } catch (error: any) {
    console.error('\n[CRITICAL ERROR] Sync failed:', error.message);
    if (error.response?.data) {
      console.error('  > Details:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

// execute the synchronization workflow
sync();