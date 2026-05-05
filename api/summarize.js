const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent";

const MAX_CONTENT_LENGTH = 12000;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "METHOD_NOT_ALLOWED",
      hint: "Only POST requests are accepted.",
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      "[Contextify Proxy] GEMINI_API_KEY environment variable is not set.",
    );
    return res.status(500).json({
      error: "SERVER_MISCONFIGURED",
      hint: "The proxy server is missing its API key. Check Vercel environment variables.",
    });
  }

  const { title, content, wordCount } = req.body || {};

  if (!content || typeof content !== "string" || content.trim().length < 100) {
    return res.status(400).json({
      error: "INVALID_REQUEST",
      hint: "content must be a string of at least 100 characters.",
    });
  }

  const truncatedContent = content.slice(0, MAX_CONTENT_LENGTH);

  const prompt = `You are a precise content summarizer. Analyze the following webpage content and return a JSON object only; no markdown, no explanation, no code fences.

Page title: ${title || "Unknown"}
Word count: ${wordCount || "Unknown"}

Content: ${truncatedContent}

Return this exact JSON structure:
{
  "bullets": [
    "First key point as a complete sentence.",
    "Second key point as a complete sentence.",
    "Third key point as a complete sentence.",
    "Fourth key point as a complete sentence.",
    "Fifth key point as a complete sentence."
  ],
  "keyInsights": [
    "First actionable or notable insight.",
    "Second actionable or notable insight.",
    "Third actionable or notable insight."
  ],
  "readingTime": "X min"
}

Rules:
- bullets: exactly 5 items, each a standalone factual sentence about the content
- keyInsights: exactly 3 items, each a meaningful takeaway or implication
- readingTime: estimate based on ${wordCount || 200} words at 200 wpm, format as "X min"
- All strings must be plain text; no HTML, no markdown, no bullet characters
- Return only the JSON object, nothing else`;

  let geminiRes;
  try {
    geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1024,
          topP: 0.8,
          response_mime_type: "application/json",
        },
      }),
    });
  } catch (err) {
    console.error("[Contextify Proxy] Network error calling Gemini:", err);
    return res.status(502).json({
      error: "NETWORK_ERROR",
      hint: "Could not reach the Gemini API. Try again shortly.",
    });
  }

  if (!geminiRes.ok) {
    const errBody = await geminiRes.json().catch(() => ({}));
    console.error(
      "[Contextify Proxy] Gemini error:",
      geminiRes.status,
      errBody,
    );

    if (geminiRes.status === 400) {
      return res.status(400).json({
        error: "INVALID_REQUEST",
        hint: "Gemini rejected the request.",
      });
    }
    if (geminiRes.status === 401 || geminiRes.status === 403) {
      return res.status(502).json({
        error: "INVALID_API_KEY",
        hint: "Gemini API key is invalid or lacks permissions.",
      });
    }
    if (geminiRes.status === 429) {
      return res.status(429).json({
        error: "RATE_LIMIT",
        hint: "Gemini rate limit reached. Wait a moment and retry.",
      });
    }

    return res.status(502).json({
      error: "GEMINI_ERROR",
      hint: `Gemini returned status ${geminiRes.status}.`,
    });
  }

  let geminiData;
  try {
    geminiData = await geminiRes.json();
  } catch (err) {
    return res
      .status(502)
      .json({ error: "PARSE_ERROR", hint: "Could not parse Gemini response." });
  }

  const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    return res.status(502).json({
      error: "EMPTY_RESPONSE",
      hint: "Gemini returned an empty response.",
    });
  }

  let summary;
  try {
    const firstBrace = rawText.indexOf("{");
    const lastBrace = rawText.lastIndexOf("}");

    if (firstBrace === -1 || lastBrace === -1) {
      throw new Error("No JSON object found in response.");
    }

    const extracted = rawText.slice(firstBrace, lastBrace + 1);
    summary = JSON.parse(extracted);
  } catch (err) {
    console.error("[Contextify Proxy] Failed to parse Gemini JSON:", rawText);
    return res.status(502).json({
      error: "INVALID_JSON",
      hint: "Gemini did not return valid JSON. Try again.",
    });
  }

  const sanitized = {
    bullets: sanitizeList(summary.bullets, 5),
    keyInsights: sanitizeList(summary.keyInsights, 3),
    readingTime:
      sanitizeString(summary.readingTime) ||
      `${Math.ceil((wordCount || 200) / 200)} min`,
    wordCount: Number.isFinite(wordCount) ? wordCount : 0,
  };

  return res.status(200).json(sanitized);
}

function sanitizeList(list, maxLen) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, maxLen)
    .map((item) => sanitizeString(item))
    .filter(Boolean);
}

function sanitizeString(str) {
  if (typeof str !== "string") return "";
  return str.replace(/<[^>]*>/g, "").trim();
}
