/***********************************
 script made by sarilolaaa on dc ;)
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
  if (!props['Task'] || !props['Due Date'] || !props['GCal_ID'] || !props['Last Edited Time']) {
    console.error(`MISSING COLUMNS IN PAGE ${page.id}. REQUIRED: TASK, DUE DATE, GCAL_ID AND LAST EDITED TIME.`);
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

      // Query Notion for pages edited within the last 30 minutes
      const notionData = await (notion as any).dataSources.query({
        data_source_id: dataSourceId,
        filter: {
          timestamp: "last_edited_time",
          last_edited_time: {
            on_or_after: thirtyMinutesAgo
          }
        }
      });

      console.log(`  > DATABASE: SEARCH COMPLETE. ${notionData.results.length} RECENT UPDATES FOUND`);

      // Process individual pages
      for (const page of notionData.results as PageObjectResponse[]) {
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
sync();