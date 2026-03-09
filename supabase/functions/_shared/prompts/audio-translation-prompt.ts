// Audio translation prompt
export function getAudioTranslationPrompt(): string {
  return `
Transcribe and translate the audio to clear, natural English.

Priority languages: Malayalam, English, Tamil, Telugu, Kannada, Hindi.

If the audio is already in English, return it as-is. Preserve medicine names, doctor names, numbers, dates, and times exactly as spoken. If languages are mixed, translate everything to English while maintaining conversational flow. If audio is unclear or silent, return empty string.

Return ONLY the English translation text with no explanations or formatting.
`.trim();
}

export function getAudioTranslationSystemInstruction(): string {
  return "You are a professional translator specializing in Indian languages for healthcare communication. Accurately transcribe and translate audio from Malayalam, English, Tamil, Telugu, Kannada, or Hindi to clear, natural English. Preserve the user's intent and meaning, especially medical terms and medicine names.";
}
