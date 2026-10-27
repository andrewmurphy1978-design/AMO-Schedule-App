// French is the default; English is the second language. Add every string to BOTH blocks.
const dict = {
  fr: {
    app: "Horaire", schedule: "Horaire", myShifts: "Mes quarts", admin: "Administration",
    restaurant: "Restaurant", department: "Département", today: "Aujourd’hui", week: "Semaine",
    prev: "Semaine précédente", next: "Semaine suivante",
    noShifts: "Aucun quart ce jour-là.", noShiftsWeek: "Aucun quart cette semaine.",
    addShift: "Ajouter un quart", editShift: "Modifier le quart", employee: "Employé", role: "Rôle",
    date: "Date", start: "Début", end: "Fin", notes: "Notes", save: "Enregistrer", cancel: "Annuler",
    delete: "Supprimer", untilClose: "Jusqu’à la fermeture (F)", confirmDelete: "Supprimer ce quart ?", nextDay: "(lendemain)",
    saveAnyway: "Enregistrer quand même", overlapTitle: "Conflit d’horaire",
    overlapBody: "Cette personne est déjà prévue :", 
    notHeld: "Cette personne n’a pas ce rôle dans ce restaurant.",
    forbidden: "Vous n’avez pas la permission de faire cela.", invalidTimes: "Heures invalides.",
    genericError: "Une erreur est survenue. Réessayez.",
    noAccessTitle: "Accès non configuré", noAccessBody: "Votre courriel n’est pas encore dans le système. Demandez à votre gestionnaire de vous ajouter.",
    signedInAs: "Connecté en tant que", noSchedules: "Aucun horaire disponible pour vous pour le moment.",
    viewOnly: "Lecture seule", canEdit: "Vous pouvez modifier cet horaire",
    restaurants: "Restaurants", addRestaurant: "Ajouter un restaurant", name: "Nom", add: "Ajouter",
    staff: "Employés", addStaff: "Ajouter un employé", email: "Courriel", phone: "Téléphone",
    language: "Langue", notifyBy: "Aviser par", sms: "SMS", emailCh: "Courriel",
    roles: "Rôles", managerOf: "Gestionnaire de", saved: "Enregistré",
    details: "Détails", assignments: "Rôles et responsabilités", noStaff: "Aucun employé.",
    admin_flag: "Admin", weekHours: "h",
    coverage: "Couverture du jour", coverageWeek: "Couverture de la semaine", legendOk: "Cible atteinte", legendShort: "Manque", legendOver: "Surplus", legendNone: "Aucune cible",
    present: "Présents", target: "Cible", shortagesTitle: "Manques de personnel", surplusTitle: "Surplus de personnel", tooMany: "en trop", noShortagesWeek: "Aucun manque de personnel cette semaine.", noShortages: "Aucun manque de personnel ce jour-là.",
    missingN: "il manque", personsShort: "pers.", noTargetsYet: "Aucune cible définie. Configurez-les dans Administration.",
    targets: "Cibles de personnel", targetsHelp: "Nombre d’employés souhaité à chaque heure. Laissez vide s’il n’y a pas de cible.",
    allDays: "Tous les jours", resetDay: "Retirer les valeurs propres à ce jour", dayOverride: "Valeurs propres à ce jour",
    closeTime: "Heure de fermeture", openTime: "Heure d’ouverture", choosePhoto: "Choisir une photo", removePhoto: "Retirer la photo", badImage: "Image non valide (JPEG, PNG ou WebP).", photo: "Photo", colour: "Couleur", autoColour: "Couleur automatique", openTimes: "Heure d’ouverture pour chaque jour de la semaine.", hoursTitle: "Heures d’ouverture", beforeOpen: "Avant l’ouverture / après la fermeture", closeSlot: "Fermeture", closeHelp: "La cible « Fermeture » s’applique à la dernière heure avant la fermeture.",
    hasShiftsTitle: "Cette personne a des quarts avec ce rôle", hasShiftsBody: "quart(s) sont rattachés à ce rôle. Que voulez-vous en faire ?",
    moveShiftsTo: "Déplacer les quarts vers", deleteShifts: "Supprimer ces quarts", addRoleFirst: "Astuce : cochez d’abord le nouveau rôle, puis décochez l’ancien pour déplacer les quarts.",
    period: "Période", basePeriod: "Base (toute l’année)", seasonWord: "Saison", specialWord: "Jour spécial", addSeason: "+ Saison", addSpecial: "+ Jour spécial",
    editPeriod: "Modifier cette période", deletePeriod: "Supprimer cette période", confirmDeletePeriod: "Supprimer cette période et ses cibles ?",
    preset: "Modèle", customPreset: "Personnalisé…", ruleType: "Type de date", ruleDate: "Date précise (une seule fois)", ruleFixed: "Chaque année, à la même date",
    ruleNth: "Chaque année, un jour de la semaine du mois", ruleEaster: "Pâques", fromLabel: "Du", toLabel: "Au", monthLabel: "Mois", dayLabel: "Jour",
    nthLabel: "Rang", weekdayLabel: "Jour de la semaine", lengthDays: "Nombre de jours", last: "dernier", periodNameReq: "Donnez un nom à cette période.",
    inheritNote: "Les cases vides reprennent les valeurs de la période de base. Seules les valeurs saisies remplacent la base.",
    weekdayOnly: "Un jour précis de la semaine", easterRange: "Vendredi saint au lundi de Pâques", yearlyOn: "chaque année le", everyYear: "chaque année",
    effectiveFrom: "À partir du", effectiveHelp: "Les quarts avant cette date gardent leur ancien rôle (historique).",
    roleChoiceBody: "Cette personne a déjà un autre rôle dans ce restaurant. Voulez-vous l’ajouter en plus, ou remplacer l’ancien rôle ?",
    replace: "Remplacer", addAlso: "Ajouter en plus (elle travaille aux deux)",
    hourlyRate: "Taux horaire ($/h)", adminOnlyField: "Visible par les administrateurs seulement.", payroll: "Masse salariale", costDept: "Coût du département", costRestaurant: "Restaurant (tous les départements)",
    costDay: "Ce jour", costWeek: "Semaine", hoursShort: "h", unratedHours: "h travaillées sans taux horaire (non incluses)", showHourlyCost: "Afficher le coût par heure", hideHourlyCost: "Masquer le coût par heure", noRate: "Aucun taux",
    adminRestaurants: "Restaurants et heures", adminTargets: "Cibles de personnel", adminStaff: "Employés",
    hoursHelp: "Heure d’ouverture et de fermeture pour chaque jour de la semaine. Les quarts « jusqu’à la fermeture (F) » suivent l’heure de fermeture de leur jour.",
    copyMonday: "Copier lundi sur tous les jours", opensBeforeCloses: "Chaque jour, l’ouverture doit être avant la fermeture.",
    zoomDay: "Agrandir ce jour", backToWeek: "Semaine complète", prevDay: "Jour précédent", nextDay: "Jour suivant", zoomHint: "Cliquez sur un jour pour l’agrandir.",
    "dept.floor": "Salle", "dept.kitchen": "Cuisine", "dept.delivery": "Livraison",
    footer: "Toujours Mikes — gestion des horaires",
  },
  en: {
    app: "Schedule", schedule: "Schedule", myShifts: "My shifts", admin: "Admin",
    restaurant: "Restaurant", department: "Department", today: "Today", week: "Week",
    prev: "Previous week", next: "Next week",
    noShifts: "No shifts that day.", noShiftsWeek: "No shifts this week.",
    addShift: "Add shift", editShift: "Edit shift", employee: "Employee", role: "Role",
    date: "Date", start: "Start", end: "End", notes: "Notes", save: "Save", cancel: "Cancel",
    delete: "Delete", untilClose: "Until close (F)", confirmDelete: "Delete this shift?", nextDay: "(next day)",
    saveAnyway: "Save anyway", overlapTitle: "Schedule conflict",
    overlapBody: "This person is already scheduled:",
    notHeld: "This person does not hold that role at this restaurant.",
    forbidden: "You do not have permission to do that.", invalidTimes: "Invalid times.",
    genericError: "Something went wrong. Please try again.",
    noAccessTitle: "Access not set up", noAccessBody: "Your email is not in the system yet. Ask your manager to add you.",
    signedInAs: "Signed in as", noSchedules: "No schedules available to you yet.",
    viewOnly: "View only", canEdit: "You can edit this schedule",
    restaurants: "Restaurants", addRestaurant: "Add a restaurant", name: "Name", add: "Add",
    staff: "Staff", addStaff: "Add staff member", email: "Email", phone: "Phone",
    language: "Language", notifyBy: "Notify by", sms: "SMS", emailCh: "Email",
    roles: "Roles", managerOf: "Manager of", saved: "Saved",
    details: "Details", assignments: "Roles and responsibilities", noStaff: "No staff yet.",
    admin_flag: "Admin", weekHours: "h",
    coverage: "Day coverage", coverageWeek: "Week coverage", legendOk: "Target met", legendShort: "Short", legendOver: "Extra", legendNone: "No target",
    present: "Working", target: "Target", shortagesTitle: "Staffing gaps", surplusTitle: "Staffing surplus", tooMany: "too many", noShortagesWeek: "No staffing gaps this week.", noShortages: "No staffing gaps that day.",
    missingN: "short by", personsShort: "ppl", noTargetsYet: "No targets set. Configure them in Admin.",
    targets: "Staffing targets", targetsHelp: "How many employees you want at each time. Leave blank for no target.",
    allDays: "Every day", resetDay: "Remove this day’s own values", dayOverride: "Values specific to this day",
    closeTime: "Closing time", openTime: "Opening time", choosePhoto: "Choose a picture", removePhoto: "Remove picture", badImage: "Invalid image (JPEG, PNG or WebP).", photo: "Picture", colour: "Colour", autoColour: "Automatic colour", openTimes: "Opening time for each day of the week.", hoursTitle: "Opening hours", beforeOpen: "Before opening / after closing", closeSlot: "Close", closeHelp: "The “Close” target applies to the last hour before closing.",
    hasShiftsTitle: "This person has shifts with this role", hasShiftsBody: "shift(s) use this role. What should happen to them?",
    moveShiftsTo: "Move the shifts to", deleteShifts: "Delete these shifts", addRoleFirst: "Tip: tick the new role first, then untick the old one to move the shifts.",
    period: "Period", basePeriod: "Base (all year)", seasonWord: "Season", specialWord: "Special day", addSeason: "+ Season", addSpecial: "+ Special day",
    editPeriod: "Edit this period", deletePeriod: "Delete this period", confirmDeletePeriod: "Delete this period and its targets?",
    preset: "Template", customPreset: "Custom…", ruleType: "Date type", ruleDate: "One specific date (once)", ruleFixed: "Every year, same date",
    ruleNth: "Every year, a weekday of the month", ruleEaster: "Easter", fromLabel: "From", toLabel: "To", monthLabel: "Month", dayLabel: "Day",
    nthLabel: "Rank", weekdayLabel: "Weekday", lengthDays: "Number of days", last: "last", periodNameReq: "Give this period a name.",
    inheritNote: "Empty boxes keep the values of the base period. Only the numbers you enter replace the base.",
    weekdayOnly: "A specific weekday", easterRange: "Good Friday to Easter Monday", yearlyOn: "every year on", everyYear: "every year",
    effectiveFrom: "From", effectiveHelp: "Shifts before this date keep their old role (history).",
    roleChoiceBody: "This person already has another role at this restaurant. Do you want to add it as well, or replace the old role?",
    replace: "Replace", addAlso: "Add as well (they work both)",
    hourlyRate: "Hourly rate ($/h)", adminOnlyField: "Visible to administrators only.", payroll: "Payroll", costDept: "Department cost", costRestaurant: "Restaurant (all departments)",
    costDay: "This day", costWeek: "Week", hoursShort: "h", unratedHours: "h worked without an hourly rate (not included)", showHourlyCost: "Show cost per hour", hideHourlyCost: "Hide cost per hour", noRate: "No rate",
    adminRestaurants: "Restaurants and hours", adminTargets: "Staffing targets", adminStaff: "Employees",
    hoursHelp: "Opening and closing time for each day of the week. “Until close (F)” shifts follow the closing time of their day.",
    copyMonday: "Copy Monday to every day", opensBeforeCloses: "Each day, opening must be before closing.",
    zoomDay: "Zoom on this day", backToWeek: "Full week", prevDay: "Previous day", nextDay: "Next day", zoomHint: "Click a day to zoom in.",
    "dept.floor": "Floor", "dept.kitchen": "Kitchen", "dept.delivery": "Delivery",
    footer: "Toujours Mikes — schedule management",
  },
};

let lang = "fr";
try {
  const q = new URLSearchParams(location.search).get("lang");
  lang = dict[q] ? q : dict[localStorage.getItem("lang")] ? localStorage.getItem("lang") : "fr";
} catch { /* storage unavailable */ }

export const getLang = () => lang;
export function setLang(l) {
  lang = dict[l] ? l : "fr";
  try { localStorage.setItem("lang", lang); } catch { /* ignore */ }
  document.documentElement.lang = lang;
}
export const t = (key) => dict[lang][key] ?? dict.fr[key] ?? key;
export const locale = () => (lang === "fr" ? "fr-CA" : "en-CA");
// Role names come from the API as name_fr / name_en.
export const roleName = (r) => (lang === "fr" ? r.name_fr : r.name_en);
document.documentElement.lang = lang;
