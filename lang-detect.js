// ─── Centralized Language Detection ──────────────────────────────────────────
//
// Single source of truth for language detection and auto-target selection.
// Used by translate.js, translate-local.js, and (indirectly) popup.js via IPC.

const LANGUAGES = {
  en: "English",
  es: "Spanish",
  ru: "Russian",
};

/**
 * Detect the most likely language of the given text.
 * Returns "ru", "es", or "en".
 */
function detectLanguage(text) {
  const letters = (text.match(/\p{L}/gu) || []);
  if (letters.length === 0) return "en";

  // Cyrillic → Russian
  const cyrillicCount = (text.match(/[\u0400-\u04FF]/g) || []).length;
  if (cyrillicCount / letters.length > 0.5) return "ru";

  // Spanish indicators: ñ, accented vowels, ¿, ¡
  const spanishChars = (text.match(/[ñÑáéíóúüÁÉÍÓÚÜ¿¡]/g) || []).length;
  if (spanishChars >= 2) return "es";

  // Common Spanish function words (checked only for Latin-script text)
  const lowerText = text.toLowerCase();
  const spanishWords =
    /\b(el|los|las|del|por|para|con|una|uno|como|más|pero|que|esta|fue|hay|puede|todos|así|entre|cuando|muy|sin|sobre|después|tiene|desde|están|donde|antes|esos?|estas?|aunque|cada|hacia|porque|alguna?|entonces|ahora|durante|siempre|además|mejor|hacer|también|nuevo|otro)\b/g;
  const spanishHits = (lowerText.match(spanishWords) || []).length;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 3 && spanishHits / wordCount > 0.15) return "es";

  return "en";
}

/**
 * Pick the best target language given source text and user's default target.
 * If the detected source matches the target, returns a sensible alternative.
 */
function autoTargetLang(text, defaultTarget) {
  const src = detectLanguage(text);
  if (src !== defaultTarget) return defaultTarget || "en";

  // Source matches the user's preferred target — pick an alternative
  if (src === "ru") return "en";
  if (src === "es") return "en";
  return "ru"; // English text → Russian by default
}

module.exports = { detectLanguage, autoTargetLang, LANGUAGES };
