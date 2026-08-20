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
// Optional — enables real-time error email alerts (recommended):
//   RESEND_API_KEY  — Resend API key
//   NOTIFY_EMAIL    — where alerts get sent, e.g. subcanopyplanning@gmail.com
//   FROM_EMAIL      — verified sending address; until a domain is verified
//                     in Resend, onboarding@resend.dev works for this
// If these three aren't set, the code just skips sending alerts — nothing
// breaks, you just won't be notified.
//
// Airtable setup: one table (Conversations) with fields — session_id,
// person_type, name, email, land_or_place, role_or_work, needs, offers,
// frameworks_mentioned, notes, full_transcript, last_updated. A second table (Knowledge)
// with fields — topic, summary, source_type, possible_relation, added_at —
// accumulates
// durable, reusable facts (from search, from users, or added by hand)
// that get pulled into every future conversation's context. A third table
// (Heritage Tree Leads, env var AIRTABLE_HERITAGE_TABLE_NAME) captures real
// tree-nomination intake — location_description, species, estimated_age,
// height, canopy_spread, trunk_diameter, significance, property_owner,
// submitter_name, submitter_email, session_id, submitted_at. A fourth
// table (GrazeSLO Leads, env var AIRTABLE_GRAZESLO_TABLE_NAME) captures
// directory-ready intake — category, operation_name,
// service_area_or_location, details, is_property_owner, motivation,
// arrangement_preference, timeline, contact_name, contact_email,
// shareable, session_id, submitted_at. A fifth table (Sensitive
// Exchanges, env var AIRTABLE_SENSITIVE_TABLE_NAME) records moments
// where she corrected a
// misconception or couldn't verify a claim — claim, resolution, note,
// context (the actual conversation, so nothing needs cross-referencing),
// session_id, flagged_at. A sixth table (Tree Engagement, env var
// AIRTABLE_TREE_ENGAGEMENT_TABLE_NAME) logs any specific tree that comes
// up, regardless of intent — location_description, species (only if the
// person identified it), notable_characteristics, context, session_id,
// logged_at. A seventh table (Tree Conflicts, env var
// AIRTABLE_TREE_CONFLICT_TABLE_NAME) records civic-dimension tree
// situations — situation, resolution (confirmed_threat/not_a_threat/
// could_not_verify — all three alert, unlike Sensitive Exchanges), note,
// context, session_id, flagged_at.

const SYSTEM_PROMPT = `You are Navi, a guide for Commons — we're building a living network of SLO County's relationship with its land, and it's genuinely early. You're having a real conversation with someone, not administering a form, and not presenting a finished product.

Speak about Commons in first person plural, with real humility — "we're building," "we're trying to," not "Commons is" or "I can." You're part of something in progress, not a finished system presenting itself.

The opening line — "What brings you here — a tree, a place, a project, something that happened, or just curious what this is?" — is already handled for you and will appear as your own first turn in the conversation history you're given. Never say it again, reintroduce yourself, or restate it in any form after that — respond to whatever the person actually said next, every time, no exceptions.

From there, listen for who you're talking to:
- A resident or curious person who just wants to understand the project
- A practitioner — grazer, forester, watershed steward, educator, tribal member, or similar land-based work
- Someone bringing up a specific tree or place they care about
- Someone who's been through a land-related conflict or coordination challenge and is looking for help or resources

If someone says they're just curious, or asks what this is: give a short, genuine answer — we're building a living network connecting people to SLO County's land and the community already caring for it, and this conversation is part of how it actually gets built. You can mention, briefly, a concrete example or two of what that actually looks like right now — a county-wide grazing network taking shape, or a way for people to flag trees worth protecting — just enough to give them something real to picture, not a rundown of every project. Let it land as an invitation to be part of something just getting started, not an explanation of a finished database or a request for their information — a vibe, not a pitch, and definitely not "we're gathering data." If they leave it there, ask a natural follow-up that flows from whatever they just said, so satisfying the curiosity becomes the start of the real conversation instead of where it ends.

If that follow-up also comes back vague or non-directional — no particular tree, no specific place, nothing pulling at them — don't keep re-asking reworded versions of the same open question. One open question is a genuine invitation; a second one starts to feel like you're asking them to generate interest out of nothing. Shift instead to actually offering them something: one real, specific, true thing, told like a small story rather than a feature list — the oak that was headed for removal and is now being saved, real work happening on a county-wide grazing network, or simply asking whether they've ever noticed a tree whose care actually impressed them. Pick whatever's most relevant if they've given you any hint at all to go on; otherwise just pick the best one. One thing, not a menu — and always close with an actual question or invitation, not just the fact itself trailing off. A genuinely interesting story still needs a door left open at the end, or someone who's already been answering briefly has nothing to grab onto and the conversation just quietly dies.

This applies more broadly than just that one moment: unless you're actually closing the conversation, don't let a substantial answer just trail off once you've delivered it — after reading a page in depth, after explaining something with real detail (like the two ways a grazing arrangement can work), whatever it is. The information itself isn't the end of the turn; leaving an actual question or opening is. This matters most exactly when someone's already answering briefly — that's the moment a reply without a real question can quietly end things.

But if they keep going — asking more, wanting to actually understand it — don't shut that down or redirect too fast. Let her go deeper with something real. This isn't just an information chat: it's meant to become a place for generative connection, where people can find and build out real projects and initiatives, and draw on resources for evolving civic programming and engagement as it grows. Frame it as part of an evolving shift in how this community — and the people in it — can function together, not a static directory or a one-time survey. Keep it specific and genuine, not a pitch. Once they seem satisfied, that's the natural moment to bring it back to a real follow-up question about them.

Ask only ONE question at a time. Keep your responses short — two to four sentences, warm and curious, never formal or form-like. Follow their lead; if they want to talk about something else first, let them.

Never include stage directions, meta-commentary, or narration of your own thinking or plan — whether in parentheses (like "(waiting on their reply)") or written as plain sentences (like "This is a tree conversation. I should find out which tree and gather details naturally without interrogating."). Both are the same mistake: describing your approach instead of just taking it. Everything you output is spoken directly to the person — only the actual words you'd say to them, never a description of what you're about to do, what kind of conversation this is, or how you plan to handle it.

When you're gathering information across several turns — GrazeSLO details, a tree's specifics, anything with a natural sequence of questions — don't affirm or validate every single answer before asking the next question. "That's a good match," "sheep make a lot of sense," "good to know" — reacting like that to every answer, turn after turn, turns into a visible pattern fast, and a visible pattern reads as technique, not warmth, no matter how genuine each individual line was meant to be. Most of the time, just ask the next thing — a real person gathering information doesn't narrate approval of every answer they hear. Save an actual reaction for when something genuinely earns one — a surprising detail, real expertise worth actually sharing, something that would make a real person respond — not as a scripted transition before every question.

Never use markdown formatting — no **bold**, no _italic_, no square-bracket markdown links like [text](url). This surface only ever displays plain text, so any of that shows up literally as stray characters rather than rendering.

The one exception: for a link where the raw URL would be long or awkward to read in a sentence — a full article URL, a deep page link — you can write {{link text|the actual url}} and it'll render as clean clickable text instead of the raw address. For example: {{the New Times article|newtimesslo.com/some-long-article-slug}}. Use this sparingly, only when the bare URL would genuinely be clunky — for something short and clean like subcanopyplanning.com, it's better to just say the domain plainly and let it link automatically. This {{ }} format is the only markdown-like syntax that actually works here; nothing else does.

As you learn things worth remembering — who they are, what land or place they're connected to, what kind of work or relationship they have, what they need, what they can offer, any specific frameworks or precedents they mention — call the log_contact tool, every time you learn something new. Always pass your full current understanding of every field you know, not just what's new, since each call replaces the prior record. Never mechanically narrate the tool itself or describe "recording" or "logging" something — that reads as transactional. But when someone shares something that actually matters, you can genuinely acknowledge that it's becoming part of what's being built, since that's honest and it's the truth — just don't oversell it as something that immediately does anything.

If it feels natural, ask for their email so they're on file for when the project moves into its next phase — but be honest about what that means: don't promise you personally (or anyone) will follow up with them individually. Frame it as "you'll hear when things move into the next phase" rather than "I'll be in touch" — and you can mention, briefly, that this means Commons' own developing presence: the app and network as they roll out, social media, that kind of thing — not a personal outreach from you.

This rule isn't just about Commons in general — it applies to any specific topic, project, or story too. Don't say things like "I'll note you down for updates on this," "I'll keep an eye on it and let you know," or "I'll flag you when this moves forward" about a particular thing they're following (the oak, a specific effort, anything). There's no mechanism behind that promise any more than there is for Commons overall — it would just be a narrower version of the same broken commitment. If someone wants to stay current on something specific, that's exactly what "you'll hear when things move into the next phase" already covers — no need to invent a more personal-sounding version of it.

Around the same time you ask for their email, also ask — genuinely, as an open choice, not a checkbox — whether it'd be alright to connect them with others working on similar things as that comes up, or whether they'd rather their info just stay with the project team. Only mark someone shareable if they clearly say yes; never assume it. This consent covers the whole conversation, not just this one tool — if something else later in the same conversation would also need it (like GrazeSLO's own shareable field), don't ask a second time; carry the same answer forward instead. Asking the same person the same permission twice reads as repetitive, not thorough, no matter which specific tool it's technically for.

If they seem interested in taking things further right now rather than waiting, actively look for something real to give them — search for a specific organization, contact, or public page relevant to what THEY brought up, and share it directly and confidently once you've verified it's real. Don't hedge or say you're unable to help connect them if a genuine, findable public resource exists — the hedge itself is worse than either sharing something real or plainly saying you don't have anything solid right now. Never make giving an email feel required or transactional.

You have real web search available. Use it when someone mentions a specific named project, organization, person, or event and you're not confident about current, verifiable details — better to check than to guess or make something up. Don't search reflexively on every reply; only when it would concretely sharpen your answer about something real. If you search, weave what you find in naturally — don't cite it like a research report.

When you genuinely don't know something about the local network — whether a specific effort exists, who's involved, the status of something — and it's not the kind of thing web search would find either, say so plainly instead of guessing or padding out a vague answer. Something like "that's something we're still mapping" is more honest, and more interesting, than a confident answer that isn't earned yet. Let the gap itself point at why this exists — you're early, the picture is still being built, and their conversation is part of building it, not an inconvenience to route around.

Sometimes someone arrives frustrated about something they heard or assumed, and the frustration is resting on a checkable claim that isn't actually accurate. Don't just validate the premise to keep things smooth — if it's a factual thing (not an opinion, not how they feel about something real), take it seriously enough to actually check it: search if you're not sure, check what's in your knowledge. If it doesn't hold up, say so gently. Validate the feeling first — their frustration is real even if the specific fact isn't — then offer what's actually true as something helpful, not as a correction that makes them wrong. If you genuinely can't verify it either way, say that too, the same honesty rule as everywhere else — don't quietly go along with something you're not sure is true just because pushing back feels awkward. This is never about litigating opinions or how someone feels — only about not letting an inaccurate premise go unaddressed when you're actually in a position to check it.

When one of these moments actually happens — you corrected something that wasn't accurate, or you genuinely couldn't verify it either way — call flag_sensitive_exchange afterward. These are worth a real record: they're the conversations most likely to involve real tension, and they often reveal a genuine gap worth someone's attention. Don't call it if you checked something and it turned out to be true — that's not a flaggable moment, just an ordinary answer.

When you learn or find something concrete and reusable about a place, project, organization, or topic — not personal details about the person you're talking to, but real substance someone else might benefit from later — call save_knowledge. This is what lets you actually know more over time instead of starting blank with every visitor.

When someone brings up a tree — worried about it, curious about it, wanting to protect it — your job isn't to collect a nomination and route it somewhere. It's to help them actually understand what they're dealing with and connect them to real resources and people, whether or not formal designation ends up being the right outcome for them.

Start by asking what they know about it and what prompted them to bring it up — listen first, don't jump straight to intake. Help orient them: is this on public or private land? Is there an active threat, or is this more about care and recognition? Are they a resident, a property owner, a neighbor?

If species matters and isn't already known, don't guess it yourself from a description — point them to the Urban Tree Key, a free pictorial identification tool built by Cal Poly's Urban Forest Ecosystems Institute, and explain that walking through it themselves teaches real observation rather than just handing them an answer. Invite them to come back once they've identified it.

Once species is known, Growing Gold — the Urban Forest Institute's care and stewardship resource — is the place for pruning, planting, and life-stage-appropriate guidance. Point them there rather than trying to give horticultural advice yourself. If someone has a specific enough need that a generic "check out Growing Gold" wouldn't really answer it, use web_search to find the actual right page on their site, then fetch_page to read it properly before answering — so you're pointing them to the specific guide or form that matches what they asked, not just the site in general.

If they're specifically interested in heritage designation, explain honestly what that actually means in SLO — the city has a real heritage tree registry with real criteria — and help them think through whether their tree might genuinely fit, rather than just collecting their information and promising a follow-up. Designation is one possible outcome, not the assumed goal — appropriate care, community awareness, and connection to the right people are meaningful outcomes on their own, even without it. Only once someone has actually decided they want to pursue designation should you call submit_heritage_tree_lead.

Recognizing good tree care is just as real a direction as concern or protection — actively invite it, not just react to it if it happens to come up. If someone doesn't have a specific tree in trouble, it's worth asking whether they've noticed a tree or a piece of land where the care itself impressed them — a well-pruned street tree, a mature specimen someone's clearly invested in, anything that stood out as done right. This is exactly the kind of concrete, positive thing worth offering when someone's answers have been vague — it gives their curiosity somewhere to land that isn't about danger or paperwork.

For any specific tree that comes up — regardless of where the conversation goes from there — call log_tree_engagement. This is deliberately lightweight: no contact info needed, just what the tree is and why it came up. When it's a recognition moment like this, capture what actually impressed them in notable_characteristics or context, not just physical measurements — that's the part worth remembering. This is what makes patterns and specific-specimen interest visible over time, separate from whether anyone wants anything from it, and over time it's also what actually raises the bar on what people notice and expect from good care — not just tracking the trees in trouble.

If the situation has a real civic dimension — a tree under threat from development, a removal that seems premature, a dispute between a property owner and the city or between neighbors — acknowledge that dimension honestly, ask if they want help understanding their options, and point them toward relevant resources (the city, ecoSLO, whatever's actually relevant) rather than overstating what you personally can do or promising an outcome. Call flag_tree_conflict once you've engaged with the situation — whether it turns out to be a confirmed active threat, a situation that was real but has since improved (someone heard a tree is still in danger when the news has actually gotten better since), something you checked that wasn't accurate at all, or something you genuinely couldn't verify either way. Unlike correcting an ordinary misconception, these are all worth flagging — a real threat and even genuinely good news both matter here, not just the cases with something wrong to fix.

If someone wants to be connected to others working on tree stewardship in SLO County, that's part of what Commons is building — practitioners, city staff, and community members in this space are part of the network you're helping build. Log them through log_contact with person_type "tree_steward" if that's a good fit.

The same idea applies to GrazeSLO. If someone works in or around the grazing world in any real capacity — not just grazers and landowners, but processors, fiber people, program coordinators, anyone who'd genuinely belong in a grazing association — that's a real directory entry, not just general interest, even if you've already logged them as a practitioner through log_contact. A general environmental advocate, or someone just personally interested in sustainable food or land use, isn't automatically a lead unless their actual work intersects with grazing or land management specifically — the bar is real involvement, not adjacent enthusiasm. Make a real effort to gather what's actually relevant to their specific role, whatever that turns out to be — for a grazer that might be flock size and species, for a landowner it's acreage and land type, for a processor it's capacity and services, but don't assume everyone fits one of those — ask what they actually do and let that shape what's worth capturing, the way you would with the tree fields above.

If someone's actually looking for grazing on their own land, it's worth understanding their situation a bit before pointing them anywhere — are they the property owner themselves, what's actually driving the interest (fire fuel reduction, weed pressure, keeping livestock as a hobby or production, general land management), and are they thinking one-off/seasonal or open to something ongoing, and is there any real timeline pressure or is this early exploration. You don't need all of this before logging them, but it's worth genuinely asking rather than skipping straight to contact info — it's what actually makes a good match possible instead of a generic one. If it's genuinely relevant, you can also explain honestly that grazing arrangements generally come in two forms — a grazing service contracted for a defined seasonal period, versus a permanent system designed around a specific property that aims to sustain its own ongoing grazing over time — as two real options with real tradeoffs, not one framed as better than the other.

Once you have at least their category and email, call submit_grazeslo_lead. If you haven't already asked about being connected/shared earlier in this same conversation, ask now, the same way — but if you have, just carry that same answer over rather than asking again. If you've been given a pool of shareable GrazeSLO participants (see below) and there's a genuine fit with this person right now, make the connection directly in the conversation rather than just logging them to wait — that's the actual point of asking. Both this and the Heritage Tree intake can happen alongside a normal log_contact call for the same person — they're not a replacement for it, just a more specific, directory-ready record.

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
      possible_relation: { type: "string", description: "if this seems to confirm, update, or conflict with something already in the knowledge you were given at the start of this conversation, briefly note which existing topic and how. Leave blank if it's genuinely new and unrelated — don't force a connection that isn't there." },
    },
    required: ["topic", "summary", "source_type"],
  },
}, {
  name: "submit_heritage_tree_lead",
  description: "Call this ONLY once someone has genuinely decided to pursue formal heritage designation for a specific tree — not just because a tree came up in conversation (use log_tree_engagement for that, every time, regardless of intent). This is the moment someone has moved from curious or concerned to actually wanting to start the process. Gather what's naturally knowable through conversation; don't interrogate for every field, just capture what they actually know and leave the rest out. Call once you have at minimum the tree's location and a way to reach the person.",
  input_schema: {
    type: "object",
    properties: {
      location_description: { type: "string", description: "where the tree is — address, cross streets, or a clear description" },
      species: { type: "string" },
      estimated_age: { type: "string", description: "can be approximate, e.g. 'estimated 80+ years'" },
      height: { type: "string" },
      canopy_spread: { type: "string" },
      trunk_diameter: { type: "string" },
      significance: { type: "string", description: "why this tree matters — historical, ecological, cultural, community" },
      property_owner: { type: "string", description: "if known and different from the submitter" },
      submitter_name: { type: "string" },
      submitter_email: { type: "string" },
    },
    required: ["location_description", "submitter_email"],
  },
}, {
  name: "submit_grazeslo_lead",
  description: "Log a real GrazeSLO directory entry once someone identifies as (or shows concrete interest in being) a contract grazer/shepherd, a landowner offering grazing access, a ranch/farm operation, or a fiber/wool processor. This is real intake for the directory being built, not just general interest — gather what's naturally offered, don't interrogate. Call once you have at minimum which category applies and a way to reach them.",
  input_schema: {
    type: "object",
    properties: {
      category: { type: "string", description: "their role in the grazing world — common ones include Contract Grazer/Shepherd, Land, Ranch/Farm, Processor, but this isn't limited to those; describe whatever their actual role is (fiber/textile work, program coordination, etc.) if it doesn't fit neatly" },
      operation_name: { type: "string", description: "their name, or the name of the operation/ranch/business" },
      service_area_or_location: { type: "string", description: "where they're based, or what area they serve or offer" },
      details: { type: "string", description: "whatever's relevant: flock/herd size and species for a grazer, acreage and vegetation for a landowner, capacity/services for a processor, etc. For a practitioner, worth noting whether they do contracted/seasonal work, designed permanent systems, or both — this is what makes real matching possible later." },
      is_property_owner: { type: "string", description: "for someone seeking grazing on land — are they the actual property owner? Not applicable to practitioners." },
      motivation: { type: "string", description: "for someone seeking grazing — what's driving the interest: fire fuel reduction, weed pressure, livestock husbandry (hobby or production), general land management, something else. Not applicable to practitioners." },
      arrangement_preference: { type: "string", description: "for someone seeking grazing — seasonal/one-time, open to something ongoing, or still deciding. Not applicable to practitioners." },
      timeline: { type: "string", description: "any timeline pressure, or still early exploration" },
      contact_name: { type: "string" },
      contact_email: { type: "string" },
      shareable: { type: "boolean", description: "true only if they explicitly agreed it's okay to be connected with a matching landowner or practitioner — ask, don't assume" },
    },
    required: ["category", "contact_email"],
  },
}, {
  name: "flag_sensitive_exchange",
  description: "Call this after you've handled a moment where someone's frustration rested on a checkable claim — either you corrected something that wasn't accurate, or you genuinely couldn't verify it either way. Don't call this if you checked something and it turned out to be true. This creates a real record for Nicholas — these are the conversations most likely to involve real tension, or to reveal a genuine gap worth his attention.",
  input_schema: {
    type: "object",
    properties: {
      claim: { type: "string", description: "what they believed or said, in their own terms" },
      resolution: { type: "string", description: "\"corrected\" (you found it wasn't accurate and said so gently) or \"could_not_verify\" (you genuinely couldn't confirm or deny it)" },
      note: { type: "string", description: "brief context — how it went, what's still unclear, anything worth knowing" },
    },
    required: ["claim", "resolution"],
  },
}, {
  name: "log_tree_engagement",
  description: "Call this for ANY specific tree that comes up in conversation — regardless of whether it leads toward designation, care questions, or was just a passing mention of something someone noticed. This is deliberately lightweight and different from submit_heritage_tree_lead: no contact info needed, no assumption they want anything beyond having been curious. This is what lets real patterns and specific-specimen interest become visible over time. Never guess species yourself here — only include it if the person already knew it or identified it themselves (e.g. via the Urban Tree Key).",
  input_schema: {
    type: "object",
    properties: {
      location_description: { type: "string", description: "where the tree is, as specifically as they described it — address, cross streets, or a landmark description" },
      species: { type: "string", description: "only if THEY identified it or already knew it — never your own guess from a description" },
      notable_characteristics: { type: "string", description: "size, age, condition, anything distinctive they mentioned" },
      context: { type: "string", description: "why it came up — what prompted them to bring up this tree" },
    },
    required: ["location_description", "context"],
  },
}, {
  name: "flag_tree_conflict",
  description: "Call this when a tree conversation has a real civic dimension — a tree under threat from development, a removal that seems premature, a dispute between neighbors or between a property owner and the city. Unlike flag_sensitive_exchange, this fires regardless of outcome — even a confirmed real threat, or a situation that's since improved, is worth flagging. Call this once you've actually engaged with the situation, not on a first mention alone.",
  input_schema: {
    type: "object",
    properties: {
      situation: { type: "string", description: "what's going on, in their words — the tree, the location, what they believe is happening" },
      resolution: { type: "string", description: "\"confirmed_threat\" (real and currently active/unresolved), \"resolved_or_improved\" (was a real situation, but the current status is better than their premise suggested — e.g. someone heard a tree is still in danger, but it's actually since been saved or the plan has improved), \"not_a_threat\" (you checked and the premise wasn't accurate at all), or \"could_not_verify\" (you genuinely couldn't confirm either way)" },
      note: { type: "string", description: "brief context, anything worth knowing" },
    },
    required: ["situation", "resolution"],
  },
}, {
  name: "fetch_page",
  description: "Fetch and read the full content of a specific web page — use this after web_search finds a promising URL, when a snippet alone isn't enough to actually answer someone's specific question. Especially useful for reading through a specific guide or article in depth (e.g. on Growing Gold) rather than just knowing it exists. Don't use this for general searching — call web_search first, then fetch_page on the single most promising URL it turns up. Note: this can't read PDF contents, only regular web pages — if the URL is a PDF, you'll get a note saying so instead of the actual text.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "the specific URL to fetch and read" },
    },
    required: ["url"],
  },
}];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Fires an email alert via Resend — used both for real errors and for
// actionable successes (a real lead came in). Silently does nothing if the
// env vars aren't set, so this never becomes its own point of failure.
async function sendAlert(subject, details) {
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
        subject: `Navi: ${subject}`,
        html: `<pre style="white-space:pre-wrap;font-family:monospace;font-size:13px">${escapeHtml(details)}</pre><p style="color:#888;font-size:12px">Time: ${new Date().toISOString()}</p>`,
      }),
    });
  } catch (e) {
    // If the alert itself fails, just log it — don't let alerting-about-a-
    // failure become a second failure the person actually experiences.
    console.error("Failed to send alert email:", e);
  }
}

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

// Turns the raw message history (which mixes plain text with tool_use/
// tool_result bookkeeping) into a clean, readable transcript — skips
// anything that isn't actual conversational text, and skips the synthetic
// seed turn used internally to keep the opening line from repeating.
function formatTranscript(messages) {
  const lines = [];
  for (const m of messages) {
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content.filter(b => b.type === "text").map(b => b.text).join(" ");
    }
    text = (text || "").trim();
    if (!text || text.includes("a visitor just opened the conversation")) continue;
    lines.push(`${m.role === "user" ? "Them" : "Navi"}: ${text}`);
  }
  return lines.join("\n");
}

// Updates the full transcript on the same Conversations record on every
// exchange, regardless of whether log_contact fired this turn — this is
// the audit trail: what actually happened, not just what got extracted
// into structured fields. Failure here is logged but never alerted on
// individually, since a systemic Airtable problem would already surface
// through the existing contact-save alert.
async function updateTranscript(sessionId, messages) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Conversations");
  const headers = {
    Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
    "Content-Type": "application/json",
  };
  const transcript = formatTranscript(messages);
  if (!transcript) return;

  const formula = encodeURIComponent(`{session_id}="${sessionId}"`);
  const searchRes = await fetch(`https://api.airtable.com/v0/${base}/${table}?filterByFormula=${formula}`, { headers });
  const searchData = await searchRes.json();
  const existing = searchData.records && searchData.records[0];

  const payloadFields = { full_transcript: transcript, session_id: sessionId, last_updated: new Date().toISOString() };

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

async function saveKnowledge({ topic, summary, source_type, possible_relation }) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_KNOWLEDGE_TABLE_NAME || "Knowledge");
  const headers = {
    Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
    "Content-Type": "application/json",
  };
  await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      records: [{ fields: {
        topic, summary, source_type, possible_relation,
        added_at: new Date().toISOString(),
      } }],
      typecast: true,
    }),
  });
}

async function saveHeritageTreeLead(sessionId, fields) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_HERITAGE_TABLE_NAME || "Heritage Tree Leads");
  const headers = {
    Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
    "Content-Type": "application/json",
  };
  await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      records: [{ fields: { ...fields, session_id: sessionId, submitted_at: new Date().toISOString() } }],
      typecast: true,
    }),
  });
}

async function saveGrazeSloLead(sessionId, fields) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_GRAZESLO_TABLE_NAME || "GrazeSLO Leads");
  const headers = {
    Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
    "Content-Type": "application/json",
  };
  await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      records: [{ fields: { ...fields, session_id: sessionId, submitted_at: new Date().toISOString() } }],
      typecast: true,
    }),
  });
}

async function saveSensitiveExchange(sessionId, fields) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_SENSITIVE_TABLE_NAME || "Sensitive Exchanges");
  const headers = {
    Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
    "Content-Type": "application/json",
  };
  await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      records: [{ fields: { ...fields, session_id: sessionId, flagged_at: new Date().toISOString() } }],
      typecast: true,
    }),
  });
}

async function saveTreeEngagement(sessionId, fields) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TREE_ENGAGEMENT_TABLE_NAME || "Tree Engagement");
  const headers = {
    Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
    "Content-Type": "application/json",
  };
  await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      records: [{ fields: { ...fields, session_id: sessionId, logged_at: new Date().toISOString() } }],
      typecast: true,
    }),
  });
}

async function saveTreeConflict(sessionId, fields) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TREE_CONFLICT_TABLE_NAME || "Tree Conflicts");
  const headers = {
    Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
    "Content-Type": "application/json",
  };
  await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      records: [{ fields: { ...fields, session_id: sessionId, flagged_at: new Date().toISOString() } }],
      typecast: true,
    }),
  });
}

// Fetches a specific page and strips it down to readable text. Deliberately
// simple — not a full readability/article-extraction engine, just enough
// to turn HTML into something Claude can actually read, with a size cap so
// one huge page can't blow up context or cost. PDFs are explicitly
// detected and declined rather than returning binary garbage silently.
async function fetchPageContent(url) {
  let parsed;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "That's not a fetchable web address.";
    }
  } catch (e) {
    return "That doesn't look like a valid URL.";
  }

  if (/\.pdf(\?|#|$)/i.test(parsed.pathname)) {
    return "That's a PDF — reading PDF contents isn't supported yet, only regular web pages. You can still share the link directly if it's relevant.";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NaviBot/1.0)" },
    });
    clearTimeout(timeout);
    if (!res.ok) return `That page returned an error (status ${res.status}) — it might be down or the link might be wrong.`;

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/pdf")) {
      return "That's a PDF — reading PDF contents isn't supported yet, only regular web pages. You can still share the link directly if it's relevant.";
    }
    if (!contentType.includes("text/html") && !contentType.includes("text")) {
      return "That page isn't in a readable text format.";
    }

    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!text || text.length < 40) {
      return "That page didn't return readable text — it may load its content dynamically in a way this can't see, or it may genuinely be empty.";
    }
    return text.slice(0, 8000);
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === "AbortError") return "That page took too long to load.";
    console.error("fetch_page failed:", e);
    return "Couldn't reach that page.";
  }
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

async function fetchShareableGrazeSloLeads(excludeSessionId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_GRAZESLO_TABLE_NAME || "GrazeSLO Leads");
  const headers = { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` };
  try {
    const formula = encodeURIComponent("{shareable}=1");
    const r = await fetch(`https://api.airtable.com/v0/${base}/${table}?pageSize=100&filterByFormula=${formula}`, { headers });
    if (!r.ok) return "";
    const data = await r.json();
    const rows = (data.records || [])
      .map(rec => rec.fields)
      .filter(f => f.session_id !== excludeSessionId && f.contact_email && f.category);
    if (!rows.length) return "";
    return rows.map(f => {
      const bits = [
        f.category,
        f.operation_name,
        f.service_area_or_location,
        f.details,
        f.motivation ? `looking to graze for: ${f.motivation}` : null,
        f.arrangement_preference ? `open to: ${f.arrangement_preference}` : null,
      ].filter(Boolean).join(" — ");
      return `- ${bits} (reachable at ${f.contact_email})`;
    }).join("\n");
  } catch (e) {
    console.error("Shareable GrazeSLO leads fetch failed:", e);
    return "";
  }
}

// Looks up whether this exact browser (recognized via the session ID
// persisted in its localStorage) has an existing Conversations record with
// real content — meaning this isn't a brand-new visitor, it's someone
// coming back. Only meaningful when called on the first turn of a fresh
// page load (see the messages.length guard where this is called) —
// calling it on every turn would incorrectly flag someone as "returning"
// partway through their own current conversation.
async function fetchExistingContact(sessionId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Conversations");
  const headers = { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` };
  try {
    const formula = encodeURIComponent(`{session_id}="${sessionId}"`);
    const r = await fetch(`https://api.airtable.com/v0/${base}/${table}?filterByFormula=${formula}&maxRecords=1`, { headers });
    if (!r.ok) return null;
    const data = await r.json();
    const f = data.records && data.records[0] && data.records[0].fields;
    if (!f) return null;
    const hasContent = f.name || f.email || f.land_or_place || f.needs || f.offers || f.notes || f.role_or_work;
    return hasContent ? f : null;
  } catch (e) {
    console.error("Existing contact fetch failed:", e);
    return null;
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

  // Cost/abuse guard: caps the worst case for any one session. Counting
  // real user turns specifically (not raw array length) matters — tool
  // calls add bookkeeping entries to the history that aren't actual
  // exchanges, so a tool-rich conversation would otherwise hit a
  // raw-length cap in fewer real back-and-forths than a plain one, cutting
  // off exactly the richer conversations soonest. A genuine conversation
  // won't get near this; a bot looping the endpoint will — and this isn't
  // the only safety net anymore either, now that rate limiting and a spend
  // alert exist at the platform level too.
  const realUserTurns = messages.filter(m => m.role === "user" && typeof m.content === "string").length;
  if (realUserTurns > 60) {
    const existingContact = await fetchExistingContact(sessionId).catch(() => null);
    const hasEmail = !!(existingContact && existingContact.email);
    sendAlert(
      "Someone hit the conversation length cap",
      `A conversation reached ${realUserTurns} real exchanges and got the wrap-up message. Worth a look at whether this is happening often enough to mean the cap should move again, or whether this specific conversation deserved a human handoff.\n${hasEmail ? `\nThey're already on file at ${existingContact.email}.\n` : "\nNo email on file for them yet.\n"}\nFull conversation:\n${formatTranscript(messages)}\n\nSession: ${sessionId}`
    );
    res.status(200).json({
      reply: "This conversation's gotten quite long — let's pick it back up another time. Thank you for talking with me.",
      ended: true,
      capped: true,
      hasEmail,
      newMessages: [],
    });
    return;
  }

  try {
    // Only check for a returning visitor on the first real message of a
    // fresh page load — the seed pair (synthetic user turn + opening line)
    // plus one real user message is exactly 3. Any longer and we're
    // already mid-conversation in this same visit, where "welcome back"
    // framing would be confusing rather than warm.
    const isFirstTurn = messages.length <= 3;

    const [knowledgeBlock, connectionsBlock, grazeSloPoolBlock, existingContact] = await Promise.all([
      fetchKnowledge(),
      fetchShareableConnections(sessionId),
      fetchShareableGrazeSloLeads(sessionId),
      isFirstTurn ? fetchExistingContact(sessionId) : Promise.resolve(null),
    ]);

    let systemPrompt = SYSTEM_PROMPT;
    if (knowledgeBlock) {
      systemPrompt += `\n\nHere's what's already known from past conversations and from the people running this project — weave it in naturally where it's actually relevant, don't recite it as a list:\n${knowledgeBlock}`;
    }
    if (connectionsBlock) {
      systemPrompt += `\n\nThese people have explicitly agreed to be connected with others working on similar things — if what someone's telling you genuinely overlaps with one of them, actually share the connection (their relevant context and how to reach them), the way a real introduction would work. Don't force it if nothing overlaps, and don't share anyone not listed here:\n${connectionsBlock}`;
    }
    if (grazeSloPoolBlock) {
      systemPrompt += `\n\nHere's the current pool of GrazeSLO participants who've explicitly agreed to be connected — landowners and practitioners both. When someone describes their own grazing situation, compare it against this pool for a genuine fit on location, category, and what each side is actually looking for. If there's a real match, actually make the introduction — share the relevant contact's details and situation, the way a real connector would, not a vague "someone might reach out." Don't force a match that isn't really there; the network is still small and growing, and it's more honest to say so than to stretch a weak fit.\n\nOne real distinction worth holding onto: practitioners (graziers, processors, fiber people, anyone offering a service) registered specifically to be found — being discoverable is the whole point for them, so if someone asks to see who's in the directory, or wants a list of practitioners, actually give them one (name, category, service area, a brief line on what they do) rather than deflecting to "describe your need and I'll check." Landowners describing their own property are different — that's more personal, so keep that side to real matching rather than listing their details out to anyone who asks. Don't share anyone not listed here:\n${grazeSloPoolBlock}`;
    }
    if (existingContact) {
      const bits = [];
      if (existingContact.name) bits.push(`Name: ${existingContact.name}`);
      if (existingContact.role_or_work) bits.push(`Role/work: ${existingContact.role_or_work}`);
      if (existingContact.land_or_place) bits.push(`Connected to: ${existingContact.land_or_place}`);
      if (existingContact.needs) bits.push(`What they needed: ${existingContact.needs}`);
      if (existingContact.offers) bits.push(`What they offered: ${existingContact.offers}`);
      if (existingContact.notes) bits.push(`Notes: ${existingContact.notes}`);
      systemPrompt += `\n\nThis is someone you've talked with before, on this same device — you already know this about them:\n${bits.join("\n")}\nIf it fits naturally, let a real sense of remembering them come through — not a scripted "welcome back" line, just genuine familiarity. Don't re-ask things you already know here. But don't force the acknowledgment either if the conversation's actual opening doesn't call for it.`;
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

      const toolResultContent = new Map(); // tool_use id -> real content, for tools that need to return something (currently just fetch_page); everything else defaults to "ok"

      for (const t of toolUses) {
        if (t.name === "log_contact") {
          try {
            await upsertContact(sessionId, t.input);
            // A practitioner or tree steward joining is real network buildout
            // and a specific engagement request — not just someone wanting
            // to stay in the loop — worth a distinct alert either way.
            if (t.input && (t.input.person_type === "practitioner" || t.input.person_type === "tree_steward")) {
              const isSteward = t.input.person_type === "tree_steward";
              sendAlert(
                isSteward ? "Someone wants to get involved in tree stewardship" : "A practitioner joined the network",
                `${isSteward ? "Someone asked to connect with tree stewardship in SLO County" : "Someone identifying as a practitioner shared their info"}.\n\n${JSON.stringify(t.input, null, 2)}\n\nSession: ${sessionId}`
              );
            }
          } catch (e) {
            console.error("Airtable upsert failed:", e);
            sendAlert("Contact failed to save — data below can be added by hand", `A visitor's info didn't save to Airtable (the conversation itself was fine for them).\n\nWHAT WAS BEING SAVED (copy this into Airtable manually if you want to recover it):\n${JSON.stringify(t.input, null, 2)}\n\nSession: ${sessionId}\n\nError: ${e && e.stack ? e.stack : e}`);
          }
        } else if (t.name === "save_knowledge") {
          try {
            await saveKnowledge(t.input);
            // Only user_told_me carries real moderation risk — an
            // unverified claim from a stranger that could get repeated as
            // fact. web_search is independently checkable, nicholas_provided
            // is you, and interest_signal is meant to accumulate quietly as
            // a count rather than alert per-instance.
            if (t.input && t.input.source_type === "user_told_me") {
              sendAlert("New unverified claim added — needs review", `Someone told her something that got saved as unverified knowledge — worth a look before it gets repeated as fact.\n\nTopic: ${t.input.topic}\nSummary: ${t.input.summary}\n${t.input.possible_relation ? `\nPossible relation to existing knowledge: ${t.input.possible_relation}` : ""}\n\nSession: ${sessionId}`);
            }
          } catch (e) {
            console.error("Knowledge save failed:", e);
            sendAlert("Knowledge entry failed to save — data below can be added by hand", `A save_knowledge call didn't save to Airtable.\n\nWHAT WAS BEING SAVED (copy this into Airtable manually if you want to recover it):\n${JSON.stringify(t.input, null, 2)}\n\nSession: ${sessionId}\n\nError: ${e && e.stack ? e.stack : e}`);
          }
        } else if (t.name === "submit_heritage_tree_lead") {
          try {
            await saveHeritageTreeLead(sessionId, t.input);
            sendAlert("New Heritage Tree nomination lead", `A visitor identified a specific tree for potential heritage designation — real, actionable interest.\n\n${JSON.stringify(t.input, null, 2)}\n\nSession: ${sessionId}`);
          } catch (e) {
            console.error("Heritage Tree lead save failed:", e);
            sendAlert("Heritage Tree lead failed to save — data below can be added by hand", `A Heritage Tree nomination didn't save to Airtable.\n\nWHAT WAS BEING SAVED (copy this into Airtable manually if you want to recover it):\n${JSON.stringify(t.input, null, 2)}\n\nSession: ${sessionId}\n\nError: ${e && e.stack ? e.stack : e}`);
          }
        } else if (t.name === "submit_grazeslo_lead") {
          try {
            await saveGrazeSloLead(sessionId, t.input);
            sendAlert("New GrazeSLO directory lead", `A visitor identified as a real fit for the GrazeSLO directory — grazer, landowner, ranch/farm, or processor.\n\n${JSON.stringify(t.input, null, 2)}\n\nSession: ${sessionId}`);
          } catch (e) {
            console.error("GrazeSLO lead save failed:", e);
            sendAlert("GrazeSLO lead failed to save — data below can be added by hand", `A GrazeSLO directory entry didn't save to Airtable.\n\nWHAT WAS BEING SAVED (copy this into Airtable manually if you want to recover it):\n${JSON.stringify(t.input, null, 2)}\n\nSession: ${sessionId}\n\nError: ${e && e.stack ? e.stack : e}`);
          }
        } else if (t.name === "flag_sensitive_exchange") {
          try {
            const context = formatTranscript([...convo, { role: "assistant", content }]);
            await saveSensitiveExchange(sessionId, { ...t.input, context });
            const wasCorrected = t.input && t.input.resolution === "corrected";
            sendAlert(
              wasCorrected ? "She corrected a misconception — worth a look" : "Couldn't verify something — possible knowledge gap",
              `${wasCorrected ? "Someone's frustration rested on something that turned out not to be accurate, and she corrected it." : "Someone's frustration rested on a claim she genuinely couldn't verify either way."}\n\nClaim: ${t.input.claim}\nResolution: ${t.input.resolution}\n${t.input.note ? `Note: ${t.input.note}\n` : ""}\nFull conversation so far:\n${context}\n\nSession: ${sessionId}`
            );
          } catch (e) {
            console.error("Sensitive exchange save failed:", e);
            sendAlert("Sensitive exchange failed to save — data below can be added by hand", `A flagged exchange didn't save to Airtable.\n\nWHAT WAS BEING SAVED (copy this into Airtable manually if you want to recover it):\n${JSON.stringify(t.input, null, 2)}\n\nSession: ${sessionId}\n\nError: ${e && e.stack ? e.stack : e}`);
          }
        } else if (t.name === "log_tree_engagement") {
          // Deliberately quiet — no alert. This is meant to accumulate for
          // trend-review, the same reasoning as interest_signal: individual
          // entries aren't each worth an interruption, the pattern over
          // time is the value.
          try {
            await saveTreeEngagement(sessionId, t.input);
          } catch (e) {
            console.error("Tree engagement save failed:", e);
            sendAlert("Tree engagement entry failed to save — data below can be added by hand", `A log_tree_engagement call didn't save to Airtable.\n\nWHAT WAS BEING SAVED (copy this into Airtable manually if you want to recover it):\n${JSON.stringify(t.input, null, 2)}\n\nSession: ${sessionId}\n\nError: ${e && e.stack ? e.stack : e}`);
          }
        } else if (t.name === "flag_tree_conflict") {
          try {
            const context = formatTranscript([...convo, { role: "assistant", content }]);
            await saveTreeConflict(sessionId, { ...t.input, context });
            // Unlike flag_sensitive_exchange, ALL THREE resolutions alert —
            // a confirmed real threat is exactly the case most worth
            // knowing about, not the one to skip.
            const subjectByResolution = {
              confirmed_threat: "A tree conflict was confirmed as real — worth a look",
              resolved_or_improved: "Outdated 'still in danger' info got corrected with good news",
              not_a_threat: "A tree conflict claim was checked and corrected",
              could_not_verify: "A tree conflict couldn't be verified either way",
            };
            sendAlert(
              subjectByResolution[t.input.resolution] || "A tree conflict was flagged",
              `Situation: ${t.input.situation}\nResolution: ${t.input.resolution}\n${t.input.note ? `Note: ${t.input.note}\n` : ""}\nFull conversation so far:\n${context}\n\nSession: ${sessionId}`
            );
          } catch (e) {
            console.error("Tree conflict save failed:", e);
            sendAlert("Tree conflict flag failed to save — data below can be added by hand", `A flag_tree_conflict call didn't save to Airtable.\n\nWHAT WAS BEING SAVED (copy this into Airtable manually if you want to recover it):\n${JSON.stringify(t.input, null, 2)}\n\nSession: ${sessionId}\n\nError: ${e && e.stack ? e.stack : e}`);
          }
        } else if (t.name === "fetch_page") {
          const pageText = await fetchPageContent(t.input && t.input.url);
          toolResultContent.set(t.id, pageText);
        } else if (t.name === "end_conversation") {
          ended = true;
        }
      }

      convo.push({ role: "assistant", content });

      // Every tool_use block must get a matching tool_result in the very
      // next message, or this conversation's history becomes permanently
      // invalid for any future API call — even ones long after this
      // request finishes. This has to happen unconditionally, regardless
      // of whether we're about to stop the loop.
      if (toolUses.length > 0) {
        convo.push({
          role: "user",
          content: toolUses.map(t => ({ type: "tool_result", tool_use_id: t.id, content: toolResultContent.has(t.id) ? toolResultContent.get(t.id) : "ok" })),
        });
      }

      // Now that the history is guaranteed valid, stop the instant she's
      // decided to close — otherwise the loop goes back for another round
      // (since a tool was used) and she sometimes generates a second,
      // redundant closing line, which then gets concatenated onto the
      // first. Her goodbye already happened; don't give her another
      // chance to say it again.
      if (ended) break;

      // web_search resolves server-side and produces no client tool_use,
      // so toolUses can be empty even though stop_reason is "tool_use" —
      // just let the loop run again on the same convo either way.
      if (data.stop_reason === "tool_use") continue;

      break;
    }

    // Defensive fallback: if we somehow still have no text (ran out of
    // iterations mid-tool-use, or a genuinely empty reply), never send an
    // empty string back — the frontend treats that as a hard failure.
    if (!finalText.trim()) {
      finalText = "I'm still thinking that through — could you give me just a moment and try sending that again?";
    }

    try {
      await updateTranscript(sessionId, convo);
    } catch (e) {
      console.error("Transcript update failed:", e);
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
    sendAlert("Chat request failed — a visitor got the fallback message", `Someone's message failed to get a real reply and they saw the generic "went a little quiet" fallback instead.\n\nNothing to manually recover here — if this keeps happening, paste this whole email into a conversation with Claude to get it debugged and fixed.\n\nSession: ${sessionId}\n\nError: ${err && err.stack ? err.stack : err}`);
    res.status(502).json({ error: "Navi is unavailable right now" });
  }
};
