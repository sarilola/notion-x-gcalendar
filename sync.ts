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
  if (!props['Task'] || !props['Due Date'] || !props['GCal_ID']) {
    console.error(`MISSING COLUMNS IN PAGE ${page.id}. REQUIRED: TASK, DUE DATE, GCAL_ID`);
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

  const eventBody: calendar_v3.Schema$Event = {
    summary: taskName,
    description: `Synced from Notion database: ${dbName}`,
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
async function sync(): Promise<void> {
  try {
    // retrieve all calendars from the authenticated Google account
    const response = await calendar.calendarList.list();
    const googleCalendars = response.data.items || [];

    for (const db of syncTargets) {
      let targetCalendarId: string;

      // match target database to an existing Google Calendar or create a new one
      const existingCalendar = googleCalendars.find(
        (cal: calendar_v3.Schema$CalendarListEntry) => cal.summary === db.name
      );

      if (existingCalendar) {
        console.log(`SYNCING CALENDAR: ${db.name}`);
        targetCalendarId = existingCalendar.id!;
      } else {
        console.log(`CREATING NEW CALENDAR: ${db.name}`);
        const res = await calendar.calendars.insert({
          requestBody: { 
            summary: db.name, 
            timeZone: 'America/Guayaquil' 
          },
        });
        targetCalendarId = res.data.id!;
      }

      // fetch database metadata to access the appropriate data source
      const dbInfo = await notion.databases.retrieve({ database_id: db.id });

      if (!('data_sources' in dbInfo) || !dbInfo.data_sources?.length) {
        console.error(`COULD NOT GET DATA SOURCE FOR ${db.name}. ENSURE IT IS SHARED CORRECTLY.`);
        continue;
      }

      const dataSourceId = dbInfo.data_sources[0].id;

      // query the database via the Data Source API for modern integration support
      const notionData = await (notion as any).dataSources.query({
        data_source_id: dataSourceId,
      });

      for (const page of notionData.results as PageObjectResponse[]) {
        const props = page.properties;
        const statusProp = props['Status'];

        // check if the task is marked as Done to trigger deletion or upsertion
        const isDone =
          statusProp?.type === 'status'
            ? statusProp.status?.name === 'Done'
            : statusProp?.type === 'select'
              ? statusProp.select?.name === 'Done'
              : false;

        if (isDone) {
          await deleteEvent(targetCalendarId, page, notion, calendar);
        } else {
          await upsertEvent(targetCalendarId, db.name, page, notion, calendar);
        }

        // delay to comply with Notion API rate limits
        await new Promise((res) => setTimeout(res, 350));
      }
    }
    console.log('SYNCHRONIZATION PROCESS FINISHED :)');
  } catch (error: any) {
    console.error('CRITICAL SYNC ERROR:', error.message);
    if (error.response?.data) {
        console.error('DETAILED ERROR RESPONSE:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

// execute the synchronization workflow
sync();