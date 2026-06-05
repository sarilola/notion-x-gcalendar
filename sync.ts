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

// timestamp filter shape accepted by Notion's data source query endpoint.
// defined manually to stay compatible with older SDK versions that do not
// export QueryDataSourceParameters as a public type.
type NotionTimestampFilter =
  | { timestamp: 'last_edited_time'; last_edited_time: { on_or_after: string } }
  | { timestamp: 'created_time';     created_time:     { on_or_after: string } };

/**
 * Resolves the data_source_id for a given Notion database.
 *
 * In SDK v5 / API 2025-09-03, querying pages requires a data_source_id
 * instead of a database_id. The databases.retrieve() call returns a
 * `data_sources` array; for standard single-source databases there will
 * always be exactly one entry.
 */
async function getDataSourceId(databaseId: string): Promise<string> {
  const db = await notion.databases.retrieve({ database_id: databaseId });

  const sources = (db as any).data_sources as Array<{ id: string; name: string }> | undefined;

  if (!sources || sources.length === 0) {
    throw new Error(`No data sources found for database ${databaseId}. Make sure the integration has access.`);
  }

  return sources[0].id;
}

/**
 * Fetches ALL pages from a Notion data source that match a given filter,
 * automatically handling pagination to avoid the 100-result cap.
 *
 * Uses notion.dataSources.query() — the correct v5 SDK method.
 */
async function queryAllPages(
  dataSourceId: string,
  filter: NotionTimestampFilter
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
 * Creates a new event or updates an existing one in Google Calendar.
 * Checks the GCal_ID property in Notion to decide between insert and update.
 */
async function upsertEvent(
  calendarId: string,
  dbName: string,
  page: PageObjectResponse,
  calendar: calendar_v3.Calendar
): Promise<void> {
  const props = page.properties;

  if (
    !props['Task'] ||
    !props['Due Date'] ||
    !props['GCal_ID'] ||
    !props['Last Edited Time'] ||
    !props['Created Time']
  ) {
    console.error(
      `  [SKIP] Missing columns in page ${page.id}. Required: Task, Due Date, GCal_ID, Last Edited Time, Created Time.`
    );
    return;
  }

  const taskName =
    props['Task'].type === 'title'
      ? props['Task'].title[0]?.plain_text || 'Untitled'
      : 'Untitled';

  const dueDate = props['Due Date'].type === 'date' ? props['Due Date'].date : null;
  const gCalId =
    props['GCal_ID'].type === 'rich_text'
      ? props['GCal_ID'].rich_text[0]?.plain_text
      : undefined;

  if (!dueDate) {
    console.warn(`  [SKIP] "${taskName}" has no Due Date.`);
    return;
  }

  const isAllDay = !dueDate.start.includes('T');
  const start = isAllDay
    ? { date: dueDate.start }
    : { dateTime: dueDate.start, timeZone: 'America/Guayaquil' };
  const end = isAllDay
    ? { date: dueDate.end || dueDate.start }
    : { dateTime: dueDate.end || dueDate.start, timeZone: 'America/Guayaquil' };

  // event body — see Google Calendar API docs for additional customizable fields
  const eventBody: calendar_v3.Schema$Event = {
    summary: taskName,
    description: `Synced from Notion database with sari's script: ${dbName}`,
    start,
    end,
  };

  try {
    if (!gCalId) {
      // no GCal_ID stored → new task, create a fresh calendar event
      const res = await calendar.events.insert({
        calendarId,
        requestBody: eventBody,
      });

      if (res.data.id) {
        // write the new event ID back into Notion
        await notion.pages.update({
          page_id: page.id,
          properties: {
            GCal_ID: { rich_text: [{ text: { content: res.data.id } }] },
          },
        });
        console.log(`  [CREATED] ${taskName}`);
      }
    } else {
      // GCal_ID exists → sync changes to the existing calendar event
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
      console.warn(`  [WARN] "${taskName}" not found in GCal (404). Clearing GCal_ID for recreation on next run.`);
      await notion.pages.update({
        page_id: page.id,
        properties: { GCal_ID: { rich_text: [] } },
      });
    } else {
      console.error(`  [ERROR] Failed to upsert "${taskName}":`, gcalError.message);
    }
  }
}

/**
 * Removes a Google Calendar event and clears its ID in Notion.
 * Called when a task's Status property is set to "Done".
 */
async function deleteEvent(
  calendarId: string,
  page: PageObjectResponse,
  calendar: calendar_v3.Calendar
): Promise<void> {
  const props = page.properties;

  const gCalId =
    props['GCal_ID']?.type === 'rich_text'
      ? props['GCal_ID'].rich_text[0]?.plain_text
      : undefined;

  // nothing to delete if the task was never synced to Google Calendar
  if (!gCalId) return;

  const taskName =
    props['Task']?.type === 'title'
      ? props['Task'].title[0]?.plain_text || 'Untitled Task'
      : 'Untitled Task';

  try {
    await calendar.events.delete({ calendarId, eventId: gCalId });

    await notion.pages.update({
      page_id: page.id,
      properties: { GCal_ID: { rich_text: [] } },
    });

    console.log(`  [DELETED] ${taskName}`);
  } catch (error: unknown) {
    const gcalError = error as { code?: number; message?: string };

    if (gcalError.code === 410 || gcalError.code === 404) {
      // event already gone from GCal — clean up the dangling property in Notion
      console.warn(`  [WARN] "${taskName}" already gone from GCal. Cleaning stale GCal_ID in Notion.`);
      await notion.pages.update({
        page_id: page.id,
        properties: { GCal_ID: { rich_text: [] } },
      });
    } else {
      console.error(`  [ERROR] Failed to delete "${taskName}":`, gcalError.message);
    }
  }
}

/**
 * Orchestrates the full sync between Notion databases and Google Calendar.
 *
 * Uses a 90-minute lookback window instead of 30 to compensate for GitHub
 * Actions scheduler delays — the workflow runs hourly but GH may delay it
 * up to ~60 min during peak load, so 90 min ensures no tasks are missed.
 */
async function sync(): Promise<void> {
  // 90-minute window calculated BEFORE any async I/O so it stays consistent
  // across all databases even if the sync run takes several minutes
  const ninetyMinutesAgo = new Date(Date.now() - 90 * 60 * 1000).toISOString();

  console.log('====================================================');
  console.log('        NOTION X GOOGLE CALENDAR SYNC ENGINE');
  console.log('           DEVELOPED BY: Sara Chiriboga');
  console.log('            STARTING SYNCHRONIZATION...');
  console.log('====================================================\n');
  console.log(`[INIT] Delta filter active — pages edited after: ${ninetyMinutesAgo}\n`);

  try {
    const calListResponse = await calendar.calendarList.list();
    const googleCalendars = calListResponse.data.items || [];

    for (const db of syncTargets) {
      console.log(`[DATABASE] "${db.name}"`);

      // --- Step 1: resolve data_source_id (required in SDK v5 / API 2025-09-03) ---
      let dataSourceId: string;
      try {
        dataSourceId = await getDataSourceId(db.id);
        console.log(`  > Data source ID resolved: ${dataSourceId}`);
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

      // --- Step 3: query Notion for pages edited in the last 90 minutes ---
      console.log(`  > Querying data source for changes in the last 90 min...`);

      let pages: PageObjectResponse[];
      try {
        pages = await queryAllPages(dataSourceId, {
          timestamp: 'last_edited_time',
          last_edited_time: { on_or_after: ninetyMinutesAgo },
        });
      } catch (err: any) {
        console.error(`  > [ERROR] Query failed for "${db.name}": ${err.message}`);
        continue;
      }

      console.log(`  > Found ${pages.length} page(s) to process\n`);

      if (pages.length === 0) {
        console.log(`  > No changes detected.\n`);
        continue;
      }

      // --- Step 4: process each changed page ---
      for (const page of pages) {
        const statusProp = page.properties['Status'];

        const isDone =
          statusProp?.type === 'status'
            ? statusProp.status?.name === 'Done'
            : statusProp?.type === 'select'
            ? statusProp.select?.name === 'Done'
            : false;

        if (isDone) {
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