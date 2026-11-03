import { test } from "node:test";
import assert from "node:assert/strict";
import { smsClean, smsInfo } from "../src/sms.ts";

test("curly apostrophes, quotes, dashes and the like get a plain equivalent", () => {
  assert.equal(smsClean("Mikes: ton quart a changé, c’est noté…"), "Mikes: ton quart a changé, c'est noté...");
  assert.equal(smsClean("Dis « oui » ou “non” – merci"), 'Dis "oui" ou "non" - merci');
  assert.equal(smsClean("Toyota · ABC 123"), "Toyota - ABC 123");
  assert.equal(smsClean("Non : 5 $"), "Non : 5 $");
});

test("emojis are removed (with their joiners and skin tones) and the spacing is tidied", () => {
  assert.equal(smsClean("Mikes: ✅ ton quart se termine ⏰"), "Mikes: ton quart se termine");
  assert.equal(smsClean("🚨 URGENT 👍🏽 freins 👨‍👩‍👧"), "URGENT freins");
  assert.equal(smsClean("Bravo 🇨🇦!"), "Bravo !");
  assert.equal(smsClean("ligne un ✅\nligne deux  🎉  fin"), "ligne un\nligne deux fin");
});

test("the French letters ê â î ô û ç are kept, as are é è à ù", () => {
  const t = "Mikes: tâche à finir, être prêt, ça ouvre à côté. Où, où ? À toi !";
  assert.equal(smsClean(t).replace(/\s+/g, " "), t.replace(/\s+/g, " ").replace(" !", " !").replace(" ?", " ?"));
  for (const c of "êâîôûçÊÂÎÔÛœ") assert.ok(smsClean(`a${c}b`).includes(c), c);
});

test("a cleaned text of standard characters is one segment up to 160; the kept accents still make it Unicode", () => {
  const plain = smsClean("Mikes: le remplacement est déjà comblé. Merci! L’équipe");
  assert.deepEqual([smsInfo(plain).unicode, smsInfo(plain).segments], [false, 1]);
  assert.ok(smsInfo("Mikes: les horaires sont prêts ✅").unicode);           // an emoji
  assert.ok(smsInfo("Mikes: c’est noté").unicode);                           // curly apostrophe
  assert.ok(!smsInfo(smsClean("Mikes: c’est noté")).unicode);                // cleaned
  assert.ok(smsInfo("Mikes: ça va être prêt").unicode);                      // ç, ê, ê are not standard
  assert.equal(smsInfo("é è à ù ü ñ").unicode, false);                       // these are standard
  assert.equal(smsInfo("a".repeat(160)).segments, 1); assert.equal(smsInfo("a".repeat(161)).segments, 2); assert.equal(smsInfo("a".repeat(306)).segments, 2); assert.equal(smsInfo("a".repeat(307)).segments, 3);
  assert.equal(smsInfo("ê".repeat(70)).segments, 1); assert.equal(smsInfo("ê".repeat(71)).segments, 2); assert.equal(smsInfo("😀".repeat(35)).segments, 1); assert.equal(smsInfo("😀".repeat(36)).segments, 2);
  assert.equal(smsInfo("").segments, 0);
});
