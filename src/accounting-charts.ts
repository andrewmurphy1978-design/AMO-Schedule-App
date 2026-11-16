// Chart-of-accounts templates, one per kind of entity. Every entity gets its own copy when it is created; the
// user can add accounts but the system ones (sales tax, owner / shareholder relationships) stay.
//
// Tax-line references are a guide to where a balance lands on a return (T1 / T2125 for a Canadian sole
// proprietorship, Schedule C for a US single-member LLC) — confirm them with an accountant before filing.

export type AccType = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
export type EntityKind = "PERSONAL" | "SOLE_PROPRIETORSHIP" | "CORPORATION" | "LLC";

export interface ChartAccount {
  code: string;
  en: string;
  fr: string;
  type: AccType;
  subtype: string;
  taxLine?: string;
  deductiblePct?: number;
  system?: boolean;
  // Chart code of the account this one sits under (second level).
  parent?: string;
  // An opposite account (a loan that can flip between receivable and payable, a tax refund / amount owed...).
  twoWay?: boolean;
}

const a = (code: string, en: string, fr: string, type: AccType, subtype: string, taxLine?: string, extra: Partial<ChartAccount> = {}): ChartAccount => ({ code, en, fr, type, subtype, taxLine, ...extra });

// Sales taxes (Canada): GST/HST goes to the CRA, QST to Revenu Québec. Collected on sales = payable; paid on
// purchases = recoverable (input tax credits / input tax refunds). Remittances are plain payments to the payable accounts.
const CA_SALES_TAX: ChartAccount[] = [
  // Assets: refunds the government owes the business (when input tax credits exceed the tax collected). Not the ITCs.
  a("1300", "GST/HST receivable", "TPS/TVH à recevoir", "ASSET", "TAX_RECEIVABLE", "GST34 line 111", { system: true }),
  a("1310", "QST receivable", "TVQ à recevoir", "ASSET", "TAX_RECEIVABLE", "Revenu Québec QST return", { system: true }),
  // Liabilities: tax collected on sales (payable), with the input tax credits / refunds claimed on purchases below it.
  a("2300", "GST/HST payable", "TPS/TVH à payer", "LIABILITY", "TAX_PAYABLE", "GST34 line 103", { system: true }),
  a("2301", "GST/HST recoverable (input tax credits)", "TPS/TVH à recouvrer (crédits de taxe sur les intrants)", "LIABILITY", "TAX_RECOVERABLE", "GST34 line 106", { system: true, parent: "2300" }),
  a("2310", "QST payable", "TVQ à payer", "LIABILITY", "TAX_PAYABLE", "Revenu Québec QST return", { system: true }),
  a("2311", "QST recoverable (input tax refunds)", "TVQ à recouvrer (remboursements de taxe sur les intrants)", "LIABILITY", "TAX_RECOVERABLE", "Revenu Québec QST return", { system: true, parent: "2310" }),
];

const PERSONAL_CA: ChartAccount[] = [
  a("1200", "Tax-Free Savings Account (TFSA)", "Compte d'épargne libre d'impôt (CELI)", "ASSET", "INVESTMENT"),
  a("1210", "Registered Retirement Savings Plan (RRSP)", "Régime enregistré d'épargne-retraite (REER)", "ASSET", "INVESTMENT", "T1 line 20800 (RRSP deduction)"),
  a("1220", "First Home Savings Account (FHSA)", "Compte d'épargne libre d'impôt pour l'achat d'une première propriété (CELIAPP)", "ASSET", "INVESTMENT", "T1 line 20805 (FHSA deduction)"),
  a("1230", "Registered Education Savings Plan (RESP)", "Régime enregistré d'épargne-études (REEE)", "ASSET", "INVESTMENT"),
  a("1300", "Investments (non-registered)", "Placements (non enregistrés)", "ASSET", "INVESTMENT"),
  a("1400", "Principal residence", "Résidence principale", "ASSET", "FIXED_ASSET"),
  a("1410", "Vehicle", "Véhicule", "ASSET", "FIXED_ASSET"),
  a("1500", "Tax refunds receivable / income tax owed", "Remboursements d'impôt à recevoir / impôt à payer", "ASSET", "RECEIVABLE", undefined, { twoWay: true }),
  a("1510", "Loans to family & friends", "Prêts à la famille et aux amis", "ASSET", "RECEIVABLE", undefined, { twoWay: true }),
  a("2100", "Mortgage", "Hypothèque", "LIABILITY", "LOAN"),
  a("2110", "Car loan", "Prêt auto", "LIABILITY", "LOAN"),
  a("2120", "Line of credit", "Marge de crédit", "LIABILITY", "LOAN"),
  a("2130", "Student loan", "Prêt étudiant", "LIABILITY", "LOAN"),
  a("2200", "Income tax owing (CRA / Revenu Québec)", "Impôt à payer (ARC / Revenu Québec)", "LIABILITY", "TAX_PAYABLE"),
  a("3000", "Net worth (opening balance)", "Avoir net (solde d'ouverture)", "EQUITY", "EQUITY", undefined, { system: true }),
  a("4000", "Employment income", "Revenu d'emploi", "INCOME", "REVENUE", "T1 line 10100"),
  a("4010", "Child benefits (CCB / ACE)", "Allocations pour enfants (ACE / ACFE)", "INCOME", "REVENUE", "T1 line 11700 (benefits)"),
  a("4020", "EI / QPIP benefits", "Prestations d'AE / RQAP", "INCOME", "REVENUE", "T1 line 11900"),
  a("4100", "Interest income", "Revenu d'intérêts", "INCOME", "REVENUE", "T1 line 12100"),
  a("4110", "Dividends", "Dividendes", "INCOME", "REVENUE", "T1 line 12000"),
  a("4120", "Capital gains", "Gains en capital", "INCOME", "REVENUE", "T1 line 12700"),
  a("4200", "Rental income", "Revenus de location", "INCOME", "REVENUE", "T1 line 12600"),
  a("4900", "Other income", "Autres revenus", "INCOME", "REVENUE", "T1 line 13000"),
  a("5000", "Rent", "Loyer", "EXPENSE", "OPERATING"),
  a("5010", "Mortgage interest", "Intérêts hypothécaires", "EXPENSE", "OPERATING"),
  a("5020", "Property taxes", "Taxes foncières", "EXPENSE", "OPERATING"),
  a("5030", "Home insurance", "Assurance habitation", "EXPENSE", "OPERATING"),
  a("5040", "Electricity & heating", "Électricité et chauffage", "EXPENSE", "OPERATING"),
  a("5050", "Internet, phone & TV", "Internet, téléphone et télé", "EXPENSE", "OPERATING"),
  a("5100", "Groceries", "Épicerie", "EXPENSE", "OPERATING"),
  a("5110", "Restaurants & takeout", "Restaurants et commandes", "EXPENSE", "OPERATING"),
  a("5120", "Alcohol and cigarettes", "Alcool et cigarettes", "EXPENSE", "OPERATING"),
  a("5200", "Fuel", "Essence", "EXPENSE", "OPERATING"),
  a("5210", "Vehicle insurance & registration", "Assurance et immatriculation du véhicule", "EXPENSE", "OPERATING"),
  a("5220", "Vehicle maintenance & parking", "Entretien et stationnement", "EXPENSE", "OPERATING"),
  a("5230", "Public transit & taxis", "Transport en commun et taxis", "EXPENSE", "OPERATING"),
  a("5300", "Medical & dental", "Frais médicaux et dentaires", "EXPENSE", "OPERATING", "T1 line 33099 (medical expenses credit)"),
  a("5310", "Pharmacy", "Pharmacie", "EXPENSE", "OPERATING", "T1 line 33099 (medical expenses credit)"),
  a("5330", "Veterinarian expense", "Frais vétérinaires", "EXPENSE", "OPERATING"),
  a("5320", "Life & health insurance", "Assurance vie et maladie", "EXPENSE", "OPERATING"),
  a("5400", "Children (clothing, activities)", "Enfants (vêtements, activités)", "EXPENSE", "OPERATING"),
  a("5410", "Childcare", "Frais de garde", "EXPENSE", "OPERATING", "T1 line 21400 (child care expenses)"),
  a("5420", "Education & tuition", "Éducation et frais de scolarité", "EXPENSE", "OPERATING", "T1 tuition credit"),
  a("5500", "Clothing", "Vêtements", "EXPENSE", "OPERATING"),
  a("5510", "Personal care", "Soins personnels", "EXPENSE", "OPERATING"),
  a("5600", "Entertainment & leisure", "Divertissement et loisirs", "EXPENSE", "OPERATING"),
  a("5610", "Subscriptions", "Abonnements", "EXPENSE", "OPERATING"),
  a("5620", "Travel & vacation", "Voyages et vacances", "EXPENSE", "OPERATING"),
  a("5700", "Gifts", "Cadeaux", "EXPENSE", "OPERATING"),
  a("5710", "Charitable donations", "Dons de bienfaisance", "EXPENSE", "OPERATING", "T1 line 34900 (donations credit)"),
  a("5800", "Bank fees & interest", "Frais bancaires et intérêts", "EXPENSE", "OPERATING"),
  a("5990", "Other personal expenses", "Autres dépenses personnelles", "EXPENSE", "OPERATING"),
];

const SOLE_PROP_CA: ChartAccount[] = [
  a("1100", "Accounts receivable", "Comptes clients", "ASSET", "RECEIVABLE"),
  a("1200", "Prepaid expenses", "Charges payées d'avance", "ASSET", "OTHER"),
  a("1210", "Loans to affiliates & others", "Prêts aux entreprises liées et autres", "ASSET", "RECEIVABLE", undefined, { twoWay: true }),
  ...CA_SALES_TAX.filter((x) => x.type === "ASSET"),
  a("1500", "Computer equipment (CCA class 50)", "Matériel informatique (DPA catégorie 50)", "ASSET", "FIXED_ASSET"),
  a("1510", "Furniture & fixtures (CCA class 8)", "Mobilier et agencements (DPA catégorie 8)", "ASSET", "FIXED_ASSET"),
  a("1590", "Accumulated capital cost allowance", "Déduction pour amortissement cumulée", "ASSET", "FIXED_ASSET"),
  a("1520", "Intangible assets (website, software, trademarks)", "Actifs incorporels (site web, logiciels, marques)", "ASSET", "INTANGIBLE"),
  a("1595", "Accumulated amortization — intangibles", "Amortissement cumulé — actifs incorporels", "ASSET", "INTANGIBLE"),
  a("2000", "Accounts payable", "Comptes fournisseurs", "LIABILITY", "PAYABLE"),
  ...CA_SALES_TAX.filter((x) => x.type === "LIABILITY"),
  a("2500", "Business loan / line of credit", "Prêt / marge de crédit d'entreprise", "LIABILITY", "LOAN"),
  a("3000", "Owner's capital (opening balance)", "Capital du propriétaire (solde d'ouverture)", "EQUITY", "EQUITY", undefined, { system: true }),
  a("4000", "Service revenue", "Revenus de services", "INCOME", "REVENUE", "T2125 line 8000"),
  a("4010", "Affiliate commissions", "Commissions d'affiliation", "INCOME", "REVENUE", "T2125 line 8000"),
  a("4020", "Courses, coaching & consulting", "Cours, coaching et consultation", "INCOME", "REVENUE", "T2125 line 8000"),
  a("4900", "Other business income", "Autres revenus d'entreprise", "INCOME", "REVENUE", "T2125 line 8230"),
  a("5000", "Purchases & cost of goods", "Achats et coût des marchandises", "EXPENSE", "COGS", "T2125 line 8320"),
  a("5010", "Subcontracts", "Sous-traitance", "EXPENSE", "COGS", "T2125 line 8360"),
  a("6010", "Advertising", "Publicité", "EXPENSE", "OPERATING", "T2125 line 8521"),
  a("6020", "Meals & entertainment (50% deductible)", "Repas et divertissement (50 % déductible)", "EXPENSE", "OPERATING", "T2125 line 8523", { deductiblePct: 50 }),
  a("6030", "Bad debts", "Créances irrécouvrables", "EXPENSE", "OPERATING", "T2125 line 8590"),
  a("6040", "Insurance", "Assurances", "EXPENSE", "OPERATING", "T2125 line 8690"),
  a("6050", "Interest & bank charges", "Intérêts et frais bancaires", "EXPENSE", "OPERATING", "T2125 line 8710"),
  a("6060", "Business taxes, licences & memberships", "Taxes d'affaires, permis et cotisations", "EXPENSE", "OPERATING", "T2125 line 8760"),
  a("6070", "Office expenses", "Frais de bureau", "EXPENSE", "OPERATING", "T2125 line 8810"),
  a("6075", "Software & online subscriptions", "Logiciels et abonnements en ligne", "EXPENSE", "OPERATING", "T2125 line 8810"),
  a("6080", "Office stationery & supplies", "Papeterie et fournitures", "EXPENSE", "OPERATING", "T2125 line 8811"),
  a("6090", "Professional fees (legal, accounting)", "Honoraires professionnels (juridique, comptable)", "EXPENSE", "OPERATING", "T2125 line 8860"),
  a("6100", "Management & administration fees", "Frais de gestion et d'administration", "EXPENSE", "OPERATING", "T2125 line 8871"),
  a("6110", "Rent", "Loyer", "EXPENSE", "OPERATING", "T2125 line 8910"),
  a("6120", "Repairs & maintenance", "Réparations et entretien", "EXPENSE", "OPERATING", "T2125 line 8960"),
  a("6130", "Salaries, wages & benefits", "Salaires, traitements et avantages", "EXPENSE", "OPERATING", "T2125 line 9060"),
  a("6150", "Travel", "Frais de déplacement", "EXPENSE", "OPERATING", "T2125 line 9200"),
  a("6160", "Telephone & utilities", "Téléphone et services publics", "EXPENSE", "OPERATING", "T2125 line 9220"),
  a("6180", "Delivery, freight & express", "Livraison, fret et messagerie", "EXPENSE", "OPERATING", "T2125 line 9275"),
  a("6190", "Motor vehicle expenses", "Frais de véhicule à moteur", "EXPENSE", "OPERATING", "T2125 line 9281"),
  a("6200", "Business-use-of-home", "Frais d'utilisation de la maison", "EXPENSE", "OPERATING", "T2125 line 9945"),
  a("6210", "Capital cost allowance (CCA)", "Déduction pour amortissement (DPA)", "EXPENSE", "OPERATING", "T2125 line 9936"),
  a("6900", "Other expenses (training, fees…)", "Autres dépenses (formation, frais…)", "EXPENSE", "OPERATING", "T2125 line 9270"),
];

const CORP_CA: ChartAccount[] = [
  a("1100", "Accounts receivable", "Comptes clients", "ASSET", "RECEIVABLE"),
  a("1200", "Prepaid expenses", "Charges payées d'avance", "ASSET", "OTHER"),
  a("1210", "Loans to affiliates & others", "Prêts aux entreprises liées et autres", "ASSET", "RECEIVABLE", undefined, { twoWay: true }),
  ...CA_SALES_TAX.filter((x) => x.type === "ASSET"),
  a("1500", "Computer equipment (CCA class 50)", "Matériel informatique (DPA catégorie 50)", "ASSET", "FIXED_ASSET"),
  a("1510", "Furniture & fixtures (CCA class 8)", "Mobilier et agencements (DPA catégorie 8)", "ASSET", "FIXED_ASSET"),
  a("1590", "Accumulated amortization", "Amortissement cumulé", "ASSET", "FIXED_ASSET"),
  a("1520", "Intangible assets (website, software, trademarks)", "Actifs incorporels (site web, logiciels, marques)", "ASSET", "INTANGIBLE"),
  a("1595", "Accumulated amortization — intangibles", "Amortissement cumulé — actifs incorporels", "ASSET", "INTANGIBLE"),
  a("2000", "Accounts payable", "Comptes fournisseurs", "LIABILITY", "PAYABLE"),
  ...CA_SALES_TAX.filter((x) => x.type === "LIABILITY"),
  a("2400", "Corporate income taxes payable / refundable", "Impôts des sociétés à payer / à recevoir", "LIABILITY", "TAX_PAYABLE", undefined, { twoWay: true }),
  a("2410", "Payroll deductions payable (source deductions)", "Retenues à la source à payer", "LIABILITY", "TAX_PAYABLE"),
  a("2420", "Dividends payable", "Dividendes à payer", "LIABILITY", "PAYABLE"),
  a("2500", "Business loan / line of credit", "Prêt / marge de crédit d'entreprise", "LIABILITY", "LOAN"),
  a("3000", "Share capital", "Capital-actions", "EQUITY", "EQUITY", undefined, { system: true }),
  a("3200", "Retained earnings (opening)", "Bénéfices non répartis (ouverture)", "EQUITY", "EQUITY", undefined, { system: true }),
  a("3300", "Dividends declared", "Dividendes déclarés", "EQUITY", "EQUITY"),
  a("4000", "Sales / service revenue", "Ventes / revenus de services", "INCOME", "REVENUE", "GIFI: trade sales of goods and services"),
  a("4900", "Other income", "Autres revenus", "INCOME", "REVENUE", "GIFI: other revenue"),
  a("5000", "Cost of goods sold / purchases", "Coût des marchandises vendues / achats", "EXPENSE", "COGS", "GIFI: purchases / cost of sales"),
  a("5010", "Subcontracts", "Sous-traitance", "EXPENSE", "COGS", "GIFI: subcontracts"),
  a("6010", "Advertising & promotion", "Publicité et promotion", "EXPENSE", "OPERATING", "GIFI: advertising and promotion"),
  a("6020", "Meals & entertainment (50% deductible)", "Repas et divertissement (50 % déductible)", "EXPENSE", "OPERATING", "GIFI: meals and entertainment", { deductiblePct: 50 }),
  a("6040", "Insurance", "Assurances", "EXPENSE", "OPERATING", "GIFI: insurance"),
  a("6050", "Interest & bank charges", "Intérêts et frais bancaires", "EXPENSE", "OPERATING", "GIFI: interest and bank charges"),
  a("6060", "Business taxes, licences & memberships", "Taxes d'affaires, permis et cotisations", "EXPENSE", "OPERATING", "GIFI: business taxes, licences and memberships"),
  a("6070", "Office expenses", "Frais de bureau", "EXPENSE", "OPERATING", "GIFI: office expenses"),
  a("6075", "Software & online subscriptions", "Logiciels et abonnements en ligne", "EXPENSE", "OPERATING", "GIFI: office expenses"),
  a("6090", "Professional fees (legal, accounting)", "Honoraires professionnels (juridique, comptable)", "EXPENSE", "OPERATING", "GIFI: professional fees"),
  a("6110", "Rent", "Loyer", "EXPENSE", "OPERATING", "GIFI: rent"),
  a("6120", "Repairs & maintenance", "Réparations et entretien", "EXPENSE", "OPERATING", "GIFI: repairs and maintenance"),
  a("6130", "Salaries & wages", "Salaires et traitements", "EXPENSE", "OPERATING", "GIFI: salaries and wages"),
  a("6135", "Employer payroll contributions", "Cotisations de l'employeur", "EXPENSE", "OPERATING", "GIFI: employer contributions"),
  a("6150", "Travel", "Frais de déplacement", "EXPENSE", "OPERATING", "GIFI: travel"),
  a("6160", "Telephone & utilities", "Téléphone et services publics", "EXPENSE", "OPERATING", "GIFI: utilities"),
  a("6190", "Motor vehicle expenses", "Frais de véhicule à moteur", "EXPENSE", "OPERATING", "GIFI: motor vehicle expenses"),
  a("6210", "Amortization / CCA", "Amortissement / DPA", "EXPENSE", "OPERATING", "GIFI: amortization"),
  a("6900", "Other expenses", "Autres dépenses", "EXPENSE", "OPERATING", "GIFI: other expenses"),
  a("7000", "Corporate income tax expense", "Charge d'impôts des sociétés", "EXPENSE", "OPERATING", "GIFI: income taxes"),
];

const LLC_US: ChartAccount[] = [
  a("1100", "Accounts receivable", "Comptes clients", "ASSET", "RECEIVABLE"),
  a("1200", "Prepaid expenses", "Charges payées d'avance", "ASSET", "OTHER"),
  a("1210", "Loans to affiliates & others", "Prêts aux entreprises liées et autres", "ASSET", "RECEIVABLE", undefined, { twoWay: true }),
  a("1500", "Equipment", "Équipement", "ASSET", "FIXED_ASSET"),
  a("1590", "Accumulated depreciation", "Amortissement cumulé", "ASSET", "FIXED_ASSET"),
  a("1520", "Intangible assets (website, software, trademarks)", "Actifs incorporels (site web, logiciels, marques)", "ASSET", "INTANGIBLE"),
  a("1595", "Accumulated amortization — intangibles", "Amortissement cumulé — actifs incorporels", "ASSET", "INTANGIBLE"),
  a("2000", "Accounts payable", "Comptes fournisseurs", "LIABILITY", "PAYABLE"),
  a("2200", "Sales tax payable (state)", "Taxe de vente à payer (État)", "LIABILITY", "TAX_PAYABLE"),
  a("2500", "Loans payable", "Emprunts à payer", "LIABILITY", "LOAN"),
  a("3000", "Member's capital (opening balance)", "Capital du membre (solde d'ouverture)", "EQUITY", "EQUITY", undefined, { system: true }),
  a("4000", "Gross receipts or sales", "Recettes brutes ou ventes", "INCOME", "REVENUE", "Schedule C line 1"),
  a("4900", "Other income", "Autres revenus", "INCOME", "REVENUE", "Schedule C line 6"),
  a("5000", "Cost of goods sold", "Coût des marchandises vendues", "EXPENSE", "COGS", "Schedule C line 4"),
  a("6010", "Advertising", "Publicité", "EXPENSE", "OPERATING", "Schedule C line 8"),
  a("6020", "Car & truck expenses", "Frais de voiture et camion", "EXPENSE", "OPERATING", "Schedule C line 9"),
  a("6030", "Commissions & fees", "Commissions et frais", "EXPENSE", "OPERATING", "Schedule C line 10"),
  a("6040", "Contract labor", "Main-d'œuvre contractuelle", "EXPENSE", "OPERATING", "Schedule C line 11"),
  a("6050", "Depreciation", "Amortissement", "EXPENSE", "OPERATING", "Schedule C line 13"),
  a("6060", "Employee benefit programs", "Avantages sociaux", "EXPENSE", "OPERATING", "Schedule C line 14"),
  a("6070", "Insurance (other than health)", "Assurances (autres que santé)", "EXPENSE", "OPERATING", "Schedule C line 15"),
  a("6080", "Interest — mortgage", "Intérêts — hypothèque", "EXPENSE", "OPERATING", "Schedule C line 16a"),
  a("6090", "Interest — other", "Intérêts — autres", "EXPENSE", "OPERATING", "Schedule C line 16b"),
  a("6100", "Legal & professional services", "Services juridiques et professionnels", "EXPENSE", "OPERATING", "Schedule C line 17"),
  a("6110", "Office expense", "Frais de bureau", "EXPENSE", "OPERATING", "Schedule C line 18"),
  a("6120", "Pension & profit-sharing plans", "Régimes de retraite", "EXPENSE", "OPERATING", "Schedule C line 19"),
  a("6130", "Rent — vehicles, machinery & equipment", "Location — véhicules et équipement", "EXPENSE", "OPERATING", "Schedule C line 20a"),
  a("6140", "Rent — other business property", "Location — autres biens", "EXPENSE", "OPERATING", "Schedule C line 20b"),
  a("6150", "Repairs & maintenance", "Réparations et entretien", "EXPENSE", "OPERATING", "Schedule C line 21"),
  a("6160", "Supplies", "Fournitures", "EXPENSE", "OPERATING", "Schedule C line 22"),
  a("6170", "Taxes & licenses", "Taxes et permis", "EXPENSE", "OPERATING", "Schedule C line 23"),
  a("6180", "Travel", "Déplacements", "EXPENSE", "OPERATING", "Schedule C line 24a"),
  a("6190", "Meals (50% deductible)", "Repas (50 % déductible)", "EXPENSE", "OPERATING", "Schedule C line 24b", { deductiblePct: 50 }),
  a("6200", "Utilities", "Services publics", "EXPENSE", "OPERATING", "Schedule C line 25"),
  a("6210", "Wages", "Salaires", "EXPENSE", "OPERATING", "Schedule C line 26"),
  a("6220", "Other expenses (software, bank fees…)", "Autres dépenses (logiciels, frais bancaires…)", "EXPENSE", "OPERATING", "Schedule C line 27a"),
  a("6230", "Business use of home", "Utilisation de la maison à des fins d'affaires", "EXPENSE", "OPERATING", "Schedule C line 30"),
];

export function chartFor(kind: EntityKind, country: string): ChartAccount[] {
  if (kind === "PERSONAL") return PERSONAL_CA;
  if (kind === "SOLE_PROPRIETORSHIP") return SOLE_PROP_CA;
  if (kind === "CORPORATION") return CORP_CA;
  return country === "US" ? LLC_US : SOLE_PROP_CA;
}

// Defaults for a new entity of each kind.
export function entityDefaults(kind: EntityKind): { country: string; currency: string; basis: string } {
  if (kind === "LLC") return { country: "US", currency: "USD", basis: "CASH" };
  if (kind === "CORPORATION") return { country: "CA", currency: "CAD", basis: "ACCRUAL" };
  return { country: "CA", currency: "CAD", basis: "CASH" };
}

// The account (in `entity`'s books) that stands for the relationship with `other`: what the owner put in or took
// out of a sole proprietorship / LLC (equity), the shareholder loan of a corporation, an amount due to / from
// another entity. Created the first time money moves between the two.
export function intercoSpec(entity: { kind: EntityKind }, other: { kind: EntityKind; name: string }): { code: string; en: string; fr: string; type: AccType; subtype: string; unique: boolean } {
  const ownerLike = entity.kind === "SOLE_PROPRIETORSHIP" || entity.kind === "LLC";
  if (ownerLike && other.kind === "PERSONAL") {
    return { code: "3100", en: entity.kind === "LLC" ? "Member contributions & draws" : "Owner contributions & draws", fr: entity.kind === "LLC" ? "Apports et retraits du membre" : "Apports et retraits du propriétaire", type: "EQUITY", subtype: "OWNER_CAPITAL", unique: true };
  }
  if (entity.kind === "CORPORATION" && other.kind === "PERSONAL") {
    return { code: "2100", en: "Due to / from shareholder", fr: "Dû à / par l'actionnaire", type: "LIABILITY", subtype: "SHAREHOLDER_LOAN", unique: true };
  }
  if (entity.kind === "PERSONAL") {
    const asset = other.kind === "CORPORATION" ? `Loan to ${other.name}` : `Investment in ${other.name}`;
    const assetFr = other.kind === "CORPORATION" ? `Prêt à ${other.name}` : `Investissement dans ${other.name}`;
    // The owner's own sole proprietorship / disregarded LLC is the same person: an investment, never a debt.
    const sameOwner = other.kind === "SOLE_PROPRIETORSHIP" || other.kind === "LLC";
    return { code: "", en: asset, fr: assetFr, type: "ASSET", subtype: sameOwner ? "OWNER_INVESTMENT" : "INTERCO", unique: false };
  }
  return { code: "", en: `Due to / from ${other.name}`, fr: `Dû à / par ${other.name}`, type: "LIABILITY", subtype: "INTERCO", unique: false };
}

// Balance-sheet side of an account that can go either way (shareholder loan, due to / from).
export function isTwoWay(subtype: string): boolean {
  return subtype === "SHAREHOLDER_LOAN" || subtype === "INTERCO";
}

// ---------------------------------------------------------------- balance-sheet sections

export type AssetSection = "TREASURY" | "CURRENT" | "LONG_TERM" | "FIXED" | "INTANGIBLE";
export type LiabilitySection = "SHORT_TERM" | "LONG_TERM";

export const ASSET_SECTIONS: { key: AssetSection; en: string; fr: string }[] = [
  { key: "TREASURY", en: "Treasury", fr: "Trésorerie" },
  { key: "CURRENT", en: "Other current assets", fr: "Autres actifs à court terme" },
  { key: "LONG_TERM", en: "Long-term assets", fr: "Actifs à long terme" },
  { key: "FIXED", en: "Fixed assets", fr: "Immobilisations" },
  { key: "INTANGIBLE", en: "Intangible assets", fr: "Actifs incorporels" },
];
export const LIABILITY_SECTIONS: { key: LiabilitySection; en: string; fr: string }[] = [
  { key: "SHORT_TERM", en: "Short-term liabilities", fr: "Passifs à court terme" },
  { key: "LONG_TERM", en: "Long-term liabilities", fr: "Passifs à long terme" },
];

/** The section an account falls in unless the user chose another one. */
export function defaultSection(type: string, subtype: string): string | null {
  if (type === "ASSET") {
    if (subtype === "BANK") return "TREASURY";
    if (subtype === "INVESTMENT") return "LONG_TERM";
    if (subtype === "FIXED_ASSET") return "FIXED";
    if (subtype === "INTANGIBLE") return "INTANGIBLE";
    return "CURRENT";
  }
  if (type === "LIABILITY") return subtype === "LOAN" ? "LONG_TERM" : "SHORT_TERM";
  return null;
}

// ---------------------------------------------------------------- GIFI (Canadian corporations)

// Suggested General Index of Financial Information codes (CRA, Schedules 100 / 125) for the corporation chart, by
// chart code. Filled in from the schedules; the CRA's RC4088 guide (Appendix A) is the reference, so verify them
// with your accountant and edit any in Setup. Accounts without a clear code are left empty.
export const CORP_GIFI: Record<string, string> = {
  "1100": "1060",
  "1510": "1740",
  "2000": "2600",
  "2400": "2680",
  "3000": "3500",
  "3200": "3600",
  "4000": "8000",
  "4900": "8230",
  "5000": "8320",
  "5010": "8518",
  "6010": "8521",
  "6020": "8523",
  "6040": "8690",
  "6050": "8710",
  "6060": "8760",
  "6070": "8810",
  "6075": "8810",
  "6090": "8860",
  "6110": "8910",
  "6120": "8960",
  "6130": "9060",
  "6150": "9200",
  "6160": "9220",
  "6190": "9281",
  "6210": "8670",
  "6900": "9270",
  "7000": "9990",
};

const GIFI_BY_NAME: [RegExp, string, AccType?][] = [
  [/accounts receivable/i, "1060"],
  [/savings/i, "1003", "ASSET"],
  [/accumulated/i, ""],
  [/furniture|equipment/i, "1740", "ASSET"],
  [/accounts payable/i, "2600"],
  [/income taxes? payable/i, "2680"],
  [/share capital/i, "3500"],
  [/retained earnings/i, "3600"],
  [/interest income|investment income/i, "8090", "INCOME"],
  [/other (business )?(income|revenue)/i, "8230", "INCOME"],
  [/revenue|sales|commissions|coaching|consulting|courses|services/i, "8000", "INCOME"],
  [/management/i, "8871", "EXPENSE"],
  [/subcontract/i, "8518", "EXPENSE"],
  [/cost of goods|purchases/i, "8320", "EXPENSE"],
  [/advertising|marketing|promotion/i, "8521", "EXPENSE"],
  [/meals/i, "8523", "EXPENSE"],
  [/bad debt/i, "8590", "EXPENSE"],
  [/amortization|depreciation|\bCCA\b/i, "8670", "EXPENSE"],
  [/insurance/i, "8690", "EXPENSE"],
  [/interest|bank (fees|charges)/i, "8710", "EXPENSE"],
  [/business taxes|licen[cs]es?|memberships/i, "8760", "EXPENSE"],
  [/office supplies|stationery/i, "8811", "EXPENSE"],
  [/office|software|subscriptions/i, "8810", "EXPENSE"],
  [/professional|legal|accounting/i, "8860", "EXPENSE"],
  [/rent/i, "8910", "EXPENSE"],
  [/repairs|maintenance/i, "8960", "EXPENSE"],
  [/salaries|wages/i, "9060", "EXPENSE"],
  [/delivery|freight|shipping/i, "9275", "EXPENSE"],
  [/travel/i, "9200", "EXPENSE"],
  [/telephone|phone|internet|utilities/i, "9220", "EXPENSE"],
  [/vehicle|motor/i, "9281", "EXPENSE"],
  [/income tax/i, "9990", "EXPENSE"],
  [/other (business )?expenses/i, "9270", "EXPENSE"],
];

/** A suggested GIFI code for an account of a Canadian business, from its chart code (corporations) or its name. */
export function suggestGifi(entityKind: string, a: { code: string; name: string; type: string; subtype: string }): string | null {
  if (a.subtype === "GROUP") return null;
  if (a.type === "EQUITY" && !/share capital|retained/i.test(a.name)) return null;
  if (entityKind === "CORPORATION" && CORP_GIFI[a.code]) return CORP_GIFI[a.code];
  if (a.subtype === "BANK") return "1002";
  if (a.subtype === "CREDIT_CARD" || a.subtype === "INTERCO" || a.subtype === "SHAREHOLDER_LOAN" || a.subtype === "OWNER_CAPITAL") return null;
  for (const [re, code, type] of GIFI_BY_NAME) {
    if (!re.test(a.name)) continue;
    if (type && type !== a.type) continue;
    return code || null;
  }
  return null;
}

/** GIFI applies to the Canadian business entities (not the personal books, not a US LLC). */
export function usesGifi(kind: string, country: string): boolean {
  return country === "CA" && (kind === "CORPORATION" || kind === "SOLE_PROPRIETORSHIP");
}

// ---------------------------------------------------------------- registered & investment accounts

export const REGISTERED_TYPES: Record<string, { en: string; fr: string }> = {
  TFSA: { en: "TFSA (Tax-Free Savings Account)", fr: "CELI (compte d'épargne libre d'impôt)" },
  RRSP: { en: "RRSP (Registered Retirement Savings Plan)", fr: "REER (régime enregistré d'épargne-retraite)" },
  FHSA: { en: "FHSA (First Home Savings Account)", fr: "CELIAPP (compte d'épargne libre d'impôt pour l'achat d'une première propriété)" },
  RESP: { en: "RESP (Registered Education Savings Plan)", fr: "REEE (régime enregistré d'épargne-études)" },
  NON_REG: { en: "Investment account (non-registered)", fr: "Compte de placement (non enregistré)" },
  LIRA: { en: "LIRA / Lock-in RRSP (Locked-In Retirement Account)", fr: "CRI / REER immobilisé (compte de retraite immobilisé)" },
  RRIF: { en: "RRIF (Registered Retirement Income Fund)", fr: "FERR (fonds enregistré de revenu de retraite)" },
  LIF: { en: "LIF (Life Income Fund / lock-in fund)", fr: "FRV (fonds de revenu viager)" },
};

// Earlier versions of the Personal chart mixed English and French in one name: these are replaced in existing books.
export const LEGACY_NAME_FIXES: Record<string, { oldName: string; en: string; fr: string }> = {
  "1200": { oldName: "TFSA (CELI)", en: "Tax-Free Savings Account (TFSA)", fr: "Compte d'épargne libre d'impôt (CELI)" },
  "1210": { oldName: "RRSP (REER)", en: "Registered Retirement Savings Plan (RRSP)", fr: "Régime enregistré d'épargne-retraite (REER)" },
  "1220": { oldName: "FHSA (CELIAPP)", en: "First Home Savings Account (FHSA)", fr: "Compte d'épargne libre d'impôt pour l'achat d'une première propriété (CELIAPP)" },
  "1230": { oldName: "RESP (REEE)", en: "Registered Education Savings Plan (RESP)", fr: "Régime enregistré d'épargne-études (REEE)" },
};

// ---------------------------------------------------------------- income / expense sub-categories

// Second-level grouping of the income and expense accounts: a group is a header account (subtype GROUP, never posted
// to) with the accounts that belong under it. Groups are added to existing books once; after that the user's own
// choices are left alone.
export interface ChartGroup {
  code: string;
  en: string;
  fr: string;
  type: "INCOME" | "EXPENSE";
  members: string[];
}

const BUSINESS_GROUPS: ChartGroup[] = [
  { code: "4950", en: "Sales & service revenue", fr: "Ventes et revenus de services", type: "INCOME", members: ["4000", "4010", "4020"] },
  { code: "4960", en: "Other income", fr: "Autres revenus", type: "INCOME", members: ["4900"] },
  { code: "6800", en: "Cost of sales", fr: "Coût des ventes", type: "EXPENSE", members: ["5000", "5010"] },
  { code: "6810", en: "Advertising, meals & entertainment", fr: "Publicité, repas et divertissement", type: "EXPENSE", members: ["6010", "6020"] },
  { code: "6820", en: "Office & technology", fr: "Bureau et technologie", type: "EXPENSE", members: ["6070", "6075", "6080"] },
  { code: "6830", en: "Professional & management fees", fr: "Honoraires professionnels et de gestion", type: "EXPENSE", members: ["6090", "6100"] },
  { code: "6840", en: "Premises, repairs & utilities", fr: "Locaux, réparations et services publics", type: "EXPENSE", members: ["6110", "6120", "6160", "6200"] },
  { code: "6850", en: "Payroll", fr: "Masse salariale", type: "EXPENSE", members: ["6130", "6135"] },
  { code: "6860", en: "Travel, vehicle & delivery", fr: "Déplacements, véhicule et livraison", type: "EXPENSE", members: ["6150", "6180", "6190"] },
  { code: "6870", en: "Insurance, financial & taxes", fr: "Assurances, frais financiers et taxes", type: "EXPENSE", members: ["6030", "6040", "6050", "6060", "7000"] },
  { code: "6880", en: "Amortization", fr: "Amortissement", type: "EXPENSE", members: ["6210"] },
  { code: "6890", en: "Other expenses", fr: "Autres dépenses", type: "EXPENSE", members: ["6900"] },
];

const PERSONAL_GROUPS: ChartGroup[] = [
  { code: "4950", en: "Employment & benefits", fr: "Emploi et prestations", type: "INCOME", members: ["4000", "4010", "4020"] },
  { code: "4960", en: "Investment & rental income", fr: "Revenus de placement et de location", type: "INCOME", members: ["4100", "4110", "4120", "4200"] },
  { code: "4970", en: "Other income", fr: "Autres revenus", type: "INCOME", members: ["4900"] },
  { code: "5900", en: "Housing", fr: "Habitation", type: "EXPENSE", members: ["5000", "5010", "5020", "5030", "5040", "5050"] },
  { code: "5910", en: "Food & drink", fr: "Alimentation", type: "EXPENSE", members: ["5100", "5110", "5120"] },
  { code: "5920", en: "Transportation", fr: "Transport", type: "EXPENSE", members: ["5200", "5210", "5220", "5230"] },
  { code: "5930", en: "Health, pets & insurance", fr: "Santé, animaux et assurances", type: "EXPENSE", members: ["5300", "5310", "5320", "5330"] },
  { code: "5940", en: "Family & education", fr: "Famille et éducation", type: "EXPENSE", members: ["5400", "5410", "5420"] },
  { code: "5950", en: "Lifestyle & leisure", fr: "Mode de vie et loisirs", type: "EXPENSE", members: ["5500", "5510", "5600", "5610", "5620", "5700", "5710"] },
  { code: "5960", en: "Financial & other", fr: "Frais financiers et autres", type: "EXPENSE", members: ["5800", "5990"] },
];

const LLC_GROUPS: ChartGroup[] = [
  { code: "4950", en: "Sales", fr: "Ventes", type: "INCOME", members: ["4000"] },
  { code: "4960", en: "Other income", fr: "Autres revenus", type: "INCOME", members: ["4900"] },
  { code: "6800", en: "Cost of goods sold", fr: "Coût des marchandises vendues", type: "EXPENSE", members: ["5000"] },
  { code: "6810", en: "Advertising, commissions & meals", fr: "Publicité, commissions et repas", type: "EXPENSE", members: ["6010", "6030", "6190"] },
  { code: "6820", en: "Office & supplies", fr: "Bureau et fournitures", type: "EXPENSE", members: ["6110", "6160"] },
  { code: "6830", en: "Professional & contract services", fr: "Services professionnels et contractuels", type: "EXPENSE", members: ["6040", "6100"] },
  { code: "6840", en: "Rent, utilities & property", fr: "Loyer, services publics et immeuble", type: "EXPENSE", members: ["6130", "6140", "6150", "6200", "6230"] },
  { code: "6850", en: "Payroll & benefits", fr: "Masse salariale et avantages", type: "EXPENSE", members: ["6060", "6120", "6210"] },
  { code: "6860", en: "Travel & vehicle", fr: "Déplacements et véhicule", type: "EXPENSE", members: ["6020", "6180"] },
  { code: "6870", en: "Insurance, interest & taxes", fr: "Assurances, intérêts et taxes", type: "EXPENSE", members: ["6070", "6080", "6090", "6170"] },
  { code: "6880", en: "Depreciation", fr: "Amortissement", type: "EXPENSE", members: ["6050"] },
  { code: "6890", en: "Other expenses", fr: "Autres dépenses", type: "EXPENSE", members: ["6220"] },
];

export function groupsFor(kind: EntityKind, country: string): ChartGroup[] {
  if (kind === "PERSONAL") return PERSONAL_GROUPS;
  if (kind === "LLC" && country === "US") return LLC_GROUPS;
  return BUSINESS_GROUPS;
}
