import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VEHICLES, parseVehicleSettings, validateVehicleSettings, currentSeason, tireReminderDue, tireNotice, issueNotice, categoryName } from "../src/vehicles.ts";

const S = DEFAULT_VEHICLES;

test("defaults follow the Québec rules: winter tires on by December 1, studded tires off by May 1", () => {
  assert.equal(S.fall_deadline, "12-01"); assert.equal(S.spring_start, "03-16"); assert.equal(S.spring_deadline, "05-01");
  assert.deepEqual(parseVehicleSettings(null), S);
});

test("settings are cleaned, completed and checked", () => {
  const p = parseVehicleSettings(JSON.stringify({ fall_deadline: "13-40", offsets: [3, 3, 99, 200, "x", 14], hour: 30, recipients: [2, "a", 5] }));
  assert.equal(p.fall_deadline, "12-01"); assert.deepEqual(p.offsets, [99, 14, 3]); assert.equal(p.hour, 8); assert.deepEqual(p.recipients, [2, 5]);
  const ok = { enabled: true, fall_deadline: "11-25", spring_start: "03-20", spring_deadline: "04-30", offsets: [3, 14, 14], hour: 9, recipients: null, email: true, sms: true };
  const v = validateVehicleSettings(ok);
  assert.ok("value" in v && JSON.stringify(v.value.offsets) === "[14,3]");
  assert.deepEqual(validateVehicleSettings({ ...ok, fall_deadline: "02-30" }), { error: "fall_deadline" });
  assert.deepEqual(validateVehicleSettings({ ...ok, spring_start: "05-02" }), { error: "spring_dates" });
  assert.deepEqual(validateVehicleSettings({ ...ok, offsets: [-1] }), { error: "offsets" });
  assert.deepEqual(validateVehicleSettings({ ...ok, hour: 24 }), { error: "hour" });
  assert.deepEqual(validateVehicleSettings({ ...ok, sms: "yes" }), { error: "channels" });
});

test("the season that matters: next spring deadline, then the fall one, then the next spring", () => {
  assert.deepEqual([currentSeason("2026-01-10", S).key, currentSeason("2026-03-20", S).key, currentSeason("2026-05-02", S).key, currentSeason("2026-11-15", S).key, currentSeason("2026-12-02", S).key],
    ["spring-2026", "spring-2026", "fall-2026", "fall-2026", "spring-2027"]);
  const f = currentSeason("2026-11-01", S);
  assert.equal(f.deadline, "2026-12-01"); assert.equal(f.days_left, 30); assert.equal(f.target, "winter"); assert.equal(f.opens, null);
  const sp = currentSeason("2026-04-20", S);
  assert.equal(sp.deadline, "2026-05-01"); assert.equal(sp.days_left, 11); assert.equal(sp.target, "summer"); assert.equal(sp.opens, "2026-03-16");
  assert.equal(currentSeason("2026-12-01", S).season, "fall"); // the deadline day itself still counts
});

test("fall reminders: 45, 30, 14, 7, 3, 1 days before and on the day; each once; the latest one when several were missed", () => {
  assert.equal(tireReminderDue("2026-10-16", 8, S, []), null);                                       // 46 days before
  assert.deepEqual(tireReminderDue("2026-10-17", 8, S, [])?.offset, 45);
  assert.equal(tireReminderDue("2026-10-17", 7, S, []), null);                                       // too early in the day
  assert.equal(tireReminderDue("2026-10-20", 9, S, [45]), null);                                     // nothing new yet
  assert.equal(tireReminderDue("2026-11-01", 9, S, [45])?.offset, 30);
  const missed = tireReminderDue("2026-11-28", 9, S, [45, 30]);                                      // 3 days left, 14 and 7 were missed
  assert.equal(missed?.offset, 3); assert.deepEqual(missed?.mark, [45, 30, 14, 7, 3]);
  assert.equal(tireReminderDue("2026-12-01", 9, S, [45, 30, 14, 7, 3, 1])?.offset, 0);
  assert.equal(tireReminderDue("2026-12-01", 9, S, [45, 30, 14, 7, 3, 1, 0]), null);
  assert.equal(tireReminderDue("2026-11-01", 9, { ...S, enabled: false }, []), null);
});

test("spring: nothing before the change opens; one notice the day it opens; then reminders before May 1", () => {
  assert.equal(tireReminderDue("2026-03-15", 9, S, []), null);                                       // still winter-tire season by law
  assert.equal(tireReminderDue("2026-03-16", 9, S, [])?.offset, 999);                                // it opens
  assert.equal(tireReminderDue("2026-03-17", 9, S, [999])?.offset, 45);                              // 45 days before May 1
  assert.equal(tireReminderDue("2026-03-20", 9, S, [999, 45]), null);
  assert.equal(tireReminderDue("2026-04-01", 9, S, [999, 45])?.offset, 30);                          // 30 days before May 1
});

test("the reminder says what is to change, by when, and the law", () => {
  const season = currentSeason("2026-11-17", S);
  const fr = tireNotice("fr", { season, pending: ["Toyota ABC 123", "Kia XYZ 789"], url: "https://mikes.example", brand: "Mikes", offset: 14, sms: false });
  assert.match(fr.subject, /Pneus d’hiver : 2 véhicules à changer/);
  assert.ok(fr.text.includes("1er décembre au 15 mars") && fr.text.includes("Toyota ABC 123") && fr.text.includes("Pneus changés") && fr.text.includes("14 jours"));
  const en = tireNotice("en", { season, pending: ["Toyota"], url: "u", brand: "Mikes", offset: 14, sms: false });
  assert.ok(/Winter tires: 1 vehicle to change/.test(en.subject) && en.text.includes("December 1 to March 15"));
  const spring = tireNotice("fr", { season: currentSeason("2026-03-16", S), pending: ["Toyota"], url: "u", brand: "Mikes", offset: 999, sms: false });
  assert.ok(/peuvent être retirés/.test(spring.subject) && spring.text.includes("1er mai"));
  assert.ok(tireNotice("fr", { season, pending: ["a"], url: "https://m", brand: "Mikes", offset: 14, sms: true }).text.length < 200);
});

test("the problem report names the vehicle, the type, the severity and who reported it", () => {
  const c = { vehicle: "Toyota ABC 123", restaurant: "Mikes SAM", by: "Marc", severity: "urgent" as const, category: "brakes", description: "Les freins grincent beaucoup", url: "https://m", brand: "Mikes" };
  const fr = issueNotice("fr", { ...c, sms: false });
  assert.ok(fr.subject.startsWith("🚨 URGENT") && fr.subject.includes("Freins") && fr.text.includes("ne plus utiliser") && fr.text.includes("Marc") && fr.text.includes("grincent"));
  assert.ok(!issueNotice("fr", { ...c, severity: "normal", sms: false }).subject.includes("URGENT"));
  assert.ok(/URGENT, do not use/.test(issueNotice("en", { ...c, sms: true }).text));
  assert.equal(categoryName("tires", "en"), "Tires"); assert.equal(categoryName("zzz", "fr"), "zzz");
});
