// Shared by the Node service and native browser WebSocket implementation.
export function timedSentenceParts(sentence, begin, end, text) {
  const words = sentence.words;
  if (!Array.isArray(words) || !words.length || words.length > 2000) return null;
  const normalize = value => value.replace(/\s+/gu, ' ').trim();
  let previousEnd = begin, combined = '';
  for (const word of words) {
    if (!word || word.fixed !== true || typeof word.text !== 'string' || !word.text ||
        typeof word.punctuation !== 'string' || !Number.isInteger(word.begin_time) || !Number.isInteger(word.end_time) ||
        word.begin_time < previousEnd || word.end_time <= word.begin_time || word.end_time > end) return null;
    combined += word.text + word.punctuation;
    if (combined.length > 12000) return null;
    previousEnd = word.end_time;
  }
  // Keep leading spaces and apostrophe fragments exactly as emitted.
  if (normalize(combined) !== normalize(text)) return null;
  const parts = [];
  let first = 0, partText = '';
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    partText += word.text + word.punctuation;
    // Only the punctuation field splits sentences, never dots inside words.
    if (/[.!?。！？]/u.test(word.punctuation) || i === words.length - 1) {
      const finalText = normalize(partText);
      if (!finalText) return null;
      parts.push({ text: finalText, begin: words[first].begin_time, end: word.end_time });
      first = i + 1;
      partText = '';
    }
  }
  return parts;
}
