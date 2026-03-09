// Process Queue Edge Function
// This function can be called via a Supabase cron job or manually
// to process any stuck/orphaned queued messages.
// It handles messages that were queued but never processed due to errors.

import { saveSentMessage } from "../_shared/chat-history.ts";
import {
  MAX_AUDIO_PER_BATCH,
  MAX_QUEUE_BATCH,
  PROCESSING_TIMEOUT_MS,
} from "../_shared/constants.ts";
import { processUserMessage, rephraseFAQ, translateAudioToEnglish } from "../_shared/gemini.ts";
import { composeQueuedMessages, drainHeadBatch } from "../_shared/message-queue.ts";
import { getOrCreateSession, updateSession } from "../_shared/session.ts";
import { getSupabaseClient } from "../_shared/supabase-client.ts";
import type { SimplifiedMessage, UserSession } from "../_shared/types.ts";
import { sendText } from "../_shared/whatsapp.ts";

/**
 * Find users with stuck processing flags (timed out)
 */
async function findStuckSessions(): Promise<UserSession[]> {
  const supabase = getSupabaseClient();

  const timeoutThreshold = new Date(
    Date.now() - PROCESSING_TIMEOUT_MS,
  ).toISOString();

  const { data, error } = await supabase
    .from("user_sessions")
    .select("*")
    .eq("is_processing", true)
    .lt("processing_started_at", timeoutThreshold);

  if (error) {
    console.error("Error finding stuck sessions:", error);
    return [];
  }

  return (data || []) as UserSession[];
}

/**
 * Find users who have queued messages but are not processing
 */
async function findUsersWithOrphanedQueues(): Promise<string[]> {
  const supabase = getSupabaseClient();

  // Get unique user_ids from queued_messages
  const { data, error } = await supabase
    .from("queued_messages")
    .select("user_id")
    .order("created_at", { ascending: true })
    .limit(100);

  if (error || !data) return [];

  // Deduplicate
  const userIds = [
    ...new Set(data.map((d: { user_id: string }) => d.user_id)),
  ] as string[];

  // Filter to only those not currently processing
  const orphaned: string[] = [];
  for (const userId of userIds) {
    const { data: session } = await supabase
      .from("user_sessions")
      .select("is_processing")
      .eq("user_id", userId)
      .single();

    if (!session?.is_processing) {
      orphaned.push(userId);
    }
  }

  return orphaned;
}

/**
 * Process queued messages for a specific user
 */
async function processQueueForUser(userId: string): Promise<void> {
  console.log(`Processing queue for user: ${userId}`);

  const { session } = await getOrCreateSession(userId);

  // Reset processing flag if stuck
  if (session.is_processing) {
    await updateSession(userId, {
      is_processing: false,
      processing_started_at: null,
    } as Partial<UserSession>);
  }

  // Drain messages
  const drained = await drainHeadBatch(
    userId,
    MAX_QUEUE_BATCH,
    MAX_AUDIO_PER_BATCH,
  );

  if (drained.length === 0) {
    console.log(`No queued messages for user: ${userId}`);
    return;
  }

  console.log(`Draining ${drained.length} messages for user: ${userId}`);

  // Set processing
  await updateSession(userId, {
    is_processing: true,
    processing_started_at: new Date().toISOString(),
  } as Partial<UserSession>);

  try {
    // Compose the queued messages into one
    const composed: SimplifiedMessage = {
      type: "text",
      from: userId,
      waId: userId,
      text: "",
      timestamp: drained[drained.length - 1].timestamp,
    };

    const fullMessage = await composeQueuedMessages(
      composed,
      drained,
      translateAudioToEnglish,
    );

    // Process with AI
    const aiResponse = await processUserMessage(
      {
        type: "text",
        userInput: fullMessage.text || "",
        mimeType: "",
      },
      session,
      false,
    );

    // Handle FAQ rephrase
    if (aiResponse.callFAQs && aiResponse.message) {
      aiResponse.message = await rephraseFAQ(
        aiResponse.message,
        fullMessage.text || "",
      );
    }

    // Send response
    if (aiResponse.message) {
      await sendText(userId, aiResponse.message);
      await saveSentMessage(userId, aiResponse.message);
    }

    // Update session
    await updateSession(userId, {
      last_prompt_response: aiResponse.message,
      conversation_summary: aiResponse.conversationSummary || session.conversation_summary,
    } as Partial<UserSession>);
  } catch (error) {
    console.error(`Error processing queue for ${userId}:`, error);
    await sendText(
      userId,
      "Sorry, I had trouble processing your messages. Could you please repeat your request?",
    );
  } finally {
    await updateSession(userId, {
      is_processing: false,
      processing_started_at: null,
    } as Partial<UserSession>);
  }
}

// ─── Main handler ───
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    console.log("Process-queue function invoked");

    // 1. Handle stuck sessions
    const stuckSessions = await findStuckSessions();
    if (stuckSessions.length > 0) {
      console.log(`Found ${stuckSessions.length} stuck session(s)`);
      for (const session of stuckSessions) {
        await processQueueForUser(session.user_id);
      }
    }

    // 2. Handle orphaned queues
    const orphanedUsers = await findUsersWithOrphanedQueues();
    if (orphanedUsers.length > 0) {
      console.log(`Found ${orphanedUsers.length} user(s) with orphaned queues`);
      for (const userId of orphanedUsers) {
        await processQueueForUser(userId);
      }
    }

    const totalProcessed = stuckSessions.length + orphanedUsers.length;
    console.log(`Process-queue complete. Processed ${totalProcessed} user(s).`);

    return new Response(
      JSON.stringify({
        success: true,
        stuckSessions: stuckSessions.length,
        orphanedQueues: orphanedUsers.length,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Process-queue error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
});
