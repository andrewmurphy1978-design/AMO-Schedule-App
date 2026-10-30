// Message texts (French / English). Pure functions; the caller picks the language from the employee's profile.
export type Lang = "fr" | "en";
export interface Msg { subject: string; text: string }

const MONTHS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juill.", "août", "sept.", "oct.", "nov.", "déc."];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS_FR = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const DAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatDate(ymd: string, lang: Lang): string {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)));
  return lang === "fr"
    ? `${DAYS_FR[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_FR[d.getUTCMonth()]}`
    : `${DAYS_EN[d.getUTCDay()]} ${MONTHS_EN[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "mar. 27 oct. 11:00–F" */
export function formatWhen(startAt: string, endAt: string, untilClose: boolean, lang: Lang): string {
  return `${formatDate(startAt.slice(0, 10), lang)} ${startAt.slice(11, 16)}–${untilClose ? "F" : endAt.slice(11, 16)}`;
}

/** 30 -> "30 min", 60 -> "1 h", 90 -> "1 h 30", 1440 -> "1 jour". */
export function durationText(min: number, l: Lang): string {
  if (min >= 1440 && min % 1440 === 0) { const d = min / 1440; return l === "fr" ? `${d} jour${d > 1 ? "s" : ""}` : `${d} day${d > 1 ? "s" : ""}`; }
  if (min >= 60) { const h = Math.floor(min / 60), m = min % 60; return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`; }
  return `${min} min`;
}

export const ABSENCE_REASONS = ["sick", "medical", "family", "transport", "personal", "other"] as const;
export type AbsenceReason = (typeof ABSENCE_REASONS)[number];
const REASON_FR: Record<AbsenceReason, string> = { sick: "Maladie", medical: "Rendez-vous médical", family: "Urgence familiale", transport: "Problème de transport", personal: "Raison personnelle", other: "Autre" };
const REASON_EN: Record<AbsenceReason, string> = { sick: "Sick", medical: "Medical appointment", family: "Family emergency", transport: "Transportation problem", personal: "Personal reason", other: "Other" };
export const reasonLabel = (r: string | null | undefined, l: Lang) => (r && (ABSENCE_REASONS as readonly string[]).includes(r) ? (l === "fr" ? REASON_FR : REASON_EN)[r as AbsenceReason] : "");

export interface Ctx { restaurant: string; role: string; when: string }

export const T = {
  sickNotice: (l: Lang, c: Ctx & { sick: string; offers: number; reason?: string | null; note?: string | null }): Msg =>
    l === "fr"
      ? { subject: `Absence : ${c.sick} (${c.restaurant})`, text: `${c.sick} sera absent(e) — ${c.role}, ${c.restaurant}, ${c.when}.${c.reason ? ` Raison : ${reasonLabel(c.reason, "fr")}${c.note ? ` (${c.note})` : ""}.` : ""} ${c.offers > 0 ? `Une demande de remplacement a été envoyée à ${c.offers} personne(s).` : "Aucun remplaçant disponible n’a pu être joint."} (Information seulement.)` }
      : { subject: `Absence: ${c.sick} (${c.restaurant})`, text: `${c.sick} will be absent — ${c.role}, ${c.restaurant}, ${c.when}.${c.reason ? ` Reason: ${reasonLabel(c.reason, "en")}${c.note ? ` (${c.note})` : ""}.` : ""} ${c.offers > 0 ? `A replacement request was sent to ${c.offers} people.` : "No available replacement could be reached."} (For information only.)` },

  offer: (l: Lang, c: Ctx & { url: string; sms: boolean }): Msg =>
    l === "fr"
      ? { subject: `Remplacement demandé — ${c.restaurant}`, text: `Mikes: remplacement demandé — ${c.role}, ${c.restaurant}, ${c.when}. ${c.sms ? "Répondez OUI pour accepter, NON pour refuser, ou " : ""}ouvrez ${c.url}` }
      : { subject: `Replacement needed — ${c.restaurant}`, text: `Mikes: replacement needed — ${c.role}, ${c.restaurant}, ${c.when}. ${c.sms ? "Reply YES to accept, NO to decline, or " : ""}open ${c.url}` },

  accepted: (l: Lang, c: Ctx): Msg =>
    l === "fr"
      ? { subject: `Remplacement confirmé`, text: `Merci! C’est confirmé : ${c.role}, ${c.restaurant}, ${c.when}. Le quart est à ton horaire.` }
      : { subject: `Replacement confirmed`, text: `Thank you! Confirmed: ${c.role}, ${c.restaurant}, ${c.when}. The shift is on your schedule.` },

  alreadyFilled: (l: Lang, c: Ctx): Msg =>
    l === "fr"
      ? { subject: `Remplacement déjà comblé`, text: `Merci, mais le remplacement (${c.role}, ${c.restaurant}, ${c.when}) vient d’être comblé par quelqu’un d’autre.` }
      : { subject: `Replacement already filled`, text: `Thanks, but the replacement (${c.role}, ${c.restaurant}, ${c.when}) was just filled by someone else.` },

  managerFilled: (l: Lang, c: Ctx & { sick: string; by: string }): Msg =>
    l === "fr"
      ? { subject: `Remplacement trouvé (${c.restaurant})`, text: `${c.by} remplace ${c.sick} — ${c.role}, ${c.restaurant}, ${c.when}.` }
      : { subject: `Replacement found (${c.restaurant})`, text: `${c.by} is replacing ${c.sick} — ${c.role}, ${c.restaurant}, ${c.when}.` },

  escalation: (l: Lang, c: Ctx & { sick: string; minutes: number }): Msg =>
    l === "fr"
      ? { subject: `ACTION REQUISE : aucun remplaçant (${c.restaurant})`, text: `ACTION REQUISE — personne n’a accepté de remplacer ${c.sick} (${c.role}, ${c.restaurant}, ${c.when}) après ${c.minutes} min. Ouvrez l’application pour assigner quelqu’un.` }
      : { subject: `ACTION NEEDED: no replacement (${c.restaurant})`, text: `ACTION NEEDED — nobody accepted to replace ${c.sick} (${c.role}, ${c.restaurant}, ${c.when}) after ${c.minutes} min. Open the app to assign someone.` },

  smsHelp: (l: Lang): Msg =>
    l === "fr" ? { subject: "Aide", text: "Mikes: répondez OUI ou NON à une demande de remplacement, ou MALADE si vous ne pouvez pas faire votre prochain quart." }
               : { subject: "Help", text: "Mikes: reply YES or NO to a replacement request, or SICK if you cannot work your next shift." },

  noOpenOffer: (l: Lang): Msg =>
    l === "fr" ? { subject: "Aucune demande", text: "Mikes: aucune demande de remplacement ouverte pour vous en ce moment." }
               : { subject: "No request", text: "Mikes: you have no open replacement request right now." },

  sickRecorded: (l: Lang, c: Ctx): Msg =>
    l === "fr" ? { subject: "Maladie notée", text: `Mikes: noté. On cherche un remplaçant pour ton quart (${c.role}, ${c.restaurant}, ${c.when}). Rétablis-toi vite!` }
               : { subject: "Sick call noted", text: `Mikes: noted. We are looking for a replacement for your shift (${c.role}, ${c.restaurant}, ${c.when}). Get well soon!` },

  noUpcomingShift: (l: Lang): Msg =>
    l === "fr" ? { subject: "Aucun quart", text: "Mikes: aucun quart à venir trouvé dans les prochaines 24 h." }
               : { subject: "No shift", text: "Mikes: no upcoming shift found in the next 24 hours." },

  timeOffRequest: (l: Lang, c: { name: string; from: string; to: string; note: string | null }): Msg =>
    l === "fr" ? { subject: `Demande de congé : ${c.name}`, text: `${c.name} demande congé du ${c.from} au ${c.to}.${c.note ? ` Note : ${c.note}` : ""} Ouvrez l’application (onglet Congés) pour répondre.` }
               : { subject: `Time-off request: ${c.name}`, text: `${c.name} requests time off from ${c.from} to ${c.to}.${c.note ? ` Note: ${c.note}` : ""} Open the app (Time off tab) to answer.` },

  timeOffDecision: (l: Lang, c: { approved: boolean; from: string; to: string; note: string | null }): Msg =>
    l === "fr" ? { subject: c.approved ? "Congé accordé" : "Congé refusé", text: `Ta demande de congé du ${c.from} au ${c.to} est ${c.approved ? "accordée" : "refusée"}.${c.note ? ` Note : ${c.note}` : ""}` }
               : { subject: c.approved ? "Time off approved" : "Time off declined", text: `Your time-off request from ${c.from} to ${c.to} was ${c.approved ? "approved" : "declined"}.${c.note ? ` Note: ${c.note}` : ""}` },

  // Sent to every employee who works in a schedule when it is published. Email lists the shifts; SMS stays short.
  schedulePublished: (l: Lang, c: { restaurant: string; from: string; to: string; lines: string[]; url: string; sms: boolean }): Msg => {
    const n = c.lines.length;
    return l === "fr"
      ? { subject: `Horaire publié — ${c.restaurant}`, text: `Mikes: l’horaire du ${c.from} au ${c.to} (${c.restaurant}) est publié. ${c.sms ? `Tu as ${n} quart${n > 1 ? "s" : ""}.` : `Tes quarts :\n${c.lines.join("\n")}`}${c.url ? `\n${c.url}` : ""}` }
      : { subject: `Schedule published — ${c.restaurant}`, text: `Mikes: the schedule for ${c.from} to ${c.to} (${c.restaurant}) is published. ${c.sms ? `You have ${n} shift${n > 1 ? "s" : ""}.` : `Your shifts:\n${c.lines.join("\n")}`}${c.url ? `\n${c.url}` : ""}` };
  },

  /** Reminder before a shift; `short` is the one-line detail used as the body of a push. */
  shiftReminder: (l: Lang, c: { minutes: number; restaurant: string; role: string; start: string; end: string; untilClose: boolean; url: string; sms: boolean }): Msg & { short: string } => {
    const span = `${c.start}–${c.untilClose ? "F" : c.end}`;
    const dur = durationText(c.minutes, l);
    return l === "fr"
      ? { subject: `⏰ Ton quart commence dans ${dur}`, short: `${c.restaurant} · ${span} · ${c.role}`, text: `Mikes: ton quart commence dans ${dur} — ${c.role}, ${c.restaurant}, ${span}.${c.sms || !c.url ? "" : `\n${c.url}`}` }
      : { subject: `⏰ Your shift starts in ${dur}`, short: `${c.restaurant} · ${span} · ${c.role}`, text: `Mikes: your shift starts in ${dur} — ${c.role}, ${c.restaurant}, ${span}.${c.sms || !c.url ? "" : `\n${c.url}`}` };
  },

  /** "Your shift ends soon": a nudge to do the end-of-shift checklist. */
  shiftEndReminder: (l: Lang, c: { minutes: number; restaurant: string; url: string; sms: boolean }): Msg & { short: string } => {
    const dur = durationText(c.minutes, l);
    return l === "fr"
      ? { subject: `✅ Ton quart se termine dans ${dur}`, short: `Pense à ta liste de fin de quart · ${c.restaurant}`, text: `Mikes: ton quart se termine dans ${dur}. Pense à ta liste de fin de quart (${c.restaurant}).${c.sms || !c.url ? "" : `\n${c.url}`}` }
      : { subject: `✅ Your shift ends in ${dur}`, short: `Remember your end-of-shift checklist · ${c.restaurant}`, text: `Mikes: your shift ends in ${dur}. Remember your end-of-shift checklist (${c.restaurant}).${c.sms || !c.url ? "" : `\n${c.url}`}` };
  },

  test: (l: Lang): Msg =>
    l === "fr" ? { subject: "Message test", text: "Mikes: ceci est un message test. La messagerie fonctionne!" } : { subject: "Test message", text: "Mikes: this is a test message. Messaging works!" },
};
