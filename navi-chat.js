// Vercel serverless function — powers the conversational Navi interface.
// Each turn: send the running message history to Claude, let Claude reply
// AND (via tool-use) record/update whatever structured facts it has learned
// about this person so far. The tool call always carries Claude's FULL
// current understanding, not a delta — so each write simply replaces the
// same Airtable row (keyed by session_id) with the latest picture.
//
// Required environment variables (Vercel → Settings → Environment Variables):
//   ANTHROPIC_API_KEY  — from console.anthropic.com (this is a paid API —
//                        billed per token, separate from any Claude.ai plan)
//   AIRTABLE_TOKEN     — Airtable Personal Access Token
//   AIRTABLE_BASE_ID   — the base ID (starts with "app...")
//
// Airtable setup: one table named "Conversations" with these fields —
// session_id, person_type, name, email, land_or_place, role_or_work,
// needs, offers, frameworks_mentioned, notes, last_updated.

const SYSTEM_PROMPT = `You are Navi, a guide for Commons — a living network of SLO County's relationship with its land. You're having a real conversation with someone, not administering a form.

Your very first message, before anything else, is always exactly: "What brings you here — a place, a project, something that happened, or just curious what this is?"

From there, listen for who you're talking to:
- A resident or curious person who just wants to understand the project
- A practitioner — grazer, forester, watershed steward, educator, tribal member, or similar land-based work
- Someone bringing up a specific tree or place they care about
- Someone who's been through a land-related conflict or coordination challenge and is looking for help or resources

If someone says they're just curious, or asks what this is: give a short, genuine answer — Commons is a living network connecting people to SLO County's land and the community already caring for it, and you're their way into it. Let it land as an invitation to become part of that connective tissue, not an explanation of a database or a request for their information — a vibe, not a pitch, and definitely not "we're gathering data." If they leave it there, ask a natural follow-up that flows from whatever they just said, so satisfying the curiosity becomes the start of the real conversation instead of where it ends.

But if they keep going — asking more, wanting to actually understand it — don't shut that down or redirect too fast. Let her go deeper with something real. This isn't just an information chat: it's meant to become a place for generative connection, where people can find and build out real projects and initiatives, and draw on resources for evolving civic programming and engagement as it grows. Frame it as part of an evolving shift in how this community — and the people in it — can function together, not a static directory or a one-time survey. Keep it specific and genuine, not a pitch. Once they seem satisfied, that's the natural moment to bring it back to a real follow-up question about them.

Ask only ONE question at a time. Keep your responses short — two to four sentences, warm and curious, never formal or form-like. Follow their lead; if they want to talk about something else first, let them.

As you learn things worth remembering — who they are, what land or place they're connected to, what kind of work or relationship they have, what they need, what they can offer, any specific frameworks or precedents they mention — call the log_contact tool, every time you learn something new. Always pass your full current understanding of every field you know, not just what's new, since each call replaces the prior record. Never mention the tool or any recording to the person; it should feel invisible.

If it feels natural and you don't already have it, ask for their email later in the conversation so the project can follow up — but never make that feel required or transactional.

You are responsible for ending the conversation, not just answering forever. When it's reached a natural close — they've shared what they came to share, they clearly indicate they're done, or you've gathered what's useful and there's nothing more to explore right now — say a real, warm goodbye (not a customer-service sign-off, not "let me know if you need anything else") and then call the end_conversation tool. Don't cut things off early or pad it out with "anything else?" loops once it's genuinely complete — recognize the close and take it.`;

const TOOLS = [{
  name: "log_contact",
  description: "Record or update what's known about this person so far. Call every time you learn something new, always passing your full current understanding of all fields (not just what changed).",
  input_schema: {
    type: "object",
    properties: {
      person_type: { type: "string", description: "resident, practitioner, tree_steward, civic_conflict, or unclear" },
      name: { type: "string" },
      email: { type: "string" },
      land_or_place: { type: "string", description: "what land, place, or project they're connected to" },
      role_or_work: { type: "string", description: "their work or role, if a practitioner" },
      needs: { type: "string" },
      offers: { type: "string" },
      frameworks_mentioned: { type: "string" },
      notes: { type: "string", description: "anything else worth remembering" },
    },
  },
}, {
  name: "end_conversation",
  description: "Call this once, right after your closing goodbye message, when the conversation has reached a natural, complete end.",
  input_schema: { type: "object", properties: {} },
}];

async function upsertContact(sessionId, fields) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Conversations");
  const headers = {
    Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
    "Content-Type": "application/json",
  };

  const formula = encodeURIComponent(`{session_id}="${sessionId}"`);
  const searchRes = await fetch(`https://api.airtable.com/v0/${base}/${table}?filterByFormula=${formula}`, { headers });
  const searchData = await searchRes.json();
  const existing = searchData.records && searchData.records[0];

  const payloadFields = { ...fields, session_id: sessionId, last_updated: new Date().toISOString() };

  if (existing) {
    await fetch(`https://api.airtable.com/v0/${base}/${table}/${existing.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ fields: payloadFields }),
    });
  } else {
    await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ records: [{ fields: payloadFields }] }),
    });
  }
}

async function callClaude(messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages,
      tools: TOOLS,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }
  return res.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { sessionId, messages } = req.body || {};
  if (!sessionId || !Array.isArray(messages)) {
    res.status(400).json({ error: "Missing sessionId or messages" });
    return;
  }

  // Cost/abuse guard: caps the worst case for any one session. A genuine
  // conversation won't get near this; a bot looping the endpoint will.
  if (messages.length > 40) {
    res.status(200).json({
      reply: "This conversation's gotten quite long — let's pick it back up another time. Thank you for talking with me.",
      ended: true,
      newMessages: [],
    });
    return;
  }

  try {
    let convo = [...messages];
    let finalText = "";
    let ended = false;

    // Loop to handle tool-use turns: Claude may call a tool and stop before
    // producing conversational text — if so, we feed back tool_results and
    // ask again, up to a few times, until we get real text (or run out).
    for (let i = 0; i < 4; i++) {
      const data = await callClaude(convo);
      const content = data.content || [];
      const textBlocks = content.filter(b => b.type === "text").map(b => b.text);
      const toolUses = content.filter(b => b.type === "tool_use");

      if (textBlocks.length) {
        finalText += (finalText ? "\n\n" : "") + textBlocks.join("\n\n");
      }

      for (const t of toolUses) {
        if (t.name === "log_contact") {
          try { await upsertContact(sessionId, t.input); }
          catch (e) { console.error("Airtable upsert failed:", e); }
        } else if (t.name === "end_conversation") {
          ended = true;
        }
      }

      convo.push({ role: "assistant", content });

      if (data.stop_reason === "tool_use") {
        // Every tool_use block needs a matching tool_result, regardless of
        // which tool it was — otherwise the next API call errors.
        convo.push({
          role: "user",
          content: toolUses.map(t => ({ type: "tool_result", tool_use_id: t.id, content: "ok" })),
        });
        continue;
      }
      break;
    }

    res.status(200).json({
      reply: finalText.trim(),
      ended,
      // New turns this exchange added (may include tool_use/tool_result
      // bookkeeping pairs) — the frontend appends these to its own history
      // so next turn's request has full, coherent context.
      newMessages: convo.slice(messages.length),
    });
  } catch (err) {
    console.error("navi-chat handler error:", err);
    res.status(502).json({ error: "Navi is unavailable right now" });
  }
};
