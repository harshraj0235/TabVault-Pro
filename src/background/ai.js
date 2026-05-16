/**
 * TabVault Pro - AI Services (Gemini BYOK)
 */

export async function semanticSearch(query, tabsData, apiKey) {
  if (!apiKey) throw new Error("Gemini API key is required.");

  const prompt = `You are a Semantic Search engine for a browser tab manager.
The user is searching for: "${query}"

Here is the JSON list of their currently open tabs:
${JSON.stringify(tabsData.map(t => ({ id: t.id, title: t.title, url: t.url })))}

Your task:
1. Find the tabs that best match the intent or semantic meaning of the user's search. For example, if they search "how to code", return github or stackoverflow tabs.
2. Return ONLY a JSON array of the matching tab IDs (integers).
3. Do not include markdown formatting, backticks, or explanations. Just the raw JSON array.
If none match, return [].`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1 }
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  
  let rawText = data.candidates[0].content.parts[0].text;
  rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
  
  try {
    return JSON.parse(rawText);
  } catch(e) {
    return [];
  }
}
