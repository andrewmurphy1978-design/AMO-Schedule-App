// A readable name for the device and browser behind a User-Agent ("Samsung Galaxy S23 · Chrome"). Pure, so it can be tested.
// Chrome on Android hides the model (it reports "K"), so then the name is just "Android".

const SAMSUNG: [RegExp, string][] = [[/SM-S9\d\d/, "Samsung Galaxy S2x"], [/SM-A\d+/, "Samsung Galaxy A"], [/SM-G\d+/, "Samsung Galaxy"], [/SM-[FNTX]\d+/, "Samsung Galaxy"]];

export function describeDevice(ua: string | null | undefined): { device: string; browser: string } {
  const s = (ua ?? "").slice(0, 400);
  if (!s) return { device: "", browser: "" };
  let device = "";
  if (/iPhone/.test(s)) device = "iPhone";
  else if (/iPad/.test(s)) device = "iPad";
  else if (/Android/.test(s)) {
    const model = /Android[^;)]*;\s*([^;)]+)/.exec(s)?.[1]?.trim() ?? "";
    const sam = SAMSUNG.find(([re]) => re.test(model) || re.test(s));
    const pixel = /Pixel\s*\d+[A-Za-z ]*/.exec(model)?.[0]?.trim();
    device = sam ? `${sam[1]} (Android)` : pixel ? `Google ${pixel} (Android)` : model && model.length > 1 && !/^(K|Mobile)$/.test(model) ? `${model} (Android)` : /Mobile/.test(s) ? "Android" : "Android (tablette)";
  } else if (/Windows/.test(s)) device = "Windows";
  else if (/Macintosh|Mac OS X/.test(s)) device = "Mac";
  else if (/CrOS/.test(s)) device = "Chromebook";
  else if (/Linux/.test(s)) device = "Linux";
  const browser = /SamsungBrowser\//.test(s) ? "Samsung Internet" : /Edg(e|A|iOS)?\//.test(s) ? "Edge" : /OPR\/|Opera/.test(s) ? "Opera" : /Firefox\/|FxiOS\//.test(s) ? "Firefox"
    : /CriOS\/|Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : "";
  return { device, browser };
}
