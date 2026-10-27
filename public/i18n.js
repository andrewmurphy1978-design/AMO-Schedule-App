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
    noSchedules: "Aucun horaire disponible pour vous pour le moment.",
    viewOnly: "Lecture seule", canEdit: "Vous pouvez modifier cet horaire",
    restaurants: "Restaurants", addRestaurant: "Ajouter un restaurant", name: "Nom", add: "Ajouter",
    staff: "Employés", addStaff: "Ajouter un employé", email: "Courriel", phone: "Téléphone",
    language: "Langue", notifyBy: "Aviser par", sms: "SMS", emailCh: "Courriel",
    roles: "Rôles", managerOf: "Gestionnaire de", saved: "Enregistré",
    details: "Détails", assignments: "Rôles et responsabilités", noStaff: "Aucun employé.",
    admin_flag: "Admin", weekHours: "h",
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
    noSchedules: "No schedules available to you yet.",
    viewOnly: "View only", canEdit: "You can edit this schedule",
    restaurants: "Restaurants", addRestaurant: "Add a restaurant", name: "Name", add: "Add",
    staff: "Staff", addStaff: "Add staff member", email: "Email", phone: "Phone",
    language: "Language", notifyBy: "Notify by", sms: "SMS", emailCh: "Email",
    roles: "Roles", managerOf: "Manager of", saved: "Saved",
    details: "Details", assignments: "Roles and responsibilities", noStaff: "No staff yet.",
    admin_flag: "Admin", weekHours: "h",
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
