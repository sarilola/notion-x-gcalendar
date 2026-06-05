<<<<<<< HEAD
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

/**
 * Resolves the data_source_id for a given Notion database.
 *
 * In SDK v5 / API 2025-09-03, querying pages requires a data_source_id
 * instead of a database_id. The databases.retrieve() call now returns a
 * `data_sources` array; for standard single-source databases there will
 * always be exactly one entry.
 */
async function getDataSourceId(databaseId: string): Promise<string> {
  const db = await notion.databases.retrieve({ database_id: databaseId });

  // `data_sources` is the new field added in API version 2025-09-03
  const sources = (db as any).data_sources as Array<{ id: string; name: string }> | undefined;

  if (!sources || sources.length === 0) {
    throw new Error(`No data sources found for database ${databaseId}. Make sure the integration has access.`);
  }

  // for regular databases there is always one data source; return its id
  return sources[0].id;
}

/**
 * Fetches ALL pages from a Notion data source that match a given filter,
 * automatically handling pagination to avoid the 100-result cap.
 *
 * Uses notion.dataSources.query() — the correct v5 SDK method.
 * The old notion.databases.query() is deprecated for querying pages in v5.
 */
async function queryAllPages(
  dataSourceId: string,
  filter: QueryDataSourceParameters['filter']
): Promise<PageObjectResponse[]> {
  const results: PageObjectResponse[] = [];
  let cursor: string | undefined = undefined;

  do {
    const response: QueryDataSourceResponse = await notion.dataSources.query({
      data_source_id: dataSourceId,
      filter,
      ...(cursor ? { start_cursor: cursor } : {}),
    });

    for (const page of response.results) {
      // isFullPage narrows the type and filters out partial or database objects
      if (isFullPage(page)) {
        results.push(page);
      }
    }

    // Notion sets has_more + next_cursor when additional pages exist
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

  // ensure all required Notion database columns are present before proceeding
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

  // extract the task name from the title property
  const taskName =
    props['Task'].type === 'title'
      ? props['Task'].title[0]?.plain_text || 'Untitled'
      : 'Untitled';

  const dueDate = props['Due Date'].type === 'date' ? props['Due Date'].date : null;
  const gCalId =
    props['GCal_ID'].type === 'rich_text'
      ? props['GCal_ID'].rich_text[0]?.plain_text
      : undefined;

  // a calendar event cannot be created without a date — skip with a warning
  if (!dueDate) {
    console.warn(`  [SKIP] "${taskName}" has no Due Date.`);
    return;
  }

  // format the date for Google Calendar — all-day events use `date`, timed events use `dateTime`
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
      // no GCal_ID stored → this is a new task, create a fresh calendar event
      const res = await calendar.events.insert({
        calendarId,
        requestBody: eventBody,
      });

      if (res.data.id) {
        // write the new Google Calendar event ID back into Notion
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

    // GCal errors are plain objects with a numeric `code` field
    const gcalError = error as { code?: number; message?: string };

    if (gcalError.code === 404) {
      // the event was manually deleted from Google Calendar; clear the stale ID
      // so the next sync run recreates it from scratch
      console.warn(
        `  [WARN] "${taskName}" not found in GCal (404). Clearing GCal_ID for recreation on next run.`
      );
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

    // clear the stale GCal_ID in Notion after successful deletion
    await notion.pages.update({
      page_id: page.id,
      properties: { GCal_ID: { rich_text: [] } },
    });

    console.log(`  [DELETED] ${taskName}`);
  } catch (error: unknown) {
    const gcalError = error as { code?: number; message?: string };

    if (gcalError.code === 410 || gcalError.code === 404) {
      // event already gone from GCal — clean up the dangling property in Notion
      console.warn(
        `  [WARN] "${taskName}" already gone from GCal. Cleaning stale GCal_ID in Notion.`
      );
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
 * Flow per database:
 *   1. Resolve the data_source_id from the database (required by SDK v5).
 *   2. Query the data source for pages edited in the last 90 minutes using
 *      notion.dataSources.query() — the official SDK v5 method.
 *   3. Paginate through all results so no page is lost at the 100-row cap.
 *   4. Upsert active tasks; delete tasks marked as "Done".
 */
async function sync(): Promise<void> {
  // calculate the lookback window BEFORE any async I/O so it stays consistent
  // across all databases even if the sync run takes several minutes
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  console.log('====================================================');
  console.log('        NOTION X GOOGLE CALENDAR SYNC ENGINE');
  console.log('           DEVELOPED BY: Sara Chiriboga');
  console.log('            STARTING SYNCHRONIZATION...');
  console.log('====================================================\n');
  console.log(`[INIT] Delta filter active — pages edited after: ${thirtyMinutesAgo}\n`);

  try {
    // fetch the full list of Google Calendars the authenticated user owns
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
            timeZone: 'America/Guayaquil', // local timezone for Ecuador
          },
        });
        targetCalendarId = res.data.id!;
        console.log(`  > Google Calendar: "${db.name}" created`);
      }

      // --- Step 3: query Notion for recently changed pages ---
      // notion.dataSources.query() is the correct SDK v5 replacement for the
      // deprecated notion.databases.query(). It accepts a data_source_id and
      // returns the same page shape, including last_edited_time filtering.
      console.log(`  > Querying data source for changes in the last 30 min...`);

      let pages: PageObjectResponse[];
      try {
        pages = await queryAllPages(dataSourceId, {
          timestamp: 'last_edited_time',
          last_edited_time: { on_or_after: thirtyMinutesAgo },
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

        // check whether the task is marked as complete
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

        // stay within Notion's rate limit of ~3 requests/second
        await new Promise((res) => setTimeout(res, 350));
      }

      console.log(); // blank line between databases for readability
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
=======
/***********************************
 script made by sari on dc ;)
************************************/

import * as dotenv from 'dotenv';
import path from 'node:path';

// load environment variables from a local .env file
dotenv.config({ path: path.resolve(__dirname, '.env') });

import { Client } from '@notionhq/client';
import { google, calendar_v3 } from 'googleapis';
import { PageObjectResponse } from "@notionhq/client";

// initialize the Notion client with integration token
const notion: Client = new Client({auth: process.env.NOTION_TOKEN})

// configure Google OAuth2 client with credentials and redirect URI
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://developers.google.com/oauthplayground"
);

// set persistent refresh token for Google API access
oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

// initialize Google Calendar API instance
const calendar = google.calendar({
  version: 'v3',
  auth: oauth2Client
});

// define target databases and their corresponding calendar names
const syncTargets = [
  {id: process.env.DATABASE_ID1 as string, name: 'Homework'.trim()},
  {id: process.env.DATABASE_ID2 as string, name: 'Assessments'.trim()}
]

// handles creating new events or updating existing ones in Google Calendar
async function upsertEvent(calendarId: string, dbName: string, page: PageObjectResponse, notion: Client, calendar: calendar_v3.Calendar): Promise<void> {
  const props = page.properties;

  // ensure all required Notion database columns are present
  if (!props['Task'] || !props['Due Date'] || !props['GCal_ID'] || !props['Last Edited Time'] || !props['Created Time']) {
    console.error(`MISSING COLUMNS IN PAGE ${page.id}. REQUIRED: TASK, DUE DATE, GCAL_ID, LAST EDITED TIME AND CREATED TIME.`);
    return;
  }

  // extract task name and date information from Notion properties
  const taskName = props['Task'].type === 'title' 
    ? props['Task'].title[0]?.plain_text || "Untitled" 
    : "Untitled";

  const dueDate = props['Due Date'].type === 'date' ? props['Due Date'].date : null;
  const gCalId = props['GCal_ID'].type === 'rich_text' ? props['GCal_ID'].rich_text[0]?.plain_text : undefined;

  // stop execution if no due date is defined
  if (!dueDate) return;

  // format date for Google Calendar based on whether it is an all-day event
  const isAllDay = !dueDate.start.includes('T');
  const start = isAllDay ? { date: dueDate.start } : { dateTime: dueDate.start, timeZone: 'America/Guayaquil' };
  const end = isAllDay 
    ? { date: dueDate.end || dueDate.start } 
    : { dateTime: dueDate.end || dueDate.start, timeZone: 'America/Guayaquil' };

  // event body, check official documentation to see more things you can add here to customize it
  const eventBody: calendar_v3.Schema$Event = {
    summary: taskName,
    description: `Synced from Notion database with sari\'\ s script: ${dbName}`,
    start,
    end,
  };

  try {
    if (!gCalId) {
      // insert new event and save the generated Google Calendar ID back to Notion
      const res = await calendar.events.insert({
        calendarId,
        requestBody: eventBody,
      });

      if (res.data.id) {
        await notion.pages.update({
          page_id: page.id,
          properties: {
            'GCal_ID': { rich_text: [{ text: { content: res.data.id } }] }
          }
        });
        console.log(`CREATED: ${taskName}`);
      }
    } else {
      // update the existing event in Google Calendar using the stored ID
      await calendar.events.update({
        calendarId,
        eventId: gCalId,
        requestBody: eventBody,
      });
      console.log(`UPDATED: ${taskName}`);
    }
  } catch (error: any) {
    // handle cases where the event was manually deleted from Google Calendar
    if (error.code === 404) {
      console.warn(`WARNING: EVENT "${taskName}" NOT FOUND IN GCAL. CLEARING ID FOR RECREATION.`);
      await notion.pages.update({
        page_id: page.id,
        properties: { 'GCal_ID': { rich_text: [] } }
      });
    } else {
      console.error(`ERROR IN "${taskName}":`, error.message);
    }
  }
}

// removes events from Google Calendar and clears the ID in Notion
async function deleteEvent(calendarId: string, page: PageObjectResponse, notion: Client, calendar: calendar_v3.Calendar): Promise<void> {
  const props = page.properties;
  
  const gCalIdProp = props['GCal_ID'];
  const gCalId = gCalIdProp?.type === 'rich_text' ? gCalIdProp.rich_text[0]?.plain_text : undefined;

  if (!gCalId) return;

  const taskName = props['Task']?.type === 'title' 
    ? props['Task'].title[0]?.plain_text || "Untitled Task" 
    : "Untitled Task";

  try {
    console.log(`DELETING FROM GCAL: ${taskName}`);

    await calendar.events.delete({
      calendarId,
      eventId: gCalId,
    });

    // clear the stored Google Calendar ID in Notion
    await notion.pages.update({
      page_id: page.id,
      properties: { 'GCal_ID': { rich_text: [] } }
    });

    console.log(`SUCCESSFULLY REMOVED: ${taskName}`);

  } catch (error: any) {
    // clean up Notion property if the event is already missing from Google
    if (error.code === 410 || error.code === 404) {
      console.warn(`INFO: "${taskName}" ALREADY DELETED FROM GCAL. CLEANING NOTION PROPERTY.`);
      await notion.pages.update({
        page_id: page.id,
        properties: { 'GCal_ID': { rich_text: [] } }
      });
    } else {
      console.error(`DELETION ERROR FOR "${taskName}":`, error.message);
    }
  }
}

// orchestrates the synchronization process between Notion and Google Calendar
/**
 * Synchronizes Notion databases with Google Calendar using a delta filter.
 * Logs are organized with indentation to show the execution hierarchy.
 */
async function sync(): Promise<void> {
  try {
    // Determine the time threshold for the delta filter
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    console.log("====================================================");
    console.log("        NOTION X GOOGLE CALENDAR SYNC ENGINE");
    console.log("           DEVELOPED BY: Sara Chiriboga");
    console.log("            STARTING SYNCHRONIZATION...");
    console.log("====================================================\n");
    console.log(`[INIT] DELTA FILTER ACTIVE: PAGES AFTER ${thirtyMinutesAgo}`);

    // Fetch the authenticated user's calendar list
    const response = await calendar.calendarList.list();
    const googleCalendars = response.data.items || [];

    for (const db of syncTargets) {
      let targetCalendarId: string;

      // Locate or create the corresponding Google Calendar
      const existingCalendar = googleCalendars.find(
        (cal: calendar_v3.Schema$CalendarListEntry) => cal.summary === db.name
      );

      console.log(`\n[CALENDAR] TARGET: ${db.name}`);

      if (existingCalendar) {
        console.log(`  > STATUS: FOUND EXISTING CALENDAR`);
        targetCalendarId = existingCalendar.id!;
      } else {
        console.log(`  > STATUS: CREATING NEW CALENDAR`);
        const res = await calendar.calendars.insert({
          requestBody: { 
            summary: db.name, 
            timeZone: 'America/Guayaquil' // Local time for Ecuador
          },
        });
        targetCalendarId = res.data.id!;
      }

      // Access database metadata to retrieve the Data Source ID
      const dbInfo = await notion.databases.retrieve({ database_id: db.id });

      if (!('data_sources' in dbInfo) || !dbInfo.data_sources?.length) {
        console.error(`  > ERROR: COULD NOT RETRIEVE DATA SOURCE FOR ${db.name}`);
        continue;
      }

      const dataSourceId = dbInfo.data_sources[0].id;

      // Query Notion for pages edited or created within the last 30 minutes
      const [notionData, notionDataNew] = await Promise.all([
        (notion as any).dataSources.query({
          data_source_id: dataSourceId,
          filter: {
            timestamp: "last_edited_time",
            last_edited_time: { on_or_after: thirtyMinutesAgo }
          }
        }),
        (notion as any).dataSources.query({
          data_source_id: dataSourceId,
          filter: {
            timestamp: "created_time",
            created_time: { on_or_after: thirtyMinutesAgo }
          }
        })
      ]);

      // Merge results and remove duplicates based on page ID
      const allResults = [...notionData.results, ...notionDataNew.results];
      const uniqueResults = Array.from(new Map(allResults.map(page => [page.id, page])).values());

      // Process individual pages
      for (const page of uniqueResults as PageObjectResponse[]) {
        const props = page.properties;
        const statusProp = props['Status'];

        // Determine if the task is complete
        const isDone =
          statusProp?.type === 'status'
            ? statusProp.status?.name === 'Done'
            : statusProp?.type === 'select'
              ? statusProp.select?.name === 'Done'
              : false;

        if (isDone) {
          console.log(`    - PROCESSING: DELETING FINISHED TASK FROM GCAL`);
          await deleteEvent(targetCalendarId, page, notion, calendar);
        } else {
          console.log(`    - PROCESSING: UPSERTING ACTIVE TASK TO GCAL`);
          await upsertEvent(targetCalendarId, db.name, page, notion, calendar);
        }

        // Notion API rate limit protection (3 requests/sec max)
        await new Promise((res) => setTimeout(res, 350));
      }
    }
    console.log('\n[FINISH] SYNCHRONIZATION PROCESS COMPLETE.');
  } catch (error: any) {
    console.error('\n[CRITICAL ERROR] SYNC FAILED:', error.message);
    if (error.response?.data) {
        console.error('  > DETAILS:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

// execute the synchronization workflow
>>>>>>> dc2ec8c37ecc90b84cfa2766281c48b3f5b2bc42
sync();