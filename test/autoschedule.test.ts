import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AUTO, parseAuto, validateAuto, nextMonday, autoDue, inAutoScope, autoNotice, autoReminder, reminderDue } from "../src/autoschedule.ts";

test("the default is the night of Wednesday to Thursday, with the notice at 8 a.m.", () => {
  assert.deepEqual(parseAuto(null), DEFAULT_AUTO);
  assert.equal(DEFAULT_AUTO.dow, 4);
  assert.equal(DEFAULT_AUTO.hour, 2);
  assert.equal(DEFAULT_AUTO.notify_hour, 8);
});

test("stored settings are completed with the defaults and cleaned", () => {
  const s = parseAuto(JSON.stringify({ dow: 9, hour: 5, recipients: [3, "x", -1, 7], scope: ["1:kitchen", "bad"], extra: "x".repeat(5000) }));
  assert.equal(s.dow, 4); assert.equal(s.hour, 5);
  assert.deepEqual(s.recipients, [3, 7]); assert.deepEqual(s.scope, ["1:kitchen"]); assert.equal(s.extra.length, 2000);
  assert.deepEqual(parseAuto("not json"), DEFAULT_AUTO);
});

test("a settings form is checked field by field", () => {
  const ok = { enabled: true, dow: 3, hour: 1, notify_hour: 9, email: true, sms: true, recipients: [1, 1, 2], scope: null, extra: " garde les fins de semaine ", reminders: true, reminder_days: [3, 1, 1, 2], reminder_hour: 9, reminder_recipients: null, r_email: true, r_sms: false };
  const v = validateAuto(ok);
  assert.ok("value" in v && v.value.recipients?.length === 2 && v.value.extra === "garde les fins de semaine");
  assert.deepEqual(validateAuto({ ...ok, dow: 7 }), { error: "dow" });
  assert.deepEqual(validateAuto({ ...ok, hour: 24 }), { error: "hour" });
  assert.deepEqual(validateAuto({ ...ok, recipients: ["a"] }), { error: "recipients" });
  assert.deepEqual(validateAuto({ ...ok, scope: ["../x"] }), { error: "scope" });
  assert.deepEqual(validateAuto({ ...ok, email: "yes" }), { error: "channels" });
  assert.ok("value" in v && JSON.stringify(v.value.reminder_days) === "[1,2,3]"); // sorted, no duplicates
  assert.deepEqual(validateAuto({ ...ok, reminder_days: [0] }), { error: "reminder_days" });
  assert.deepEqual(validateAuto({ ...ok, reminder_days: [15] }), { error: "reminder_days" });
  assert.deepEqual(validateAuto({ ...ok, reminder_hour: 30 }), { error: "reminder_hour" });
  assert.deepEqual(validateAuto({ ...ok, reminder_recipients: ["x"] }), { error: "reminder_recipients" });
});

test("the week planned is the Monday after the day it runs", () => {
  assert.equal(nextMonday("2026-11-05"), "2026-11-09"); // Thursday
  assert.equal(nextMonday("2026-11-08"), "2026-11-09"); // Sunday
  assert.equal(nextMonday("2026-11-09"), "2026-11-16"); // Monday: the next one
});

test("it is due on the chosen day from the chosen hour, and the notice follows", () => {
  const s = DEFAULT_AUTO;
  assert.equal(autoDue("2026-11-04T23:59", s), null);                       // Wednesday
  assert.equal(autoDue("2026-11-05T01:55", s), null);                       // Thursday, too early
  assert.deepEqual(autoDue("2026-11-05T02:00", s), { week: "2026-11-09", notifyAt: "2026-11-05T08:00" });
  assert.deepEqual(autoDue("2026-11-05T17:30", s), { week: "2026-11-09", notifyAt: "2026-11-05T08:00" }); // a missed run is still made that day
  assert.equal(autoDue("2026-11-06T02:00", s), null);                       // Friday
  assert.equal(autoDue("2026-11-05T02:00", { ...s, enabled: false }), null);
  // a notice hour that is not later than the run hour means the next morning
  assert.equal(autoDue("2026-11-05T10:00", { ...s, hour: 10, notify_hour: 8 })?.notifyAt, "2026-11-06T08:00");
});

test("scope: everything when null, otherwise only the ticked restaurant and department", () => {
  assert.equal(inAutoScope(DEFAULT_AUTO, 1, "kitchen"), true);
  const s = { ...DEFAULT_AUTO, scope: ["1:kitchen"] };
  assert.equal(inAutoScope(s, 1, "kitchen"), true);
  assert.equal(inAutoScope(s, 1, "floor"), false);
  assert.equal(inAutoScope(s, 2, "kitchen"), false);
});

test("the notice lists what was created, in the person's language, with a short text for SMS", () => {
  const results = [
    { restaurant_id: 1, restaurant: "Mikes SAM", department: "kitchen", status: "created" as const, shifts: 34 },
    { restaurant_id: 1, restaurant: "Mikes SAM", department: "floor", status: "has_shifts" as const },
    { restaurant_id: 1, restaurant: "Mikes SAM", department: "delivery", status: "failed" as const, error: "x" },
  ];
  const base = { week: "2026-11-09", url: "https://mikes.example", brand: "Mikes", results };
  const fr = autoNotice("fr", { ...base, sms: false });
  assert.match(fr.subject, /prêts à vérifier/);
  assert.ok(fr.text.includes("Cuisine : 34 quarts") && fr.text.includes("déjà planifié") && fr.text.includes("https://mikes.example") && /brouillon/.test(fr.text));
  const en = autoNotice("en", { ...base, sms: false });
  assert.ok(/ready to check/.test(en.subject) && en.text.includes("Kitchen : 34 shifts"));
  const sms = autoNotice("fr", { ...base, sms: true });
  assert.ok(sms.text.length < 200 && sms.text.includes("34 quarts") && sms.text.includes("https://mikes.example"));
});

test("when nothing was created the notice says so and why", () => {
  const n = autoNotice("fr", { week: "2026-11-09", url: "u", brand: "Mikes", results: [], error: "no_ai_key", sms: false });
  assert.match(n.subject, /rien n’a été créé/); assert.match(n.text, /clé de l’IA/);
  assert.match(autoNotice("en", { week: "2026-11-09", url: "u", brand: "Mikes", results: [], error: "no_ai_key", sms: true }).text, /AI key/);
});

test("reminders: defaults are one, two and three days after, at 8 a.m.", () => {
  assert.deepEqual(DEFAULT_AUTO.reminder_days, [1, 2, 3]);
  assert.equal(DEFAULT_AUTO.reminder_hour, 8);
  assert.deepEqual(parseAuto(JSON.stringify({ reminder_days: [5, 2, 2, 99, "x"] })).reminder_days, [2, 5]);
});

test("a reminder is due on each chosen day, once, from the chosen hour, until the week starts", () => {
  const s = DEFAULT_AUTO, run = "2026-11-05", week = "2026-11-09";
  assert.equal(reminderDue("2026-11-05", 12, run, week, [], s), null);                 // the day itself: the notice, not a reminder
  assert.equal(reminderDue("2026-11-06", 7, run, week, [], s), null);                  // too early in the day
  assert.deepEqual(reminderDue("2026-11-06", 8, run, week, [], s), { day: 1, sent: [1] });
  assert.equal(reminderDue("2026-11-06", 15, run, week, [1], s), null);                // already sent
  assert.deepEqual(reminderDue("2026-11-07", 8, run, week, [1], s), { day: 2, sent: [1, 2] });
  assert.deepEqual(reminderDue("2026-11-08", 9, run, week, [1, 2], s), { day: 3, sent: [1, 2, 3] });
  assert.equal(reminderDue("2026-11-09", 9, run, week, [1, 2, 3], s), null);           // the week has started
  assert.equal(reminderDue("2026-11-09", 9, run, week, [], s), null);
  // missed days are not sent one after the other: only the latest, and all are marked
  assert.deepEqual(reminderDue("2026-11-08", 9, run, week, [], s), { day: 3, sent: [1, 2, 3] });
  assert.equal(reminderDue("2026-11-06", 9, run, week, [], { ...s, reminders: false }), null);
  assert.deepEqual(reminderDue("2026-11-07", 9, run, week, [], { ...s, reminder_days: [2, 4] }), { day: 2, sent: [2] });
});

test("the reminder lists the schedules still to publish and how long is left", () => {
  const base = { week: "2026-11-09", url: "https://mikes.example", brand: "Mikes", pending: [{ restaurant: "Mikes SAM", department: "kitchen" }], days: 2, daysLeft: 2 };
  const fr = autoReminder("fr", { ...base, sms: false });
  assert.match(fr.subject, /Rappel/); assert.ok(fr.text.includes("il y a 2 jours") && fr.text.includes("Cuisine") && fr.text.includes("dans 2 jours"));
  assert.match(autoReminder("en", { ...base, daysLeft: 1, days: 1, sms: false }).text, /1 day ago.*starts tomorrow/s);
  assert.ok(autoReminder("fr", { ...base, sms: true }).text.length < 220);
});
