// Vercel serverless function — receives "report an issue" submissions from
// the landing page. Saves the report (plus recent conversation context, if
// any) to Airtable, and emails an immediate alert via Resend — same
// alerting path as navi-chat.js's error notifications.
//
// Additional required environment variable beyond what navi-chat.js needs:
//   AIRTABLE_REPORTS_TABLE_NAME — a new table (name or ID), fields:
//     report_text, context, session_id, reported_at
// Reuses AIRTABLE_TOKEN, AIRTABLE_BASE_ID, RESEND_API_KEY, NOTIFY_EMAIL,
// FROM_EMAIL from navi-chat.js's existing setup.

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
    console.error("Failed to send report alert email:", e);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { message, context, sessionId } = req.body || {};
  if (!message || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "Missing report message" });
    return;
  }

  const text = message.trim();
  const reportedAt = new Date().toISOString();

  // Save to Airtable — best-effort. Still send the email alert even if this
  // fails, since the alert is the part that actually reaches a person.
  try {
    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_REPORTS_TABLE_NAME || "Bug Reports");
    await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        records: [{ fields: {
          report_text: text,
          context: (context || "").slice(0, 5000),
          session_id: sessionId || "",
          reported_at: reportedAt,
        } }],
        typecast: true,
      }),
    });
  } catch (e) {
    console.error("Failed to save bug report to Airtable:", e);
  }

  await sendAlertEmail(
    "Navi: someone reported an issue",
    `<p><b>Report:</b></p><pre style="white-space:pre-wrap;font-family:monospace;font-size:13px">${escapeHtml(text)}</pre>` +
    (context ? `<p><b>Recent conversation:</b></p><pre style="white-space:pre-wrap;font-family:monospace;font-size:12px;color:#555">${escapeHtml(String(context).slice(0,3000))}</pre>` : "<p style=\"color:#888\">(no conversation happened yet when this was reported)</p>") +
    `<p style="color:#888;font-size:12px">Session: ${escapeHtml(sessionId || "unknown")} · ${reportedAt}</p>`
  );

  res.status(200).json({ ok: true });
};
