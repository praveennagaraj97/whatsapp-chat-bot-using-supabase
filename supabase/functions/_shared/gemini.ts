// Gemini AI service
import {
  formatDoctorsTable,
  formatFAQsForPrompt,
  formatMedicinesTable,
  getDoctors,
  getFAQs,
  getMedicines,
} from "./knowledge-base.ts";
import { AI_RESPONSE_SCHEMA } from "./prompts/ai-response-schema.ts";
import {
  getAudioTranslationPrompt,
  getAudioTranslationSystemInstruction,
} from "./prompts/audio-translation-prompt.ts";
import { getFAQRephrasePrompt } from "./prompts/faq-prompt.ts";
import { getSystemPrompt } from "./prompts/system-prompt.ts";
import { buildUserPrompt } from "./prompts/user-prompt.ts";
import type { AIPromptResponse, UserSession } from "./types.ts";
import { fetchAudioAsBase64 } from "./whatsapp.ts";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

function getApiKey(): string {
  return Deno.env.get("GEMINI_API_KEY") || "";
}

function getModelName(): string {
  return Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
}

/**
 * Call Gemini API with structured JSON output
 */
async function callGemini(
  systemInstruction: string,
  userPrompt: string,
  responseSchema?: Record<string, unknown>,
): Promise<string> {
  const apiKey = getApiKey();
  const model = getModelName();
  const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;

  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 2048,
    },
  };

  if (responseSchema) {
    (body.generationConfig as Record<string, unknown>).responseMimeType = "application/json";
    (body.generationConfig as Record<string, unknown>).responseSchema = responseSchema;
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return text;
}

/**
 * Call Gemini with audio input (for translation)
 */
async function callGeminiWithAudio(
  systemInstruction: string,
  prompt: string,
  audioBase64: string,
  mimeType: string,
): Promise<string> {
  const apiKey = getApiKey();
  const model = getModelName();
  const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: audioBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1024,
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini audio API error (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

/**
 * Parse JSON from AI response with fallback
 */
function parseAIResponse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text);
  } catch {
    // Try extracting from markdown fences
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch {
        /* fall through */
      }
    }

    // Try extracting first balanced JSON object
    const start = text.indexOf("{");
    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(text.slice(start, i + 1));
            } catch {
              break;
            }
          }
        }
      }
    }

    console.error("Failed to parse AI response, using fallback");
    return fallback;
  }
}

/**
 * Main AI extraction: processes user input against knowledge base
 */
export async function processUserMessage(
  data: {
    type: "text" | "audio" | "location";
    userInput: string;
    mimeType: string;
    isTranslatedFromAudio?: boolean;
  },
  session: UserSession,
  isNewSession: boolean,
): Promise<AIPromptResponse> {
  const defaultResponse: AIPromptResponse = {
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
    message: "Sorry, I ran into a technical problem. Please try again.",
    nextAction: null,
    status: { outcome: "FAILED", reason: "INTERNAL_ERROR", field: null },
    options: null,
    conversationSummary: null,
    callFAQs: false,
  };

  try {
    // Load knowledge base
    const [doctors, medicines, faqs] = await Promise.all([
      getDoctors(),
      getMedicines(),
      getFAQs(),
    ]);

    const doctorsTable = formatDoctorsTable(doctors);
    const medicinesTable = formatMedicinesTable(medicines);
    const faqsText = formatFAQsForPrompt(faqs);

    const systemPrompt = getSystemPrompt(session);
    const userPrompt = buildUserPrompt({
      userInput: data.userInput,
      inputType: data.type,
      session,
      isNewSession,
      doctorsTable,
      medicinesTable,
      faqsText,
      isTranslatedFromAudio: data.isTranslatedFromAudio || false,
    });

    const resultText = await callGemini(
      systemPrompt,
      userPrompt,
      AI_RESPONSE_SCHEMA,
    );
    const result = parseAIResponse<AIPromptResponse>(
      resultText,
      defaultResponse,
    );

    return result;
  } catch (error) {
    console.error("processUserMessage error:", error);
    return defaultResponse;
  }
}

/**
 * Translate audio from Indian languages to English
 */
export async function translateAudioToEnglish(
  audioUrl: string,
  mimeType: string,
  _userId: string,
): Promise<string | null> {
  try {
    const audioBase64 = await fetchAudioAsBase64(audioUrl);
    const systemInstruction = getAudioTranslationSystemInstruction();
    const prompt = getAudioTranslationPrompt();
    const text = await callGeminiWithAudio(
      systemInstruction,
      prompt,
      audioBase64,
      mimeType,
    );
    return text.trim() || null;
  } catch (error) {
    console.error("Audio translation error:", error);
    return null;
  }
}

/**
 * Rephrase FAQ answer with AI context
 */
export async function rephraseFAQ(
  currentAIMessage: string,
  userQuestion: string,
): Promise<string> {
  try {
    const faqs = await getFAQs();
    const faqsText = formatFAQsForPrompt(faqs);
    const prompt = getFAQRephrasePrompt(
      currentAIMessage,
      userQuestion,
      faqsText,
    );

    const result = await callGemini(
      "You are a friendly healthcare assistant. Rephrase FAQ answers naturally.",
      prompt,
    );
    return result.trim() || currentAIMessage;
  } catch {
    return currentAIMessage;
  }
}
