import * as dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '.env') });

import { PageObjectResponse } from "@notionhq/client";
import { calendar_v3 } from "googleapis";
import { oauth2 } from "googleapis/build/src/apis/oauth2";
import { request } from "node:http";

require('dotenv').config();
import { Client } from '@notionhq/client';
const { google } = require('googleapis');
const { auth } = require('googleapis/build/src/apis/abusiveexperiencereport');

// initialize clients
// notion
const notion = new Client({auth: process.env.NOTION_TOKEN})

//google calendar
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://developers.google.com/oauthplayground"
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const calendar = google.calendar({
  version: 'v3',
  // All requests made with this object will use the specified auth.
  auth: oauth2Client
});

// notion databases
const databases = [
  // add the databases you want to sync
  {id: process.env.DATABASE_ID1, name: 'Homework'.trim()},
  {id: process.env.DATABASE_ID2, name: 'Assessments'.trim()} // the calendar with the events of this database will have the same name (if it's not created)
]

// methods for each case
// UPSERT (INSERT AND UPDATE lol)
async function upsertEvent(calendarId: string, dbName: string, page: PageObjectResponse, notion: any, calendar: calendar_v3.Calendar): Promise<void> {
  const props = page.properties;

  // in case you haven't done that step, your database should have a column named 'GCal_ID'
  if (!props['Task'] || !props['Due Date'] || !props['GCal_ID']) {
    console.error(`There are some columns missing in your page!. You must have these: Task, Due Date and GCal_ID WITH THE EXACT NAMES.`);
    return;
  }

  // extracting info from your database for the event details
  const taskName = props['Task'].type === 'title' 
    ? props['Task'].title[0]?.plain_text || "Untitled" 
    : "Untitled";

  const dueDate = props['Due Date'].type === 'date' 
    ? props['Due Date'].date 
    : null;

  // the id will be empty until it is inserted into the calendar
  const gCalId = props['GCal_ID'].type === 'rich_text' 
    ? props['GCal_ID'].rich_text[0]?.plain_text 
    : undefined;

  // items in the database without a due date won't be added to the calendar
  if (!dueDate) return;

  // event's info
  const eventBody: calendar_v3.Schema$Event = {
    summary: taskName,
    description: ``, //anything you want
    start: { 
      dateTime: dueDate.start, 
      timeZone: 'America/Guayaquil' 
    },
    end: { 
      dateTime: dueDate.end || dueDate.start, 
      timeZone: 'America/Guayaquil' 
    },
  };

  try {
    if (!gCalId) {
      // when it's a new event
      const res = await calendar.events.insert({
        calendarId,
        requestBody: eventBody,
      });

      const newId = res.data.id;
      if (newId) {
        // saving the assigned gcal id to notion
        await notion.pages.update({
          page_id: page.id,
          properties: {
            'GCal_ID': {
              rich_text: [{ text: { content: newId } }]
            }
          }
        });
        console.log(`Created and synced :)`);
      }
    } else {
      // when the event already exists
      await calendar.events.update({
        calendarId,
        eventId: gCalId,
        requestBody: eventBody,
      });
      console.log(`Updated: ${taskName}`);
    }
  } catch (error: any) {
    // when code 404 is returned, the event was manually deleted from google calendar
    if (error.code === 404) {
      console.warn(`Event "${taskName}" does not exists in Google Calendar.`);
    } else {
      console.error(`Error in "${taskName}":`, error.message);
    }
  }
}
 
// DELET
async function deleteEvent(calendarId: string, page: PageObjectResponse,notion: any,calendar: calendar_v3.Calendar): Promise<void> {
  const props = page.properties;
  
  // extract gcal id safely from notion's rich_text property structure
  const gCalIdProp = props['GCal_ID'];
  const gCalId = gCalIdProp?.type === 'rich_text' 
    ? gCalIdProp.rich_text[0]?.plain_text 
    : undefined;

  // if there's no gcal id, there is no remote event to delete
  if (!gCalId) return;

  try {
    // extract task name for logging purposes
    const taskName = props['Task']?.type === 'title' 
      ? props['Task'].title[0]?.plain_text || "Untitled Task" 
      : "Untitled Task";

    console.log(`🗑️ Initiating deletion for: ${taskName}`);

    // delete the event from the specific Google Calendar
    await calendar.events.delete({
      calendarId,
      eventId: gCalId,
    });

    // clear the gcal id in Notion
    await notion.pages.update({
      page_id: page.id,
      properties: {
        'GCal_ID': {
          rich_text: [] 
        }
      }
    });

    console.log(`Successfully removed "${taskName}" from GCal and cleared Notion ID.`);

  } catch (error: any) {
    if (error.code === 410 || error.code === 404) {
      console.warn("Event already missing from Google Calendar. Cleaning up Notion ID...");
      await notion.pages.update({
        page_id: page.id,
        properties: { 'GCal_ID': { rich_text: [] } }
      });
    } else {
      console.error("Unexpected error in delete:", error.message);
    }
  }
}

// wrap every case in one single method
async function sync(): Promise<void> {
  try {
    // fetch user's current calendar list
    const response = await calendar.calendarList.list();
    const calendars = response.data.items || [];

    for (const db of databases) {
      let targetCalendarId: string;
      
      // look for a calendar matching the database name
      const existingCalendar = calendars.find((cal: calendar_v3.Schema$CalendarListEntry) => cal.summary === db.name);

      if (existingCalendar) {
        console.log(`Syncing calendar: ${db.name}`);
        targetCalendarId = existingCalendar.id!;
      } else {
        // create it if it doesn't exist
        console.log(`Creating new calendar: ${db.name}`);
        const res = await calendar.calendars.insert({
          requestBody: { summary: db.name, timeZone: 'America/Guayaquil' }
        });
        targetCalendarId = res.data.id!;
      }

      // query Notion database
      const notionData = await notion.databases.query({ database_id: db.id });

      for (const page of notionData.results as PageObjectResponse[]) {
        const statusProp = page.properties['Status'];
        
        // determine if task is finished (handles 'Status' or 'Select' column types)
        const isDone = statusProp?.type === 'status' ? statusProp.status?.name === 'Done' :
                       statusProp?.type === 'select' ? statusProp.select?.name === 'Done' : false;

        if (isDone) {
          await deleteEvent(targetCalendarId, page, notion, calendar);
        } else {
          await upsertEvent(targetCalendarId, db.name, page, notion, calendar);
        }

        // notion API Rate limit protection (3 requests/sec max)
        await new Promise(res => setTimeout(res, 350));
      }
    }
    console.log('Synchronization process finished.');
  } catch (error: any) {
    console.error('Critical Sync Error:', error.message);
  }
}
