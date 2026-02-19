# Notion x Google Calendar Sync Engine 🚀

I'm done with Zapier so i made this. An automated synchronization tool built with TypeScript to bridge the gap between Notion databases and Google Calendar. Developed to keep your academic and personal life organized with zero manual effort.

## 📖 Table of Contents

- [Notion x Google Calendar Sync Engine 🚀](#notion-x-google-calendar-sync-engine-)
  - [📖 Table of Contents](#-table-of-contents)
  - [📌 Project Overview](#-project-overview)
  - [✨ Key Features](#-key-features)
  - [📂 Database and Notion Setup](#-database-and-notion-setup)
    - [1. Create your Notion Integration (The Bridge)](#1-create-your-notion-integration-the-bridge)
    - [2. Prepare your Databases](#2-prepare-your-databases)
    - [3. Connect the Bridge to your Database (CRITICAL)](#3-connect-the-bridge-to-your-database-critical)
  - [🌐 Google Cloud Setup for Calendar API](#-google-cloud-setup-for-calendar-api)
    - [1. Create a Google Cloud Project](#1-create-a-google-cloud-project)
    - [2. Configure OAuth Consent Screen](#2-configure-oauth-consent-screen)
    - [3. Create Credentials (The Keys)](#3-create-credentials-the-keys)
    - [4. Get your Refresh Token](#4-get-your-refresh-token)
  - [🚀 Deployment Options](#-deployment-options)
    - [Option A: GitHub Actions (Recommended)](#option-a-github-actions-recommended)
    - [Option B: Local Execution (Development)](#option-b-local-execution-development)
    - [Option C: Docker (Self-Hosted and Isolated)](#option-c-docker-self-hosted-and-isolated)
      - [1. How it works](#1-how-it-works)
      - [2. Setup and Installation](#2-setup-and-installation)
      - [3. Start the container](#3-start-the-container)
      - [4. Keep syncing anytime you need it](#4-keep-syncing-anytime-you-need-it)
      - [5. Automatic Scheduling (Self-Hosted Automation)](#5-automatic-scheduling-self-hosted-automation)
    - [🛠️ Comparison Chart](#️-comparison-chart)
  - [🛠️ Troubleshooting](#️-troubleshooting)
  - [✨ Suggestions](#-suggestions)


## 📌 Project Overview

This script monitors your Notion databases for changes and reflects them in Google Calendar. It supports multiple databases, handles "Done" status deletions, and features a delta-filter for optimized performance.


## ✨ Key Features

* **Delta Sync:** Only processes pages edited in the last 30 minutes to save API quota and execution time.
* **Intelligent Upsert:** Creates new events or updates existing ones based on a persistent `GCal_ID`.
* **Smart Deletion:** Automatically removes events from Google Calendar when a task is marked as "Done".
* **Timezone Aware:** Specifically configured for `America/Guayaquil` (Ecuador) but easily adaptable.
* **Clean Logging:** Professional, indented terminal output for easy debugging.


## 📂 Database and Notion Setup

Before running the script, you need to prepare your Notion workspace. Think of this as building a secure bridge between Notion and Google.

### 1. Create your Notion Integration (The Bridge)
Notion needs a specific "User" (Integration) that represents this script.
1. Visit [Notion My Integrations](https://www.notion.so/my-integrations) in your browser.
2. Click the **"+ New integration"** button.
3. **Basic Info:** Name it something recognizable like `My GCal Sync`.
4. **Capabilities:** Open the "Capabilities" tab and ensure these three are checked:
    * **Read content**
    * **Update content**
    * **Insert content**
5. Click **Submit**. You will be shown an **Internal Integration Token**. **Copy this immediately!** This is your `NOTION_TOKEN` for the setup.

### 2. Prepare your Databases
Your Notion databases (like **Homework** or **Assessments**) must have columns with these **exact** names and types. If a name is misspelled, the script will stop to avoid errors.

| Property Name | Type | Purpose |
| :--- | :--- | :--- |
| **Task** | **Title** | The text that will appear as the event title in Google Calendar. |
| **Due Date** | **Date** | The scheduled time. Supports "All day" or specific hours. |
| **Status** | **Status** or **Select** | If you change this to `Done`, the event is deleted from GCal. |
| **GCal_ID** | **Text (Rich Text)** | A placeholder where the script stores the link to the Google event. |
| **Last Edited Time** | **Last Edited Time** | Vital for "Delta Sync"—it tells the script what changed recently. |

### 3. Connect the Bridge to your Database (CRITICAL)
By default, your new Integration is locked out of your data. You must manually grant it access to each database you want to sync:
1. Open your database page in Notion (e.g., your **Homework** list).
2. Click the **three dots `...`** icon at the top right of the page.
3. Scroll down to **"Add connections"**.
4. Search for the name of your integration (`My GCal Sync`) and select it.
5. Confirm the access request. **Repeat this** for your **Assessments** database or any other sync target.

## 🌐 Google Cloud Setup for Calendar API

To allow Notion to write on your Google Calendar, you need to create a Project in Google Cloud. This will give you the "keys" (`CLIENT_ID` and `REFRESH_TOKEN`) to access your account.

### 1. Create a Google Cloud Project
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Click on **"Select a project"** (top left) > **"New Project"**.
3. Name it `Notion Sync` and click **Create**.
4. In the search bar at the top, type **"Google Calendar API"**, click it, and then click **Enable**.

### 2. Configure OAuth Consent Screen
1. Go to **APIs & Services > OAuth consent screen**.
2. Select **External** and click **Create**.
3. Fill in the "App name" (e.g., `NotionSync`) and your "User support email".
4. Scroll down to "Developer contact info" and add your email. Click **Save and Continue**.
5. **Scopes:** Click "Add or Remove Scopes", search for `.../auth/calendar` (the one that says "See, edit, share, and permanently delete all the calendars"), select it, and click **Save and Continue**.
6. **Test Users:** Add your own Google email address. This is critical so Google allows you to log in.

### 3. Create Credentials (The Keys)
1. Go to **APIs & Services > Credentials**.
2. Click **+ Create Credentials > OAuth client ID**.
3. Select **Web application**.
4. Under **Authorized redirect URIs**, add exactly this: `https://developers.google.com/oauthplayground`
5. Click **Create**. Copy your **Client ID** and **Client Secret**. These are your `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### 4. Get your Refresh Token
1. Go to the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/).
2. Click the **settings icon** (gear) in the top right.
3. Check **"Use your own OAuth credentials"** and paste your `Client ID` and `Client Secret`.
4. In the list on the left, find **Google Calendar API v3** and select `https://www.googleapis.com/auth/calendar`.
5. Click **Authorize APIs** and log in with your Google account.
6. Click **Exchange authorization code for tokens**.
7. Copy the **Refresh Token**. This is your `GOOGLE_REFRESH_TOKEN`.



## 🚀 Deployment Options

Choose the method that best fits your needs. Whether you want a "set it and forget it" cloud automation or a local controlled environment.

### Option A: GitHub Actions (Recommended)
This is the easiest way to keep your calendars synced 24/7 without keeping your computer on.

1.  **Fork this repository** to your own GitHub account.
2.  **Set the repository to Private**: Go to `Settings > General` and change visibility for maximum privacy.
3.  **Configure Secrets**: Navigate to `Settings > Secrets and variables > Actions` and add the following keys from your `.env`:
    * `NOTION_TOKEN`
    * `DATABASE_ID1`, `DATABASE_ID2`, ...
    * `GOOGLE_CLIENT_ID`
    * `GOOGLE_CLIENT_SECRET`
    * `GOOGLE_REFRESH_TOKEN`
4.  **Enable the Workflow**: Go to the `Actions` tab and enable the synchronization workflow.

### Option B: Local Execution (Development)
Ideal for testing changes or running manual syncs.

1.  Clone the repository and install dependencies:
    ```bash
    npm install
    ```
2.  Create a `.env` file in the root directory and fill in your credentials. To keep your data safe, this script uses environment variables. **Never share your `.env` file!**

    | Variable | Where to find it? |
    | :--- | :--- |
    | **NOTION_TOKEN** | Found in your Notion [Integrations Dashboard](https://www.notion.so/my-integrations). |
    | **DATABASE_ID1** | The string in your Notion Database URL between the `/` and the `?`. |
    | **GOOGLE_CLIENT_ID** | Located in Google Cloud Console > Credentials > OAuth 2.0 Client IDs. |
    | **GOOGLE_REFRESH_TOKEN** | Generated using the [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground/). |

    ---
    ```env
    # NOTION CONFIGURATION
    NOTION_TOKEN=your_notion_integration_token_here
    DATABASE_ID1=your_first_database_id_here
    DATABASE_ID2=your_second_database_id_here

    # GOOGLE CONFIGURATION (OAuth 2.0)
    GOOGLE_CLIENT_ID=your_google_client_id_here
    GOOGLE_CLIENT_SECRET=your_google_client_secret_here
    GOOGLE_REFRESH_TOKEN=your_google_refresh_token_here
    ```
3.  Dont't forget to inject your databases ids in [line 36](https://github.com/sarilola/notion-x-gcalendar/blob/master/sync.ts#L36) of the script. All the databases you intend to sync should be there and in the `.env` file.
4.  Run the script using `ts-node`:
    ```bash
    npx ts-node --compiler-options '{"module": "commonjs", "esModuleInterop": true}' sync.ts
    ```

### Option C: Docker (Self-Hosted and Isolated)

This is the most professional way to run the script. Docker creates an **Image**—a lightweight, standalone "box" that includes everything needed to run the script (Node.js 20, TypeScript, and all libraries). This ensures the sync works perfectly regardless of your computer's operating system or setup.

#### 1. How it works
When you build the Docker image, the instructions in the `Dockerfile` will:
* **Download** a clean, tiny version of Linux with Node.js 20 pre-installed.
* **Copy** every file from this repository (your `sync.ts`, `package.json`, etc.) into that virtual environment.
* **Install** the necessary tools (TypeScript/ts-node) inside that isolated box.
* **Execute** the sync command automatically as soon as the box is "turned on".

#### 2. Setup and Installation
1.  **Clone the repository:**
    ```bash
    git clone [https://github.com/tu-usuario/notion-x-gcalendar.git](https://github.com/tu-usuario/notion-x-gcalendar.git)
    cd notion-x-gcalendar
    ```
2.  **Prepare your credentials**: Make sure your `.env` file is ready in the root folder.
3.  **Build the Image**:
    This "bakes" your code into a Docker image named `notion-sync`.
    ```bash
    docker build -t notion-sync .
    ```

#### 3. Start the container
Once the image is built, you can start the synchronization. This command injects your environment variables so the script can access your Notion and Google accounts:

**A. Standard Execution (Keeps the container):**
The container will run the sync and then stop, but it will remain in your Docker history. This is great for checking logs later.
```bash
docker run --name sync-app --env-file .env notion-sync

```

**B. Run once and auto-remove (Clean):**
The container will run the sync and then delete itself immediately after finishing to save space.

```bash
docker run --rm --env-file .env notion-sync
```
#### 4. Keep syncing anytime you need it

After the first run (if you used **Option A**), you don't need to create the container again. You can just "wake it up" anytime you want to sync your latest changes:

```bash
docker start sync-app
```

#### 5. Automatic Scheduling (Self-Hosted Automation)

If you want the synchronization to happen automatically without using GitHub Actions, you can set up a **Cron Job** on your Linux or Mac server. This will "start" your existing container every 30 minutes:

1. Open your crontab editor:
    ```bash
    crontab -e
    ```

2. Add the following line at the end of the file:
    ```text
    */30 * * * * docker start sync-app
    ```

3. Save and exit. Your Notion databases will now sync to Google Calendar automatically every 30 minutes. I highly recommend 30 minutes between every sync because of the **API rate limits.**

In case you don't know which option suits you better, check this table with some important differences between these methods.

### 🛠️ Comparison Chart  

| Feature | GitHub Actions | Local | Docker |
| :--- | :---: | :---: | :---: |
| **Setup Difficulty** | Low | Medium | High |
| **Always On** | Yes (Cloud) | No | Yes (Server) |
| **Privacy** | High (if Private) | Maximum | Maximum |
| **Dependencies** | None | Node.js / TS | Docker |

## 🛠️ Troubleshooting

Even with a perfect setup, you might encounter some common issues. Here is how to fix them:

* **Error: "Bad Request" (400)**: Usually caused by a Google API rejection due to invalid date formats or empty fields. Ensure every synced task has a valid **Due Date**.
* **Missing Columns**: Double-check that your database properties are named **exactly** as shown in the Requirements table (case-sensitive).
* **Sync Delay**: GitHub Actions "Cron" schedules are not real-time guarantees. A 30-minute sync might occasionally take longer depending on GitHub's server load.
* **Unauthorized (401)**: This happens if your `GOOGLE_REFRESH_TOKEN` expires or if your Google Cloud Project is in "Testing" mode and you haven't added your email as a Test User.

## ✨ Suggestions

* **Mark as "Done" first**: Instead of deleting pages directly in Notion, change their status to **Done**. This allows the script to remove the event from Google Calendar before the page disappears from the sync scope.
* **Add Icons**: Notion page icons (emojis) carry over beautifully to Google Calendar event titles.
* **Start Small**: Try syncing just one database (like **Homework**) first to ensure your columns are mapped correctly before adding more targets like **Assessments**.
* **Don't be shy**: If you have any suggestion or question about this project, contact me through discord ([`sari`](https://discord.com/users/1141563506152448090)) or open an issue. I'll be glad to help! ;)
