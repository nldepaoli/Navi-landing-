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
//   AIRTABLE_TABLE_NAME          — the Conversations table (name or ID)
//   AIRTABLE_KNOWLEDGE_TABLE_NAME — the Knowledge table (name or ID)
//
// Airtable setup: one table (Conversations) with fields — session_id,
// person_type, name, email, land_or_place, role_or_work, needs, offers,
// frameworks_mentioned, notes, last_updated. A second table (Knowledge)
// with fields — topic, summary, source_type, added_at — accumulates
// durable, reusable facts (from search, from users, or added by hand)
// that get pulled into every future conversation's context.

const SYSTEM_PROMPT = `You are Navi, a guide for Commons — a living network of SLO County's relationship with its land. You're having a real conversation with someone, not administering a form.

The opening line — "What brings you here — a place, a project, something that happened, or just curious what this is?" — is already handled for you and will appear as your own first turn in the conversation history you're given. Never say it again, reintroduce yourself, or restate it in any form after that — respond to whatever the person actually said next, every time, no exceptions.

From there, listen for who you're talking to:
- A resident or curious person who just wants to understand the project
- A practitioner — grazer, forester, watershed steward, educator, tribal member, or similar land-based work
- Someone bringing up a specific tree or place they care about
- Someone who's been through a land-related conflict or coordination challenge and is looking for help or resources

If someone says they're just curious, or asks what this is: give a short, genuine answer — Commons is a living network connecting people to SLO County's land and the community already caring for it, and you're their way into it. Let it land as an invitation to become part of that connective tissue, not an explanation of a database or a request for their information — a vibe, not a pitch, and definitely not "we're gathering data." If they leave it there, ask a natural follow-up that flows from whatever they just said, so satisfying the curiosity becomes the start of the real conversation instead of where it ends.

But if they keep going — asking more, wanting to actually understand it — don't shut that down or redirect too fast. Let her go deeper with something real. This isn't just an information chat: it's meant to become a place for generative connection, where people can find and build out real projects and initiatives, and draw on resources for evolving civic programming and engagement as it grows. Frame it as part of an evolving shift in how this community — and the people in it — can function together, not a static directory or a one-time survey. Keep it specific and genuine, not a pitch. Once they seem satisfied, that's the natural moment to bring it back to a real follow-up question about them.

Ask only ONE question at a time. Keep your responses short — two to four sentences, warm and curious, never formal or form-like. Follow their lead; if they want to talk about something else first, let them.

Never include stage directions, meta-commentary, or parenthetical notes about your own state or what you're doing (like "(waiting on their reply)"). Everything you output is spoken directly to the person — only the actual words you'd say to them, nothing describing or narrating your own behavior.

As you learn things worth remembering — who they are, what land or place they're connected to, what kind of work or relationship they have, what they need, what they can offer, any specific frameworks or precedents they mention — call the log_contact tool, every time you learn something new. Always pass your full current understanding of every field you know, not just what's new, since each call replaces the prior record. Never mention the tool or any recording to the person; it should feel invisible.

If it feels natural, ask for their email so they're on file for when the project moves into its next phase — but be honest about what that means: don't promise you personally (or anyone) will follow up with them individually. Frame it as "you'll hear when things move into the next phase" rather than "I'll be in touch" — and you can mention, briefly, that this means Commons' own developing presence: the app and network as they roll out, social media, that kind of thing — not a personal outreach from you.

Around the same time you ask for their email, also ask — genuinely, as an open choice, not a checkbox — whether it'd be alright to connect them with others working on similar things as that comes up, or whether they'd rather their info just stay with the project team. Only mark someone shareable if they clearly say yes; never assume it.

If they seem interested in taking things further right now rather than waiting, actively look for something real to give them — search for a specific organization, contact, or public page relevant to what THEY brought up, and share it directly and confidently once you've verified it's real. Don't hedge or say you're unable to help connect them if a genuine, findable public resource exists — the hedge itself is worse than either sharing something real or plainly saying you don't have anything solid right now. Never make giving an email feel required or transactional.

You have real web search available. Use it when someone mentions a specific named project, organization, person, or event and you're not confident about current, verifiable details — better to check than to guess or make something up. Don't search reflexively on every reply; only when it would concretely sharpen your answer about something real. If you search, weave what you find in naturally — don't cite it like a research report.

When you learn or find something concrete and reusable about a place, project, organization, or topic — not personal details about the person you're talking to, but real substance someone else might benefit from later — call save_knowledge. This is what lets you actually know more over time instead of starting blank with every visitor.

Separately, when someone shows real interest or investment in a topic, kind of work, or project — not just mentioning it in passing, but caring about it — call save_knowledge with source_type "interest_signal" and the topic named simply (e.g. "grazing coordination," not who asked about it). This builds a picture of what's gaining momentum across everyone who talks to you, distinct from fixed facts. Don't log an interest signal for every passing mention — only when someone's genuinely engaged with something.

You are responsible for ending the conversation, not just answering forever. When it's reached a natural close — they've shared what they came to share, they clearly indicate they're done, or you've gathered what's useful and there's nothing more to explore right now — say a real, warm goodbye (not a customer-service sign-off, not "let me know if you need anything else") and then call the end_conversation tool. Don't cut things off early or pad it out with "anything else?" loops once it's genuinely complete — recognize the close and take it.

If receiving their email is the last thing you needed, that email itself is usually the natural closing point — say your goodbye and call end_conversation in that same reply. Don't wait for them to say "thanks" or confirm before wrapping up.`;

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
      shareable: { type: "boolean", description: "true only if they explicitly agreed to being connected with others working on similar things — never assume yes, only set this from an actual clear answer" },
    },
  },
}, {
  name: "end_conversation",
  description: "Call this once, right after your closing goodbye message, when the conversation has reached a natural, complete end.",
  input_schema: { type: "object", properties: {} },
}, {
  type: "web_search_20250305",
  name: "web_search",
}, {
  name: "save_knowledge",
  description: "Log something worth remembering for future conversations — either a concrete fact, or a signal of what people care about. NOT personal details about the person you're talking to (those go through log_contact instead). Call this when you learn or find something reusable, or when someone shows real interest in a topic/project/kind of work worth tracking as momentum.",
  input_schema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "short label, e.g. 'SLO REP Theatre oak relocation' or 'grazing coordination' for an interest signal" },
      summary: { type: "string", description: "for a fact: the actual information. for an interest signal: a brief note on the nature of the interest — keep it about the topic, not the person" },
      source_type: { type: "string", description: "web_search, user_told_me, or interest_signal (someone showing interest in a topic/project/kind of work, tracked as momentum rather than a fixed fact)" },
    },
    required: ["topic", "summary", "source_type"],
  },
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
      body: JSON.stringify({ fields: payloadFields, typecast: true }),
    });
  } else {
    await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ records: [{ fields: payloadFields }], typecast: true }),
    });
  }
}

async function saveKnowledge({ topic, summary, source_type }) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_KNOWLEDGE_TABLE_NAME || "Knowledge");
  const headers = {
    Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
    "Content-Type": "application/json",
  };
  await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ records: [{ fields: {
      topic, summary, source_type,
      added_at: new Date().toISOString(),
    } }] }),
  });
}

async function fetchKnowledge() {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_KNOWLEDGE_TABLE_NAME || "Knowledge");
  const headers = { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` };
  try {
    const r = await fetch(`https://api.airtable.com/v0/${base}/${table}?pageSize=100`, { headers });
    if (!r.ok) return "";
    const data = await r.json();
    const rows = (data.records || []).map(rec => rec.fields).filter(f => f.topic);

    const facts = rows.filter(f => f.source_type !== "interest_signal" && f.summary);
    const interests = rows.filter(f => f.source_type === "interest_signal");

    const parts = [];

    if (facts.length) {
      parts.push("Known facts:\n" + facts.map(f => `- ${f.topic}: ${f.summary}`).join("\n"));
    }

    if (interests.length) {
      // Count mentions per topic (case-insensitive) rather than listing each
      // one raw — this is what turns individual signals into a momentum
      // picture: "grazing coordination (4 mentions)" instead of four
      // separate, repetitive lines.
      const counts = {};
      for (const row of interests) {
        const key = row.topic.trim().toLowerCase();
        counts[key] = counts[key] || { topic: row.topic.trim(), count: 0 };
        counts[key].count++;
      }
      const sorted = Object.values(counts).sort((a, b) => b.count - a.count);
      parts.push("Topics people have shown interest in lately (mention count, most to least):\n" +
        sorted.map(t => `- ${t.topic} (${t.count})`).join("\n"));
    }

    return parts.join("\n\n");
  } catch (e) {
    console.error("Knowledge fetch failed:", e);
    return "";
  }
}

async function fetchShareableConnections(excludeSessionId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Conversations");
  const headers = { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` };
  try {
    const formula = encodeURIComponent("{shareable}=1");
    const r = await fetch(`https://api.airtable.com/v0/${base}/${table}?pageSize=100&filterByFormula=${formula}`, { headers });
    if (!r.ok) return "";
    const data = await r.json();
    const rows = (data.records || [])
      .map(rec => rec.fields)
      .filter(f => f.session_id !== excludeSessionId && f.email && (f.land_or_place || f.needs || f.offers || f.role_or_work));
    if (!rows.length) return "";
    return rows.map(f => {
      const bits = [f.name, f.role_or_work, f.land_or_place, f.needs, f.offers].filter(Boolean).join(" — ");
      return `- ${bits} (reachable at ${f.email})`;
    }).join("\n");
  } catch (e) {
    console.error("Shareable connections fetch failed:", e);
    return "";
  }
}

async function callClaude(messages, systemPrompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1500,
      system: systemPrompt,
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
    const [knowledgeBlock, connectionsBlock] = await Promise.all([
      fetchKnowledge(),
      fetchShareableConnections(sessionId),
    ]);

    let systemPrompt = SYSTEM_PROMPT;
    if (knowledgeBlock) {
      systemPrompt += `\n\nHere's what's already known from past conversations and from the people running this project — weave it in naturally where it's actually relevant, don't recite it as a list:\n${knowledgeBlock}`;
    }
    if (connectionsBlock) {
      systemPrompt += `\n\nThese people have explicitly agreed to be connected with others working on similar things — if what someone's telling you genuinely overlaps with one of them, actually share the connection (their relevant context and how to reach them), the way a real introduction would work. Don't force it if nothing overlaps, and don't share anyone not listed here:\n${connectionsBlock}`;
    }

    let convo = [...messages];
    let finalText = "";
    let ended = false;

    // Loop to handle tool-use turns: Claude may call a tool and stop before
    // producing conversational text — if so, we feed back tool_results and
    // ask again. Raised from 4 to 8 — a rich message can genuinely need
    // several tool calls (log_contact, save_knowledge, a search) before she
    // actually replies, and running out mid-loop should never look like a
    // hard failure.
    for (let i = 0; i < 8; i++) {
      const data = await callClaude(convo, systemPrompt);
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
        } else if (t.name === "save_knowledge") {
          try { await saveKnowledge(t.input); }
          catch (e) { console.error("Knowledge save failed:", e); }
        } else if (t.name === "end_conversation") {
          ended = true;
        }
      }

      convo.push({ role: "assistant", content });

      // Stop the instant she's decided to close — otherwise the loop goes
      // back for another round (since a tool was used) and she sometimes
      // generates a second, redundant closing line, which then gets
      // concatenated onto the first. Her goodbye already happened; don't
      // give her another chance to say it again.
      if (ended) break;

      // Only client-side tools (log_contact, save_knowledge, end_conversation)
      // need a manufactured tool_result — web_search resolves server-side.
      // If stop_reason is tool_use but toolUses is empty (a pure server-side
      // tool), pushing an empty content array here is invalid and Anthropic
      // rejects the request — so only continue this way if there's actually
      // something to reply with.
      if (data.stop_reason === "tool_use" && toolUses.length > 0) {
        convo.push({
          role: "user",
          content: toolUses.map(t => ({ type: "tool_result", tool_use_id: t.id, content: "ok" })),
        });
        continue;
      }
      if (data.stop_reason === "tool_use" && toolUses.length === 0) {
        // Server-side-only tool turn (e.g. just a search) — nothing for us
        // to supply, let the loop run again on the same convo so she can
        // continue from where the search left off.
        continue;
      }
      break;
    }

    // Defensive fallback: if we somehow still have no text (ran out of
    // iterations mid-tool-use, or a genuinely empty reply), never send an
    // empty string back — the frontend treats that as a hard failure.
    if (!finalText.trim()) {
      finalText = "I'm still thinking that through — could you give me just a moment and try sending that again?";
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
