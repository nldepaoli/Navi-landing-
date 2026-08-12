// Vercel serverless function — receives a follow-up email left specifically
// at the conversation-length-cap moment. Deliberately bypasses Claude
// entirely (no extra API cost at exactly the point the cap exists to
// guard against runaway cost) — just saves the email onto the same
// Conversations record this session already has (or creates one), and
// alerts immediately since this is a person who was engaged enough to hit
// the cap and still wanted to leave a way to be reached.
//
// Reuses the same Airtable/Resend env vars as navi-chat.js and
// report-issue.js — no new environment variables needed.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function sendAlertEmail(subject, html) {
  if (!process.env.RESEND_API_KEY || !process.env.NOTIFY_EMAIL) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL || "onboarding@resend.dev",
        to: process.env.NOTIFY_EMAIL,
        subject,
        html,
      }),
    });
  } catch (e) {
    console.error("Failed to send follow-up email alert:", e);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { sessionId, email } = req.body || {};
  const trimmedEmail = typeof email === "string" ? email.trim() : "";
  if (!sessionId || !trimmedEmail || !trimmedEmail.includes("@")) {
    res.status(400).json({ error: "Missing sessionId or a valid email" });
    return;
  }

  try {
    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Conversations");
    const headers = {
      Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
    };

    const formula = encodeURIComponent(`{session_id}="${sessionId}"`);
    const searchRes = await fetch(`https://api.airtable.com/v0/${base}/${table}?filterByFormula=${formula}&maxRecords=1`, { headers });
    const searchData = await searchRes.json();
    const existing = searchData.records && searchData.records[0];

    const payloadFields = { email: trimmedEmail, session_id: sessionId, last_updated: new Date().toISOString() };

    if (existing) {
      await fetch(`https://api.airtable.com/v0/${base}/${table}/${existing.id}`, {
        method: "PATCH", headers, body: JSON.stringify({ fields: payloadFields, typecast: true }),
      });
    } else {
      await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
        method: "POST", headers, body: JSON.stringify({ records: [{ fields: payloadFields }], typecast: true }),
      });
    }
  } catch (e) {
    console.error("Failed to save follow-up email to Airtable:", e);
    await sendAlertEmail(
      "Follow-up email failed to save — add by hand",
      `<p>Someone left a follow-up email at the conversation cap, but it didn't save to Airtable.</p><p><b>Email:</b> ${escapeHtml(trimmedEmail)}</p><p><b>Session:</b> ${escapeHtml(sessionId)}</p>`
    );
    res.status(200).json({ ok: true }); // still a success from the visitor's side — don't show them an error for our own save failure
    return;
  }

  await sendAlertEmail(
    "Someone left a follow-up email after hitting the conversation cap",
    `<p>They were engaged enough to hit the length cap and still wanted to leave a way to be reached — a real, warm lead worth a look.</p><p><b>Email:</b> ${escapeHtml(trimmedEmail)}</p><p><b>Session:</b> ${escapeHtml(sessionId)}</p>`
  );

  res.status(200).json({ ok: true });
};
