import { GoogleGenAI } from "npm:@google/genai@latest";
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

type GeminiKeyLabel = "Primary Key" | "Fallback One" | "Fallback Two";

type GeminiApiKeyEntry = {
  label: GeminiKeyLabel;
  key: string;
};

function getEnv(name: string): string {
  return (Deno.env.get(name) || "").trim();
}

function loadApiKeyEntries(): GeminiApiKeyEntry[] {
  const primary = getEnv("GEMINI_PRIMARY_KEY") || getEnv("GEMINI_API_KEY");
  const fallbackOne = getEnv("GEMINI_FALLBACK_ONE");
  const fallbackTwo = getEnv("GEMINI_FALLBACK_TWO");

  const explicitEntries: GeminiApiKeyEntry[] = [
    { label: "Primary Key" as const, key: primary },
    { label: "Fallback One" as const, key: fallbackOne },
    { label: "Fallback Two" as const, key: fallbackTwo },
  ].filter((entry) => Boolean(entry.key));

  if (explicitEntries.length > 0) {
    return explicitEntries;
  }

  // Backward compatibility for old CSV key config.
  const csv = getEnv("GEMINI_API_KEYS")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  return [
    { label: "Primary Key" as const, key: csv[0] || "" },
    { label: "Fallback One" as const, key: csv[1] || "" },
    { label: "Fallback Two" as const, key: csv[2] || "" },
  ].filter((entry) => Boolean(entry.key));
}

function getModelName(): string {
  return Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
}

const apiKeyEntries = loadApiKeyEntries();
let currentKeyIndex = 0;
let genAIClient: GoogleGenAI | null = null;

if (apiKeyEntries.length > 0) {
  const labels = apiKeyEntries.map((entry, index) => `${entry.label}(${index})`).join(", ");
  console.info(`[Gemini] Loaded ${apiKeyEntries.length} API key(s): ${labels}`);
} else {
  console.error("[Gemini] Loaded 0 API keys. Rotation is disabled.");
}

function getCurrentKeyEntry(): GeminiApiKeyEntry {
  return apiKeyEntries[currentKeyIndex];
}

function getCurrentClient(): GoogleGenAI {
  if (apiKeyEntries.length === 0) {
    throw new Error(
      "Missing Gemini API key. Set GEMINI_PRIMARY_KEY (optional: GEMINI_FALLBACK_ONE, GEMINI_FALLBACK_TWO) or GEMINI_API_KEYS",
    );
  }

  if (!genAIClient) {
    genAIClient = new GoogleGenAI({ apiKey: getCurrentKeyEntry().key });
  }

  return genAIClient;
}

function rotateApiKey(startingIndex: number, failureReason?: string): boolean {
  if (apiKeyEntries.length <= 1) return false;

  const previousIndex = currentKeyIndex;
  currentKeyIndex = (currentKeyIndex + 1) % apiKeyEntries.length;

  if (currentKeyIndex === startingIndex && previousIndex !== startingIndex) {
    return false;
  }

  const failedEntry = apiKeyEntries[previousIndex];
  const nextEntry = apiKeyEntries[currentKeyIndex];
  const reason = failureReason ? ` Reason: ${failureReason}` : "";
  console.error(
    `[Gemini] ${failedEntry.label} (index ${previousIndex}) failed.${reason} Rotating to ${nextEntry.label} (index ${currentKeyIndex}).`,
  );

  genAIClient = new GoogleGenAI({ apiKey: nextEntry.key });
  return true;
}

function isApiKeyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const err = error as Record<string, unknown>;
  const message = String(err.message || "").toLowerCase();
  const code = String(err.code || "").toLowerCase();
  const status = String(err.status || "").toLowerCase();
  const details = JSON.stringify(err).toLowerCase();
  const statusCode = Number(
    err.statusCode ||
      (typeof err.response === "object" && err.response
        ? (err.response as Record<string, unknown>).status
        : undefined) ||
      err.code ||
      (typeof err.error === "object" && err.error
        ? (err.error as Record<string, unknown>).code
        : undefined) ||
      0,
  );

  const indicators = [
    "api key",
    "authentication",
    "unauthorized",
    "quota",
    "rate limit",
    "permission denied",
    "invalid api key",
    "overloaded",
    "unavailable",
    "resource exhausted",
    "retrydelay",
    "generativelanguage.googleapis.com/generate_content",
    "exceeded your current quota",
  ];

  return indicators.some((indicator) =>
    message.includes(indicator) ||
    code.includes(indicator) ||
    status.includes(indicator) ||
    details.includes(indicator)
  ) || [401, 403, 429, 503].includes(statusCode);
}

/**
 * Call Gemini API with structured JSON output
 */
async function callGemini(
  systemInstruction: string,
  userPrompt: string,
  responseSchema?: Record<string, unknown>,
): Promise<string> {
  const model = getModelName();
  const initialKeyIndex = currentKeyIndex;
  const maxAttempts = Math.max(apiKeyEntries.length, 1);
  let attempts = 0;
  let lastError: unknown;

  while (attempts < maxAttempts) {
    try {
      const client = getCurrentClient();
      const config: Record<string, unknown> = {
        systemInstruction,
        temperature: 0.3,
        maxOutputTokens: 2048,
      };

      if (responseSchema) {
        config.responseMimeType = "application/json";
        config.responseSchema = responseSchema;
      }

      const response = await client.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        config,
      });

      return response.text || "";
    } catch (error) {
      lastError = error;
      attempts++;
      const activeEntry = getCurrentKeyEntry();
      const reason = error instanceof Error ? error.message : String(error);

      console.error(
        `[Gemini] Request failed on ${activeEntry.label} (index ${currentKeyIndex}), attempt ${attempts}/${maxAttempts}. Reason: ${reason}`,
      );

      if (isApiKeyError(error) && attempts < maxAttempts) {
        if (rotateApiKey(initialKeyIndex, reason)) {
          continue;
        }
      }

      break;
    }
  }

  throw new Error(`Gemini API error after ${attempts} attempt(s): ${String(lastError)}`);
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
  const model = getModelName();
  const initialKeyIndex = currentKeyIndex;
  const maxAttempts = Math.max(apiKeyEntries.length, 1);
  let attempts = 0;
  let lastError: unknown;

  while (attempts < maxAttempts) {
    try {
      const client = getCurrentClient();
      const response = await client.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType,
                  data: audioBase64,
                },
              },
            ],
          },
        ],
        config: {
          systemInstruction,
          temperature: 0.1,
          maxOutputTokens: 1024,
        },
      });

      return response.text || "";
    } catch (error) {
      lastError = error;
      attempts++;
      const activeEntry = getCurrentKeyEntry();
      const reason = error instanceof Error ? error.message : String(error);

      console.error(
        `[Gemini][Audio] Request failed on ${activeEntry.label} (index ${currentKeyIndex}), attempt ${attempts}/${maxAttempts}. Reason: ${reason}`,
      );

      if (isApiKeyError(error) && attempts < maxAttempts) {
        if (rotateApiKey(initialKeyIndex, reason)) {
          continue;
        }
      }

      break;
    }
  }

  throw new Error(`Gemini audio API error after ${attempts} attempt(s): ${String(lastError)}`);
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
