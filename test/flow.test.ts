import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseCandidates, byFewestHours, type Candidate } from "../src/eligibility.ts";
import { formatWhen, formatDate, T } from "../src/templates.ts";

const shift = { start_at: "2026-10-27T11:00", end_at: "2026-10-27T17:00" }; // 6 h
const person = (id: number, over: Partial<Candidate> = {}): Candidate => ({ staff_id: id, name: `P${id}`, has_phone: true, has_email: false, week_hours: 20, shifts: [], ...over });
const opts = { overtime_hours: 40, allow_overtime: false };

test("free people with a contact are eligible; the sick person is never asked", () => {
  const r = chooseCandidates(shift, 1, [person(1), person(2), person(3)], opts);
  assert.deepEqual(r.eligible.map((p) => p.staff_id), [2, 3]);
});

test("someone working an overlapping shift is excluded, back-to-back is fine", () => {
  const r = chooseCandidates(shift, 1, [person(2, { shifts: [{ start_at: "2026-10-27T15:00", end_at: "2026-10-27T20:00" }] }), person(3, { shifts: [{ start_at: "2026-10-27T17:00", end_at: "2026-10-27T22:00" }] })], opts);
  assert.deepEqual(r.excluded, [{ staff_id: 2, name: "P2", reason: "busy" }]);
  assert.deepEqual(r.eligible.map((p) => p.staff_id), [3]);
});

test("overtime: excluded by default, allowed when the setting is on", () => {
  const near = person(2, { week_hours: 36 }); // 36 + 6 = 42 > 40
  assert.deepEqual(chooseCandidates(shift, 1, [near], opts).excluded[0].reason, "overtime");
  assert.deepEqual(chooseCandidates(shift, 1, [near], { ...opts, allow_overtime: true }).eligible.length, 1);
  assert.equal(chooseCandidates(shift, 1, [person(3, { week_hours: 34 })], opts).eligible.length, 1); // exactly 40 is allowed
});

test("no phone and no email means no way to reach them", () => {
  const r = chooseCandidates(shift, 1, [person(2, { has_phone: false, has_email: false })], opts);
  assert.equal(r.excluded[0].reason, "no_contact");
});

test("ordering favours the people with the fewest hours", () => {
  const sorted = [person(2, { week_hours: 30 }), person(3, { week_hours: 10 }), person(4, { week_hours: 10, name: "A" })].sort(byFewestHours);
  assert.deepEqual(sorted.map((p) => p.staff_id), [4, 3, 2]);
});

test("dates and messages come out in both languages", () => {
  assert.equal(formatDate("2026-10-27", "fr"), "mar. 27 oct.");
  assert.equal(formatDate("2026-10-27", "en"), "Tue Oct 27");
  assert.equal(formatWhen("2026-10-27T11:00", "2026-10-27T22:00", true, "fr"), "mar. 27 oct. 11:00–F");
  const ctx = { restaurant: "Ste-Agathe", role: "Cuisinier", when: "mar. 27 oct. 11:00–F" };
  const offer = T.offer("fr", { ...ctx, url: "https://x/r/abc", sms: true });
  assert.match(offer.text, /OUI/); assert.match(offer.text, /https:\/\/x\/r\/abc/); assert.match(offer.text, /Ste-Agathe/);
  assert.match(T.offer("en", { ...ctx, url: "u", sms: true }).text, /YES/);
  assert.doesNotMatch(T.offer("fr", { ...ctx, url: "u", sms: false }).text, /OUI/);
  assert.match(T.escalation("fr", { ...ctx, sick: "Marc", minutes: 30 }).subject, /ACTION REQUISE/);
  assert.match(T.escalation("en", { ...ctx, sick: "Marc", minutes: 30 }).text, /ACTION NEEDED/);
  assert.match(T.sickNotice("fr", { ...ctx, sick: "Marc", offers: 0 }).text, /Aucun remplaçant/);
});

test("shift reminder wording and durations", () => {
  assert.equal(T.shiftReminder("fr", { minutes: 60, restaurant: "Saint-Sauveur", role: "Livreur", start: "17:00", end: "21:00", untilClose: false, url: "", sms: true }).subject, "⏰ Ton quart commence dans 1 h");
  const m = T.shiftReminder("en", { minutes: 90, restaurant: "Ste-Agathe", role: "Cook", start: "09:00", end: "14:00", untilClose: true, url: "", sms: true });
  assert.equal(m.subject, "⏰ Your shift starts in 1 h 30");
  assert.equal(m.short, "Ste-Agathe · 09:00–F · Cook");
});
