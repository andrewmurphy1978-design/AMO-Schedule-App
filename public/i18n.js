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
    present: "Présents", target: "Cible", shortagesTitle: "Manques de personnel", noShortages: "Aucun manque de personnel ce jour-là.",
    missingN: "il manque", personsShort: "pers.", noTargetsYet: "Aucune cible définie. Configurez-les dans Administration.",
    targets: "Cibles de personnel", targetsHelp: "Nombre d’employés souhaité à chaque heure. Laissez vide s’il n’y a pas de cible.",
    allDays: "Tous les jours", resetDay: "Retirer les valeurs propres à ce jour", dayOverride: "Valeurs propres à ce jour",
    closeTime: "Heure de fermeture", closeSlot: "Fermeture", closeHelp: "La cible « Fermeture » s’applique à la dernière heure avant la fermeture.",
    hasShiftsTitle: "Cette personne a des quarts avec ce rôle", hasShiftsBody: "quart(s) sont rattachés à ce rôle. Que voulez-vous en faire ?",
    moveShiftsTo: "Déplacer les quarts vers", deleteShifts: "Supprimer ces quarts", addRoleFirst: "Astuce : cochez d’abord le nouveau rôle, puis décochez l’ancien pour déplacer les quarts.",
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
    present: "Working", target: "Target", shortagesTitle: "Staffing gaps", noShortages: "No staffing gaps that day.",
    missingN: "short by", personsShort: "ppl", noTargetsYet: "No targets set. Configure them in Admin.",
    targets: "Staffing targets", targetsHelp: "How many employees you want at each time. Leave blank for no target.",
    allDays: "Every day", resetDay: "Remove this day’s own values", dayOverride: "Values specific to this day",
    closeTime: "Closing time", closeSlot: "Close", closeHelp: "The “Close” target applies to the last hour before closing.",
    hasShiftsTitle: "This person has shifts with this role", hasShiftsBody: "shift(s) use this role. What should happen to them?",
    moveShiftsTo: "Move the shifts to", deleteShifts: "Delete these shifts", addRoleFirst: "Tip: tick the new role first, then untick the old one to move the shifts.",
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
