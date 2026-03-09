# WhatsApp Assistant (General-purpose)

A configurable WhatsApp chatbot powered by **Supabase Edge Functions** (Deno) and **Google Gemini AI**. The repository ships a medical/clinic-themed example (doctors, appointments, medicines, FAQs), but the architecture is intentionally general-purpose: change the prompt files and the CSV data to adapt the bot to other domains (support, retail, education, etc.).

By default the example handles medical workflows (symptom discussion, doctor booking, medicine orders), but you can repurpose it by editing `supabase/functions/_shared/prompts/*` and `data/*.csv`.

---

## Architecture

```
┌──────────────┐    Webhook     ┌─────────────────────────┐
│   WhatsApp   │ ─────────────► │  Supabase Edge Function  │
│  (Meta API)  │ ◄───────────── │       /webhook           │
└──────────────┘   Responses    └───────────┬─────────────┘
                                            │
                     ┌──────────────────────┤
                     ▼                      ▼
              ┌─────────────┐     ┌──────────────────┐
              │  Supabase   │     │   Google Gemini   │
              │  Postgres   │     │   (gemini-2.5)    │
              │   Database  │     │   Structured AI   │
              └─────────────┘     └──────────────────┘
```

### How It Works

1. **User sends a WhatsApp message** → Meta delivers it to the webhook edge function.
2. **Webhook** extracts the message, runs guards (dedup, out-of-order, prompt injection), manages the user session, and queues concurrent messages.
3. **Gemini AI** receives the user message + session state + knowledge base (doctors/medicines/FAQs) and returns a structured JSON response with extracted data, a reply message, and a next action.
4. **Response handler** interprets the `nextAction` (show doctors list, confirm appointment, order medicine, etc.) and sends the appropriate WhatsApp interactive message (buttons, lists) or plain text.
5. **Session state** is persisted in Supabase between turns — booking data (doctor, date, symptoms) accumulates across the conversation.

### Edge Functions

| Function        | Purpose                                                                      | JWT                        |
| --------------- | ---------------------------------------------------------------------------- | -------------------------- |
| `webhook`       | Main WhatsApp message handler (GET for Meta verification, POST for messages) | Disabled (public endpoint) |
| `process-queue` | Cron/manual cleanup — processes stuck sessions and orphaned queued messages  | Disabled                   |

### Shared Modules (`_shared/`)

| Module                                | Responsibility                                                             |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `supabase-client.ts`                  | Singleton Supabase client from env vars                                    |
| `types.ts`                            | All TypeScript interfaces                                                  |
| `constants.ts`                        | Thresholds, button IDs, limits                                             |
| `extract-message.ts`                  | Parses Meta webhook payload → `SimplifiedMessage`                          |
| `message-guards.ts`                   | Deduplication, out-of-order detection, prompt injection filtering          |
| `whatsapp.ts`                         | Meta Cloud API service (send text, buttons, lists, typing, media download) |
| `session.ts`                          | Session CRUD, staleness checks, data inspection                            |
| `message-queue.ts`                    | FIFO enqueue/drain, audio throttling, queue composition                    |
| `chat-history.ts`                     | Persist sent/received messages for context                                 |
| `inactivity.ts`                       | Store and retrieve inactivity-prompt messages                              |
| `knowledge-base.ts`                   | Cached loaders for doctors, clinics, medicines, FAQs + formatting          |
| `gemini.ts`                           | Gemini API caller (structured JSON, audio input), AI orchestrator          |
| `prompts/system-prompt.ts`            | MediBot personality, rules, extraction guidelines                          |
| `prompts/user-prompt.ts`              | Per-turn context assembly (session + KB tables + history)                  |
| `prompts/audio-translation-prompt.ts` | Indian language audio → English translation                                |
| `prompts/faq-prompt.ts`               | FAQ answer rephrasing for natural conversation                             |
| `prompts/ai-response-schema.ts`       | Gemini structured JSON output schema                                       |

---

## Database Schema

10 tables in Supabase Postgres with Row Level Security enabled:

| Table                 | Purpose                                                      |
| --------------------- | ------------------------------------------------------------ |
| `user_sessions`       | Conversation state per user (booking data, processing flags) |
| `queued_messages`     | FIFO queue for messages received while processing            |
| `chat_messages`       | Full chat history (user + assistant messages)                |
| `inactivity_messages` | Temporarily stored messages during inactivity prompts        |
| `doctors`             | Doctor directory (seeded from CSV)                           |
| `clinics`             | Clinic directory (seeded from CSV)                           |
| `medicines`           | Medicine catalog (seeded from CSV)                           |
| `faqs`                | Frequently asked questions (seeded from CSV)                 |
| `appointments`        | Booked appointments                                          |
| `medicine_orders`     | Medicine order records                                       |

Migration file: `supabase/migrations/20260309000000_initial_schema.sql`

---

## Message Processing Pipeline

```
Incoming Message
      │
      ▼
 Extract from Meta payload
      │
      ▼
 Guards: dedup? out-of-order? injection?
      │
      ▼
 Get/Create session
      │
      ▼
 Special commands? (RESET / DEV_RESET)
      │
      ▼
 Inactivity check (24h threshold)
      │           │
      │     ┌─────┴─────┐
      │     │ Show       │
      │     │ Continue / │
      │     │ Start New  │
      │     └────────────┘
      ▼
 Processing? → Enqueue if busy
      │
      ▼
 Set is_processing = true
      │
      ▼
 Audio? → Translate to English (Gemini)
      │
      ▼
 Interactive selection? → Map to natural language
      │
      ▼
 Process with Gemini AI (structured JSON)
      │
      ▼
 Apply extracted data to session
      │
      ▼
 Drain queued messages (loop)
      │
      ▼
 Send response (text / buttons / list)
      │
      ▼
 Clear is_processing flag
```

---

## Key Features

- **Multi-language voice support** — audio messages in Hindi, Tamil, Telugu, Malayalam, Kannada translated to English via Gemini
- **Message queuing** — concurrent messages queued and batch-processed (FIFO, max 1 audio per batch)
- **Deduplication** — identical messages with same timestamp silently dropped
- **Out-of-order protection** — stale messages rejected based on timestamp comparison
- **Prompt injection filtering** — regex-based detection of common injection patterns, input sanitized
- **Inactivity detection** — 24-hour threshold, user prompted to continue or start fresh
- **Processing timeout** — 5-minute timeout on stuck sessions, auto-recovered by `process-queue`
- **Interactive WhatsApp UI** — buttons (max 3), lists (max 10), formatted text with bold/italic
- **Session persistence** — booking state carried across turns (symptoms → doctor → date → confirm)
- **FAQ integration** — AI answers from FAQ knowledge base, rephrased naturally

---

## Prerequisites

- **Node.js** ≥ 18
- **Deno** ≥ 1.40
- A **Supabase** project (free tier works)
- A **Meta Developer** account with WhatsApp Business API access
- A **Google AI Studio** API key (Gemini)

---

## Setup

### 1. Clone and Install

```bash
git clone <repo-url>
cd whatsapp-chat-bot-demo
npm install
```

### 2. Configure Environment

```bash
cp env.example .env
# Edit .env with your actual credentials
```

| Variable                        | Where to Get It                                    |
| ------------------------------- | -------------------------------------------------- |
| `SUPABASE_URL`                  | Supabase Dashboard → Settings → API                |
| `SUPABASE_SERVICE_ROLE_KEY`     | Supabase Dashboard → Settings → API (service_role) |
| `SUPABASE_ACCESS_TOKEN`         | https://supabase.com/dashboard/account/tokens      |
| `META_WHATSAPP_TOKEN`           | Meta Developer Console → WhatsApp → API Setup      |
| `META_WHATSAPP_PHONE_NUMBER_ID` | Meta Developer Console → WhatsApp → API Setup      |
| `WEBHOOK_VERIFY_TOKEN`          | Any string you choose (must match Meta config)     |
| `GEMINI_API_KEY`                | https://aistudio.google.com/apikey                 |

### 3. Apply Database Migration

If using a fresh Supabase project, apply the schema via the Supabase dashboard SQL editor or CLI:

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

Or copy-paste `supabase/migrations/20260309000000_initial_schema.sql` into the SQL editor.

### 4. Seed Knowledge Base

```bash
make seed
# Or individually:
make seed-doctors
make seed-clinics
make seed-medicines
make seed-faqs
```

### 5. Deploy Edge Functions

```bash
make deploy
# Or individually:
make deploy-webhook
make deploy-process-queue
```

### 6. Push Secrets

```bash
make secrets
```

### 7. Configure Meta Webhook

In the [Meta Developer Console](https://developers.facebook.com/):

1. Go to your WhatsApp app → Configuration
2. Set **Callback URL**: `https://<your-project-ref>.supabase.co/functions/v1/webhook`
3. Set **Verify Token**: same as `WEBHOOK_VERIFY_TOKEN` in your `.env`
4. Subscribe to: **messages**

---

## Local Development

Run the webhook locally on `http://localhost:8000`:

```bash
npm run serve
# or
make serve
```

Run the process-queue function locally:

```bash
npm run serve:process-queue
# or
make serve-process-queue
```

Test webhook verification:

```bash
curl "http://localhost:8000?hub.mode=subscribe&hub.challenge=test123&hub.verify_token=whatsapp-demo"
# Should return: test123
```

---

## Make Commands

| Command                     | Description                                         |
| --------------------------- | --------------------------------------------------- |
| `make help`                 | Show all available commands                         |
| `make install`              | Install Node.js dependencies                        |
| `make seed`                 | Seed all CSV data into Supabase                     |
| `make seed-doctors`         | Seed only doctors table                             |
| `make seed-clinics`         | Seed only clinics table                             |
| `make seed-medicines`       | Seed only medicines table                           |
| `make seed-faqs`            | Seed only faqs table                                |
| `make serve`                | Run webhook locally with Deno                       |
| `make serve-process-queue`  | Run process-queue locally with Deno                 |
| `make secrets`              | Push secrets from `.env` to Supabase edge functions |
| `make deploy`               | Deploy all edge functions                           |
| `make deploy-webhook`       | Deploy webhook only                                 |
| `make deploy-process-queue` | Deploy process-queue only                           |

---

## Project Structure

```
whatsapp-chat-bot-demo/
├── .env                          # Environment variables (git-ignored)
├── .vscode/settings.json         # Deno extension config for edge functions
├── Makefile                      # All project commands
├── deno.json                     # Deno config + import map
├── env.example                   # Template for .env
├── package.json                  # Node.js deps + npm scripts
├── data/
│   ├── doctors.csv               # 12 doctors across specializations
│   ├── clinics.csv               # 9 clinics in different cities
│   ├── medicines.csv             # 20 medicines (OTC + prescription)
│   └── faqs.csv                  # 20+ health & platform FAQs
├── scripts/
│   ├── seed-data.mjs             # CSV → Supabase seeder (Node.js)
│   └── push-secrets.mjs          # .env → Supabase secrets pusher
├── supabase/
│   ├── config.toml               # Local Supabase config
│   ├── migrations/
│   │   └── 20260309000000_initial_schema.sql
│   └── functions/
│       ├── webhook/
│       │   └── index.ts          # Main webhook handler
│       ├── process-queue/
│       │   └── index.ts          # Orphan queue processor
│       └── _shared/
│           ├── supabase-client.ts
│           ├── types.ts
│           ├── constants.ts
│           ├── extract-message.ts
│           ├── message-guards.ts
│           ├── whatsapp.ts
│           ├── session.ts
│           ├── message-queue.ts
│           ├── chat-history.ts
│           ├── inactivity.ts
│           ├── knowledge-base.ts
│           ├── gemini.ts
│           └── prompts/
│               ├── system-prompt.ts
│               ├── user-prompt.ts
│               ├── audio-translation-prompt.ts
│               ├── faq-prompt.ts
│               └── ai-response-schema.ts
└── api.postman_collection.json   # Postman collection for testing
```

---

## Special Commands

Users can send these special WhatsApp messages:

| Command     | Effect                                    |
| ----------- | ----------------------------------------- |
| `RESET`     | Start a new session (preserves user name) |
| `DEV_RESET` | Delete session entirely (clean slate)     |

---

## Customization

### Change Theme (non-medical)

1. Edit `data/*.csv` files with your domain's data
2. Update `supabase/migrations/` schema if columns differ
3. Rewrite `prompts/system-prompt.ts` with new personality/rules
4. Update `prompts/ai-response-schema.ts` with domain-specific extraction fields
5. Modify `types.ts` interfaces to match
6. Update `webhook/index.ts` response handlers for new `nextAction` values

### Add a New Knowledge Base Table

1. Add migration SQL for the new table
2. Add CSV data file in `data/`
3. Add loader + formatter in `knowledge-base.ts`
4. Include in `user-prompt.ts` context assembly
5. Update seed script in `scripts/seed-data.mjs`
