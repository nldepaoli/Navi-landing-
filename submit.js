// Vercel serverless function — receives submissions from the landing page,
// writes them to Airtable (so they're queryable and can later feed a map),
// and sends two emails via Resend: an acknowledgment to the submitter and
// a notification to you.
//
// Required environment variables (set in Vercel → Settings → Environment
// Variables — never in the frontend code):
//   AIRTABLE_TOKEN     — Airtable Personal Access Token
//   AIRTABLE_BASE_ID   — the base ID (starts with "app...")
//   RESEND_API_KEY     — Resend API key
//   NOTIFY_EMAIL       — your inbox, e.g. subcanopyplanning@gmail.com
//   FROM_EMAIL         — verified sending address, e.g. navi@slocommons.org
//     (until you verify a domain in Resend, use onboarding@resend.dev —
//      it works immediately but is best for testing, not high volume)

const TABLES = {
  tree_report: "Tree Reports",
  network_registration: "Network Inquiries",
  waitlist: "Waitlist",
};

const ACK_SUBJECT = {
  tree_report: "We received your tree report",
  network_registration: "Thanks for your interest in the Commons network",
  waitlist: "You're on the list",
};

const ACK_BODY = {
  tree_report: (d) =>
    `<p>Thank you for telling us about a tree worth knowing${d.location ? ` at ${escapeHtml(d.location)}` : ""}.</p>
     <p>We've logged it and will follow up as the heritage tree registration process moves forward.</p>
     <p>— Navi / SLO Commons</p>`,
  network_registration: (d) =>
    `<p>Thanks for your interest in joining the Commons network${d.name ? `, ${escapeHtml(d.name)}` : ""}.</p>
     <p>This is an early expression of interest — we'll be in touch as the directory develops.</p>
     <p>— Navi / SLO Commons</p>`,
  waitlist: () =>
    `<p>You're on the list. We'll let you know as soon as there's more to see.</p>
     <p>— Navi / SLO Commons</p>`,
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function sendEmail({ to, subject, html }) {
  const from = process.env.FROM_EMAIL || "onboarding@resend.dev";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("Resend send failed:", res.status, text);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body || {};
  const { type } = body;
  const tableName = TABLES[type];
  if (!tableName) {
    res.status(400).json({ error: "Unknown submission type" });
    return;
  }

  // Build Airtable fields from whatever came in (minus our own routing field).
  const fields = { ...body };
  delete fields.type;
  fields["Submitted At"] = new Date().toISOString();

  try {
    const airtableRes = await fetch(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records: [{ fields }] }),
      }
    );

    if (!airtableRes.ok) {
      const text = await airtableRes.text().catch(() => "");
      console.error("Airtable write failed:", airtableRes.status, text);
      res.status(502).json({ error: "Failed to save submission" });
      return;
    }

    // Fire both emails — don't let a failure here block the success response
    // the frontend already got its animation from; log instead.
    const emailTasks = [];
    if (body.email) {
      emailTasks.push(
        sendEmail({
          to: body.email,
          subject: ACK_SUBJECT[type] || "Thanks — we got it",
          html: (ACK_BODY[type] || (() => "<p>Thank you.</p>"))(body),
        })
      );
    }
    if (process.env.NOTIFY_EMAIL) {
      const summary = Object.entries(fields)
        .map(([k, v]) => `<b>${escapeHtml(k)}:</b> ${escapeHtml(v)}`)
        .join("<br>");
      emailTasks.push(
        sendEmail({
          to: process.env.NOTIFY_EMAIL,
          subject: `New ${tableName} submission`,
          html: summary,
        })
      );
    }
    await Promise.allSettled(emailTasks);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Submission handler error:", err);
    res.status(500).json({ error: "Internal error" });
  }
}
