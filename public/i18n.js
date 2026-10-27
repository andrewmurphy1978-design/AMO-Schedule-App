// Translations. French is the default; English is the second language.
const translations = {
  fr: {
    title: "AMO Horaire",
    heading: "AMO Horaire",
    status: "Déploiement réussi 🎉",
    lang: "English",
  },
  en: {
    title: "AMO Schedule",
    heading: "AMO Schedule",
    status: "Deployment successful 🎉",
    lang: "Français",
  },
};

function getLang() {
  const fromUrl = new URLSearchParams(location.search).get("lang");
  let stored = null;
  try { stored = localStorage.getItem("lang"); } catch (e) {}
  const lang = fromUrl || stored || "fr";
  return translations[lang] ? lang : "fr";
}

function applyLang(lang) {
  try { localStorage.setItem("lang", lang); } catch (e) {}
  document.documentElement.lang = lang;
  document.title = translations[lang].title;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = translations[lang][el.dataset.i18n];
  });
}

document.addEventListener("DOMContentLoaded", () => {
  let lang = getLang();
  applyLang(lang);
  document.getElementById("lang-toggle").addEventListener("click", () => {
    lang = lang === "fr" ? "en" : "fr";
    applyLang(lang);
  });
});
