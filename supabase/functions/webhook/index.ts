// WhatsApp Webhook Edge Function
// Handles incoming WhatsApp messages, processes them with Gemini AI,
// and sends responses back via Meta WhatsApp Cloud API.

import { saveReceivedMessage, saveSentMessage } from "../_shared/chat-history.ts";
import {
  INACTIVITY_BUTTON_PROCEED_ID,
  INACTIVITY_BUTTON_PROCEED_TITLE,
  INACTIVITY_BUTTON_START_NEW_ID,
  INACTIVITY_BUTTON_START_NEW_TITLE,
  INACTIVITY_THRESHOLD_MINUTES,
  MAX_AUDIO_PER_BATCH,
  MAX_QUEUE_BATCH,
  MAX_QUEUE_TURNS,
  PROCESSING_TIMEOUT_MS,
} from "../_shared/constants.ts";
import { extractValidWhatsappMessages } from "../_shared/extract-message.ts";
import { processUserMessage, rephraseFAQ, translateAudioToEnglish } from "../_shared/gemini.ts";
import { getAndClearInactivityMessage, setInactivityMessage } from "../_shared/inactivity.ts";
import { getDoctors, getMedicines } from "../_shared/knowledge-base.ts";
import {
  getMessageDedupKey,
  hasSuspiciousPatterns,
  isDuplicateInboundMessage,
  isOutOfOrderInboundMessage,
} from "../_shared/message-guards.ts";
import {
  composeQueuedMessages,
  drainHeadBatch,
  enqueueMessage,
  hasQueuedMessages,
} from "../_shared/message-queue.ts";
import {
  deleteSession,
  getMinutesSinceLastMessage,
  getMinutesSinceSessionUpdate,
  getOrCreateSession,
  sessionHasData,
  startNewSession,
  updateSession,
} from "../_shared/session.ts";
import { getSupabaseClient } from "../_shared/supabase-client.ts";
import type {
  AIPromptResponse,
  SimplifiedMessage,
  UserSession,
  WhatsAppWebhookPayload,
} from "../_shared/types.ts";
import {
  getMediaUrl,
  sendInteractiveButtons,
  sendInteractiveList,
  sendText,
  sendTyping,
} from "../_shared/whatsapp.ts";

// ─── CORS handler ───
function corsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

// ─── Apply extracted data to session ───
function applyExtractedData(
  session: UserSession,
  data: AIPromptResponse["extractedData"],
): Partial<UserSession> {
  const update: Partial<UserSession> = {};
  console.log("Session", session);

  if (data.symptoms) update.symptoms = data.symptoms;
  if (data.specialization) update.specialization = data.specialization;
  if (data.doctorId) update.doctor_id = data.doctorId;
  if (data.doctorName) update.doctor_name = data.doctorName;
  if (data.clinicId) update.clinic_id = data.clinicId;
  if (data.clinicName) update.clinic_name = data.clinicName;
  if (data.preferredDate) update.preferred_date = data.preferredDate;
  if (data.preferredTime) update.preferred_time = data.preferredTime;
  if (data.medicineIds?.length) update.medicine_ids = data.medicineIds;
  if (data.medicineNames?.length) update.medicine_names = data.medicineNames;
  if (data.userName) update.user_name = data.userName;

  return update;
}

// ─── Send response based on nextAction ───
async function sendResponse(
  to: string,
  aiResponse: AIPromptResponse,
  session: UserSession,
): Promise<void> {
  const { message, nextAction, options, extractedData } = aiResponse;

  // Show doctors list
  if (nextAction === "show_doctors") {
    const doctors = await getDoctors();
    const spec = extractedData.specialization || session.specialization;
    const matched = spec
      ? doctors.filter((d) => d.specialization.toLowerCase().includes(spec.toLowerCase()))
      : doctors;

    if (matched.length > 0 && matched.length <= 10) {
      const sections = [
        {
          title: "Available Doctors",
          rows: matched.map((d) => ({
            id: `doc_${d.id}`,
            title: d.name.slice(0, 24),
            description: `${d.specialization} | ₹${d.consultation_fee} | ${d.rating}★`.slice(
              0,
              72,
            ),
          })),
        },
      ];

      await sendInteractiveList(to, message, "View Doctors", sections);
    } else {
      await sendText(to, message);
    }
    await saveSentMessage(to, message);
    return;
  }

  // Show medicines list
  if (nextAction === "show_medicines") {
    const medicines = await getMedicines();
    const category = extractedData.medicineNames?.[0];
    const matched = category
      ? medicines.filter(
        (m) =>
          m.name.toLowerCase().includes(category.toLowerCase()) ||
          m.category.toLowerCase().includes(category.toLowerCase()) ||
          (m.generic_name &&
            m.generic_name.toLowerCase().includes(category.toLowerCase())),
      )
      : medicines.slice(0, 10);

    if (matched.length > 0 && matched.length <= 10) {
      const sections = [
        {
          title: "Available Medicines",
          rows: matched.map((m) => ({
            id: `med_${m.id}`,
            title: m.name.slice(0, 24),
            description: `${m.category} | ₹${m.price} | ${m.dosage_form}`.slice(
              0,
              72,
            ),
          })),
        },
      ];

      await sendInteractiveList(to, message, "View Medicines", sections);
    } else {
      await sendText(to, message);
    }
    await saveSentMessage(to, message);
    return;
  }

  // Confirm appointment
  if (
    nextAction === "confirm_appointment" &&
    session.doctor_id &&
    session.preferred_date
  ) {
    const confirmMsg = [
      message,
      "",
      "*Appointment Summary:*",
      `Doctor: ${session.doctor_name}`,
      `Clinic: ${session.clinic_name || "N/A"}`,
      `Date: ${session.preferred_date}`,
      `Time: ${session.preferred_time || "To be confirmed"}`,
      session.symptoms ? `Symptoms: ${session.symptoms}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await sendInteractiveButtons(to, confirmMsg, [
      { id: "confirm_apt_yes", title: "Confirm" },
      { id: "confirm_apt_no", title: "Cancel" },
    ]);
    await saveSentMessage(to, confirmMsg);
    return;
  }

  // Book doctor (create appointment)
  if (
    nextAction === "book_doctor" &&
    session.doctor_id &&
    session.preferred_date
  ) {
    // Validate appointment is not in the past (IST = UTC+5:30)
    const aptTime = session.preferred_time || "10:00";
    const aptDateTimeIST = new Date(
      `${session.preferred_date}T${aptTime}:00+05:30`,
    );
    if (aptDateTimeIST <= new Date()) {
      await sendText(
        to,
        `Sorry, *${session.preferred_date} at ${aptTime}* is in the past. Please choose a future date and time.`,
      );
      await updateSession(to, {
        preferred_date: null,
        preferred_time: null,
      } as Partial<UserSession>);
      await saveSentMessage(to, message);
      return;
    }

    const supabase = getSupabaseClient();
    const { error } = await supabase.from("appointments").insert({
      user_id: to,
      doctor_id: session.doctor_id,
      clinic_id: session.clinic_id,
      appointment_date: session.preferred_date,
      appointment_time: aptTime,
      symptoms: session.symptoms,
      status: "confirmed",
    });

    if (error) {
      await sendText(
        to,
        "Sorry, there was an issue booking your appointment. Please try again.",
      );
    } else {
      // Clear booking fields so AI doesn't re-confirm on next message
      await updateSession(to, {
        doctor_id: null,
        doctor_name: null,
        clinic_id: null,
        clinic_name: null,
        preferred_date: null,
        preferred_time: null,
        symptoms: null,
        conversation_context: "general",
        last_prompt_field: null,
      } as Partial<UserSession>);
      await sendText(to, message);
    }
    await saveSentMessage(to, message);
    return;
  }

  // Confirm medicine order
  if (nextAction === "confirm_order" && session.medicine_ids?.length) {
    const medicines = await getMedicines();
    const selected = medicines.filter((m) => session.medicine_ids!.includes(m.id));
    const total = selected.reduce((sum, m) => sum + m.price, 0);

    const orderMsg = [
      message,
      "",
      "*Order Summary:*",
      ...selected.map(
        (m) => `• ${m.name} (${m.strength || m.dosage_form}) — ₹${m.price}`,
      ),
      `*Total: ₹${total}*`,
    ].join("\n");

    await sendInteractiveButtons(to, orderMsg, [
      { id: "confirm_order_yes", title: "Place Order" },
      { id: "confirm_order_no", title: "Cancel" },
    ]);
    await saveSentMessage(to, orderMsg);
    return;
  }

  // Order medicine (create order)
  if (nextAction === "order_medicine" && session.medicine_ids?.length) {
    const medicines = await getMedicines();
    const selected = medicines.filter((m) => session.medicine_ids!.includes(m.id));
    const total = selected.reduce((sum, m) => sum + m.price, 0);

    const supabase = getSupabaseClient();
    const { error } = await supabase.from("medicine_orders").insert({
      user_id: to,
      medicine_ids: session.medicine_ids,
      medicine_names: session.medicine_names || selected.map((m) => m.name),
      quantities: session.medicine_ids!.map(() => 1),
      total_amount: total,
      status: "confirmed",
    });

    if (error) {
      await sendText(
        to,
        "Sorry, there was an issue placing your order. Please try again.",
      );
    } else {
      // Clear order fields so AI doesn't re-confirm on next message
      await updateSession(to, {
        medicine_ids: null,
        medicine_names: null,
        conversation_context: "general",
        last_prompt_field: null,
      } as Partial<UserSession>);
      await sendText(to, message);
    }
    await saveSentMessage(to, message);
    return;
  }

  // Options as buttons (max 3) or list
  if (options && options.length > 0) {
    if (options.length <= 3) {
      const buttons = options.map((opt, i) => ({
        id: `opt_${i}_${opt.slice(0, 15).replace(/[^a-zA-Z0-9_]/g, "")}`,
        title: opt.slice(0, 20),
      }));
      await sendInteractiveButtons(to, message, buttons);
    } else {
      const sections = [
        {
          title: "Options",
          rows: options.slice(0, 10).map((opt, i) => ({
            id: `opt_${i}_${opt.slice(0, 15).replace(/[^a-zA-Z0-9_]/g, "")}`,
            title: opt.slice(0, 24),
          })),
        },
      ];
      await sendInteractiveList(to, message, "Choose", sections);
    }
    await saveSentMessage(to, message);
    return;
  }

  // Default: plain text
  await sendText(to, message);
  await saveSentMessage(to, message);
}

// ─── Process one message turn ───
async function processOneTurn(
  message: SimplifiedMessage,
  session: UserSession,
  isNewSession: boolean,
): Promise<{ session: UserSession; aiResponse: AIPromptResponse }> {
  // Handle audio: get URL from Meta
  if (message.type === "audio" && message.audioId && !message.audioUrl) {
    const audioUrl = await getMediaUrl(message.audioId);
    if (audioUrl) {
      message.audioUrl = audioUrl;
    } else {
      await sendText(
        message.from,
        "Sorry, I couldn't process your audio message. Could you type your message instead?",
      );
      return {
        session,
        aiResponse: {
          extractedData: {
            symptoms: null,
            specialization: null,
            doctorId: null,
            doctorName: null,
            clinicId: null,
            clinicName: null,
            preferredDate: null,
            preferredTime: null,
            medicineIds: null,
            medicineNames: null,
            userName: null,
          },
          message: "",
          nextAction: null,
          status: { outcome: "FAILED", reason: "AUDIO_FAILED", field: null },
          options: null,
          conversationSummary: null,
          callFAQs: false,
        },
      };
    }
  }

  // Audio translation
  let userInputForProcessing = message.text || "";
  let inputType = message.type;
  let isTranslated = false;

  if (message.type === "audio" && message.audioUrl) {
    const translated = await translateAudioToEnglish(
      message.audioUrl,
      message.mimeType || "audio/ogg",
      message.from,
    );
    if (translated && translated.trim().length > 0) {
      userInputForProcessing = translated;
      inputType = "text";
      isTranslated = true;
    }
  }

  // Location to JSON
  if (message.type === "location" && message.location) {
    userInputForProcessing = JSON.stringify(message.location);
  }

  // Handle interactive selections
  if (inputType === "text" && userInputForProcessing.startsWith("doc_")) {
    const docId = userInputForProcessing.replace("doc_", "");
    const doctors = await getDoctors();
    const doc = doctors.find((d) => d.id === docId);
    if (doc) {
      userInputForProcessing =
        `I want to book an appointment with ${doc.name} (${doc.specialization})`;
    }
  }

  if (inputType === "text" && userInputForProcessing.startsWith("med_")) {
    const medId = userInputForProcessing.replace("med_", "");
    const medicines = await getMedicines();
    const med = medicines.find((m) => m.id === medId);
    if (med) {
      userInputForProcessing = `I want to order ${med.name} (${med.generic_name || med.category})`;
    }
  }

  // Handle confirmation buttons
  if (userInputForProcessing === "confirm_apt_yes") {
    userInputForProcessing = "Yes, please confirm my appointment";
  } else if (userInputForProcessing === "confirm_apt_no") {
    userInputForProcessing = "No, I want to cancel this appointment";
  } else if (userInputForProcessing === "confirm_order_yes") {
    userInputForProcessing = "Yes, please place my medicine order";
  } else if (userInputForProcessing === "confirm_order_no") {
    userInputForProcessing = "No, I want to cancel this order";
  }

  // Process with AI
  const aiResponse = await processUserMessage(
    {
      type: inputType as "text" | "audio" | "location",
      userInput: userInputForProcessing,
      mimeType: message.mimeType || "",
      isTranslatedFromAudio: isTranslated,
    },
    session,
    isNewSession,
  );

  // Apply extracted data
  const extracted = aiResponse.extractedData;
  const sessionUpdates = applyExtractedData(session, extracted);

  // Update conversation context based on nextAction
  if (
    aiResponse.nextAction === "show_doctors" ||
    aiResponse.nextAction === "book_doctor" ||
    aiResponse.nextAction === "confirm_appointment"
  ) {
    sessionUpdates.conversation_context = "booking_doctor";
  } else if (
    aiResponse.nextAction === "show_medicines" ||
    aiResponse.nextAction === "order_medicine" ||
    aiResponse.nextAction === "confirm_order"
  ) {
    sessionUpdates.conversation_context = "booking_medicine";
  }

  // Handle FAQ rephrase
  if (aiResponse.callFAQs && aiResponse.message) {
    aiResponse.message = await rephraseFAQ(
      aiResponse.message,
      userInputForProcessing,
    );
  }

  const updatedSession: UserSession = { ...session, ...sessionUpdates };

  return { session: updatedSession, aiResponse };
}

// ─── Main message handler ───
async function handleMessage(
  message: SimplifiedMessage,
  session: UserSession,
  isNewSession: boolean,
): Promise<void> {
  try {
    // Process until queue is empty
    let currentMessage = message;
    let currentSession = session;
    let isNew = isNewSession;
    let lastAiResponse: AIPromptResponse | null = null;

    for (let depth = 0; depth <= MAX_QUEUE_TURNS; depth++) {
      // Send typing indicator before AI processing
      if (currentMessage.id) {
        await sendTyping(currentMessage.id);
      }

      const turn = await processOneTurn(currentMessage, currentSession, isNew);
      currentSession = turn.session;
      lastAiResponse = turn.aiResponse;

      // Save conversation summary
      if (turn.aiResponse.conversationSummary) {
        currentSession.conversation_summary = turn.aiResponse.conversationSummary;
      }

      // Persist session state after each turn
      await updateSession(message.from, {
        ...currentSession,
        last_prompt_response: turn.aiResponse.message,
        last_prompt_field: turn.aiResponse.nextAction,
      });

      // Check for queued messages
      const hasQueue = await hasQueuedMessages(message.from);
      if (!hasQueue || depth >= MAX_QUEUE_TURNS) break;

      // Drain and compose next batch
      const drained = await drainHeadBatch(
        message.from,
        MAX_QUEUE_BATCH,
        MAX_AUDIO_PER_BATCH,
      );
      if (drained.length === 0) break;

      if (currentMessage.id) {
        await sendTyping(currentMessage.id);
      }

      currentMessage = await composeQueuedMessages(
        currentMessage,
        drained,
        translateAudioToEnglish,
      );

      // Refresh session
      const { session: refreshed } = await getOrCreateSession(message.from);
      // Preserve critical fields
      if (currentSession.doctor_id) {
        refreshed.doctor_id = currentSession.doctor_id;
      }
      if (currentSession.medicine_ids) {
        refreshed.medicine_ids = currentSession.medicine_ids;
      }
      if (currentSession.conversation_summary) {
        refreshed.conversation_summary = currentSession.conversation_summary;
      }

      currentSession = refreshed;
      isNew = false;
    }

    // Send final response
    if (lastAiResponse && lastAiResponse.message) {
      await sendResponse(message.from, lastAiResponse, currentSession);
    }
  } catch (error) {
    console.error("handleMessage error:", error);
    await sendText(
      message.from,
      "Sorry, something went wrong. Please try again in a moment.",
    );
  } finally {
    // Clear processing flag
    await updateSession(message.from, {
      is_processing: false,
      processing_started_at: null,
    } as Partial<UserSession>);
  }
}

// ─── Main Deno.serve handler ───
const port = Number(Deno.env.get("PORT") || "8000");

Deno.serve({ port }, async (req: Request): Promise<Response> => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return corsResponse();
  }

  const url = new URL(req.url);

  // ─── GET: Meta webhook verification ───
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const challenge = url.searchParams.get("hub.challenge");
    const token = url.searchParams.get("hub.verify_token");
    const verifyToken = Deno.env.get("WEBHOOK_VERIFY_TOKEN") || "";

    if (mode === "subscribe" && token === verifyToken) {
      console.log("WEBHOOK VERIFIED");
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // ─── POST: Incoming messages ───
  if (req.method === "POST") {
    try {
      const body: WhatsAppWebhookPayload = await req.json();
      const incomingMessages = extractValidWhatsappMessages(body);

      if (incomingMessages.length === 0) {
        return new Response(null, { status: 204 });
      }

      const [message, ...extraMessages] = incomingMessages;

      // Send typing indicator
      if (message.id) {
        await sendTyping(message.id);
      }

      // Reject suspicious input
      if (
        message.type === "text" &&
        hasSuspiciousPatterns(message.text || "")
      ) {
        console.warn(`Rejected suspicious input from ${message.from}`);
        await sendText(
          message.from,
          "I didn't quite understand that. Could you rephrase your request?",
        );
        return new Response(null, { status: 204 });
      }

      const { session, isNew } = await getOrCreateSession(message.from);

      // If webhook contains multiple user messages, enqueue extras now so the
      // processing loop can consume them in order after the first turn.
      if (extraMessages.length > 0) {
        for (const extraMessage of extraMessages) {
          await enqueueMessage(message.from, extraMessage);
        }
      }

      // Seed user_name from WhatsApp profile if not yet set
      if (message.profileName && !session.user_name) {
        await updateSession(message.from, {
          user_name: message.profileName,
        } as Partial<UserSession>);
        session.user_name = message.profileName;
      }

      // RESET command
      if (message.text === "RESET") {
        await startNewSession(session);
        await sendText(
          message.from,
          "Session reset! How can I help you today?",
        );
        return new Response(null, { status: 204 });
      }

      // DEV_RESET command
      if (message.text === "DEV_RESET") {
        await deleteSession(message.from);
        await sendText(
          message.from,
          "Session deleted. Send a new message to start fresh.",
        );
        return new Response(null, { status: 204 });
      }

      // Duplicate guard
      if (isDuplicateInboundMessage(session, message)) {
        return new Response(null, { status: 204 });
      }

      // Inactivity button handlers
      if (message.text === INACTIVITY_BUTTON_START_NEW_ID) {
        const newSession = await startNewSession(session);
        // Check for stored message
        const stored = await getAndClearInactivityMessage(message.from);
        if (stored) {
          await updateSession(message.from, {
            is_processing: true,
            processing_started_at: new Date().toISOString(),
            last_user_message: getMessageDedupKey(stored),
            last_message_timestamp: stored.timestamp,
          } as Partial<UserSession>);
          await handleMessage(stored, newSession, true);
        } else {
          await sendText(
            message.from,
            "Fresh start! How can I help you today? 😊",
          );
        }
        return new Response(null, { status: 204 });
      }

      if (message.text === INACTIVITY_BUTTON_PROCEED_ID) {
        const stored = await getAndClearInactivityMessage(message.from);
        if (stored) {
          await updateSession(message.from, {
            is_processing: true,
            processing_started_at: new Date().toISOString(),
            last_user_message: getMessageDedupKey(stored),
            last_message_timestamp: stored.timestamp,
          } as Partial<UserSession>);
          await handleMessage(stored, session, false);
        }
        return new Response(null, { status: 204 });
      }

      // Out-of-order guard
      if (isOutOfOrderInboundMessage(session, message)) {
        return new Response(null, { status: 204 });
      }

      // Save received message to chat history
      try {
        await saveReceivedMessage(
          message.from,
          message.text ||
            message.audioId ||
            JSON.stringify(message.location) ||
            "",
          message.type,
          message.timestamp,
        );
      } catch (e) {
        console.error("Failed to save received message:", e);
      }

      // Paused auto-replies
      if (session.pause_auto_replies) {
        await updateSession(message.from, {
          last_message_timestamp: message.timestamp,
        } as Partial<UserSession>);
        return new Response(null, { status: 204 });
      }

      // Currently processing: enqueue
      if (session.is_processing) {
        // Check for stuck processing (timeout)
        if (session.processing_started_at) {
          const startedAt = new Date(session.processing_started_at).getTime();
          if (Date.now() - startedAt > PROCESSING_TIMEOUT_MS) {
            console.warn(
              `Processing timeout for ${message.from}, resetting flag`,
            );
            await updateSession(message.from, {
              is_processing: false,
              processing_started_at: null,
            } as Partial<UserSession>);
            // Fall through to process normally
          } else {
            const lastContent = getMessageDedupKey(message);
            await updateSession(message.from, {
              last_user_message: lastContent,
              last_message_timestamp: message.timestamp,
            } as Partial<UserSession>);
            await enqueueMessage(message.from, message);
            return new Response(null, { status: 204 });
          }
        } else {
          const lastContent = getMessageDedupKey(message);
          await updateSession(message.from, {
            last_user_message: lastContent,
            last_message_timestamp: message.timestamp,
          } as Partial<UserSession>);
          await enqueueMessage(message.from, message);
          return new Response(null, { status: 204 });
        }
      }

      // Inactivity check
      const minutesSinceUpdate = getMinutesSinceSessionUpdate(session);
      const minutesSinceLast = getMinutesSinceLastMessage(session);
      const threshold = INACTIVITY_THRESHOLD_MINUTES;

      if (
        !isNew &&
        threshold > 0 &&
        Math.min(minutesSinceUpdate, minutesSinceLast) >= threshold &&
        sessionHasData(session)
      ) {
        await setInactivityMessage(message.from, message);
        await sendInteractiveButtons(
          message.from,
          "*It's been a while.*\n\nWould you like to continue from where we left off, or start a new session?",
          [
            {
              id: INACTIVITY_BUTTON_PROCEED_ID,
              title: INACTIVITY_BUTTON_PROCEED_TITLE,
            },
            {
              id: INACTIVITY_BUTTON_START_NEW_ID,
              title: INACTIVITY_BUTTON_START_NEW_TITLE,
            },
          ],
        );
        await updateSession(message.from, {
          last_message_timestamp: message.timestamp,
        } as Partial<UserSession>);
        return new Response(null, { status: 204 });
      }

      // New user welcome
      if (!session.is_intro_sent) {
        await updateSession(message.from, {
          is_intro_sent: true,
        } as Partial<UserSession>);
        session.is_intro_sent = true;

        const nameGreeting = session.user_name ? ` ${session.user_name}` : "";
        await sendText(
          message.from,
          `Welcome${nameGreeting} to *MediBot*! 🏥\n\nI'm your personal healthcare assistant. I can help you:\n\n• Discuss symptoms & get health guidance\n• Book doctor appointments\n• Order medicines\n\n_You can type or send voice messages in English, Hindi, Tamil, Telugu, Malayalam, or Kannada._\n\nHow can I help you today?`,
        );
        await saveSentMessage(
          message.from,
          "Welcome to MediBot! I can help with symptoms, doctor appointments, and medicines.",
        );

        // Small delay before processing
        await new Promise((r) => setTimeout(r, 2000));
      }

      // Set processing flag
      const lastContent = getMessageDedupKey(message);
      const processingStartedAt = new Date().toISOString();

      await updateSession(message.from, {
        is_processing: true,
        processing_started_at: processingStartedAt,
        last_user_message: lastContent,
        last_message_timestamp: message.timestamp,
      } as Partial<UserSession>);

      session.is_processing = true;
      session.processing_started_at = processingStartedAt;
      session.last_user_message = lastContent;
      session.last_message_timestamp = message.timestamp;

      // Process the message
      await handleMessage(message, session, isNew);

      return new Response(null, { status: 204 });
    } catch (error) {
      console.error("Webhook error:", error);
      return new Response(null, { status: 204 });
    }
  }

  return new Response("Method not allowed", { status: 405 });
});
