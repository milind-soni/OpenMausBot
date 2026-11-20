// Deterministic seed for Desk ATS: a busy desk of fictional requirements, candidates and vendors, tuned so REQ-1042
// (delivered live) has 20–25 strong matches and a clear top 3. Run directly to write data/seed.json.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { keywordScore } from "../src/rank.ts";
import type {
  Board, Candidate, DeskState, EmailDraft, Interview, Onboarding, PipelineEntry, Requirement, ScreenAnswers, Source, Stage,
  Timesheet, Vendor, WorkAuth,
} from "../src/types.ts";
import { DESK_EMAIL, HERO_REQUIREMENT, heroClientEmail, TOP_THREE, workAuthDocs } from "./hero.ts";

export { HERO_REQUIREMENT };

const HERO_NAMES = new Set(TOP_THREE.map((c) => c.name));
const BASE_TIME = Date.UTC(2026, 9, 23, 14, 0); // Fri 23 Oct 2026, 9:00 CT
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = [
  "Aarav", "Priya", "Rohit", "Sneha", "Vikram", "Anjali", "Rahul", "Deepa", "Arjun", "Meera", "Sanjay", "Lakshmi", "Nikhil", "Pooja",
  "Ravi", "Divya", "Suresh", "Kavya", "Manoj", "Swathi", "James", "Emily", "Michael", "Sarah", "David", "Jessica", "Daniel", "Ashley",
  "Chris", "Megan", "Brian", "Lauren", "Kevin", "Rachel", "Jason", "Nicole", "Carlos", "Maria", "Luis", "Sofia", "Diego", "Valeria",
  "Miguel", "Camila", "Wei", "Mei", "Jun", "Hana", "Min-jun", "Ji-woo", "Tuan", "Linh", "Kwame", "Amara", "Tunde", "Zainab", "Omar",
  "Layla", "Yusuf", "Fatima", "Dmitri", "Elena", "Andrei", "Olga", "Tomás", "Lucía", "Hiro", "Yuki", "Kofi", "Ama",
];
const LAST = [
  "Sharma", "Patel", "Reddy", "Iyer", "Nair", "Gupta", "Kumar", "Menon", "Rao", "Desai", "Joshi", "Pillai", "Varma", "Chopra",
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Wilson", "Anderson", "Taylor", "Thomas", "Moore", "Martin",
  "Jackson", "Garcia", "Martinez", "Rodriguez", "Hernandez", "Lopez", "Gonzalez", "Perez", "Ramirez", "Chen", "Wang", "Li", "Zhang",
  "Liu", "Kim", "Park", "Nguyen", "Tran", "Okafor", "Mensah", "Adeyemi", "Hassan", "Haddad", "Khan", "Ivanov", "Petrova", "Silva",
  "Costa", "Tanaka", "Sato", "Boateng", "Mbeki", "Novak",
];

const TX_OTHER = ["Irving, TX", "Plano, TX", "Frisco, TX", "Austin, TX", "Houston, TX", "San Antonio, TX"];
const OUT_OF_STATE = [
  "Atlanta, GA", "Charlotte, NC", "Chicago, IL", "Jersey City, NJ", "Edison, NJ", "Seattle, WA", "Phoenix, AZ", "Denver, CO",
  "Columbus, OH", "Tampa, FL", "Raleigh, NC", "San Jose, CA", "Minneapolis, MN", "St. Louis, MO", "Hartford, CT", "Pittsburgh, PA",
];
const ALL_CITIES = ["Dallas, TX", ...TX_OTHER, ...OUT_OF_STATE];
const AREA_CODES = ["214", "469", "972", "512", "713", "404", "704", "312", "201", "732", "206", "602", "303", "614", "813", "919"];
const EDUCATION = [
  "B.Tech Computer Science, JNTU Hyderabad", "MS Computer Science, University of Texas at Dallas", "BS Information Systems, Georgia State University",
  "MCA, Osmania University", "BE Electronics, Anna University", "MS Information Technology, Northeastern University",
  "BS Computer Science, University of Illinois", "B.Tech IT, VIT Vellore", "MS Computer Engineering, San Jose State University",
  "BS Software Engineering, Arizona State University", "BE Computer Science, Pune University", "MBA + BS CS, Rutgers University",
];
const DOMAINS = ["retail", "banking", "telecom", "insurance", "logistics", "media", "energy", "travel"];
const BOARDS: Board[] = ["dice", "monster", "linkedin"];

interface Archetype {
  key: string;
  title: string;
  skills: string[];
  lines: string[];
  req: { title: string; skills: string[]; minYears: number; rate: number };
}

// At most one of the hero skills (Spring Boot, AWS, Kafka) appears in any of these, so none can reach 80 on REQ-1042.
const ARCHETYPES: Archetype[] = [
  { key: "dotnet", title: "Senior .NET Developer", skills: ["C#", ".NET Core", "ASP.NET", "Azure", "SQL Server", "Entity Framework", "Angular"],
    lines: ["Builds ASP.NET Core APIs on Azure App Service.", "Tuned SQL Server stored procedures for reporting workloads."],
    req: { title: ".NET Developer", skills: ["C#", ".NET Core", "Azure", "SQL Server"], minYears: 7, rate: 62 } },
  { key: "data", title: "Data Engineer", skills: ["Python", "Spark", "Snowflake", "Airflow", "SQL", "Databricks", "Kafka"],
    lines: ["Builds Spark and Airflow pipelines into Snowflake.", "Models data marts for finance and operations dashboards."],
    req: { title: "Data Engineer", skills: ["Python", "Spark", "Snowflake", "Airflow"], minYears: 6, rate: 70 } },
  { key: "devops", title: "DevOps Engineer", skills: ["Terraform", "Kubernetes", "Jenkins", "AWS", "Ansible", "Docker", "Azure DevOps"],
    lines: ["Runs Kubernetes clusters with Terraform and Helm.", "Owns CI/CD in Jenkins and Azure DevOps for 40+ services."],
    req: { title: "DevOps Engineer", skills: ["Terraform", "Kubernetes", "Azure DevOps", "Jenkins"], minYears: 7, rate: 72 } },
  { key: "sap", title: "SAP FICO Consultant", skills: ["SAP FICO", "S/4HANA", "SAP CO", "GL", "AP/AR"],
    lines: ["Led two S/4HANA finance implementations end to end.", "Configured GL, AP/AR and asset accounting."],
    req: { title: "SAP FICO Consultant", skills: ["SAP FICO", "S/4HANA"], minYears: 10, rate: 85 } },
  { key: "sfdc", title: "Salesforce Developer", skills: ["Apex", "LWC", "Salesforce", "Visualforce", "SOQL"],
    lines: ["Builds Lightning Web Components and Apex triggers.", "Integrated Salesforce with ERP via REST."],
    req: { title: "Salesforce Developer", skills: ["Apex", "LWC", "Salesforce"], minYears: 5, rate: 65 } },
  { key: "qa", title: "QA Automation Engineer", skills: ["Selenium", "TestNG", "Java", "API testing", "Cucumber", "Postman"],
    lines: ["Built Selenium + TestNG frameworks from scratch.", "Automated API testing with Postman and RestAssured."],
    req: { title: "QA Automation Engineer", skills: ["Selenium", "TestNG", "API testing"], minYears: 6, rate: 55 } },
  { key: "ba", title: "Business Analyst", skills: ["Requirements", "SQL", "Jira", "Healthcare", "Visio", "UAT"],
    lines: ["Gathers requirements and runs UAT for healthcare systems.", "Writes SQL to validate claims and member data."],
    req: { title: "Healthcare Business Analyst", skills: ["Requirements", "SQL", "Jira", "Healthcare"], minYears: 6, rate: 58 } },
  { key: "react", title: "React Developer", skills: ["React", "TypeScript", "Node.js", "Redux", "GraphQL"],
    lines: ["Builds React + TypeScript front ends with GraphQL.", "Set up component libraries and Storybook."],
    req: { title: "React Developer", skills: ["React", "TypeScript", "Node.js"], minYears: 5, rate: 60 } },
  { key: "python", title: "Python Developer", skills: ["Python", "Django", "PostgreSQL", "FastAPI", "Celery"],
    lines: ["Builds Django and FastAPI services on PostgreSQL.", "Background jobs with Celery and Redis."],
    req: { title: "Python Developer", skills: ["Python", "Django", "PostgreSQL"], minYears: 6, rate: 64 } },
  { key: "servicenow", title: "ServiceNow Developer", skills: ["ServiceNow", "JavaScript", "ITSM", "Glide", "Flow Designer"],
    lines: ["Customises ServiceNow ITSM with Glide scripts.", "Built catalog items and Flow Designer automations."],
    req: { title: "ServiceNow Developer", skills: ["ServiceNow", "ITSM", "Glide"], minYears: 5, rate: 66 } },
  { key: "tableau", title: "Tableau Developer", skills: ["Tableau", "SQL", "Power BI", "Alteryx"],
    lines: ["Designs executive dashboards in Tableau and Power BI.", "Prepares data with Alteryx and SQL."],
    req: { title: "Tableau Developer", skills: ["Tableau", "SQL", "Alteryx"], minYears: 5, rate: 58 } },
  { key: "network", title: "Network Engineer", skills: ["Cisco", "Palo Alto", "BGP", "SD-WAN", "Firewalls"],
    lines: ["Runs Cisco and Palo Alto networks across 30 sites.", "Rolled out SD-WAN for branch offices."],
    req: { title: "Network Engineer", skills: ["Cisco", "Palo Alto", "BGP"], minYears: 7, rate: 60 } },
  { key: "workday", title: "Workday HCM Analyst", skills: ["Workday HCM", "EIB", "Workday Reporting", "Business Processes"],
    lines: ["Configures Workday HCM business processes.", "Loads data with EIB and builds custom reports."],
    req: { title: "Workday HCM Analyst", skills: ["Workday HCM", "EIB", "Workday Reporting"], minYears: 5, rate: 70 } },
  { key: "scrum", title: "Scrum Master", skills: ["Scrum", "SAFe", "Jira", "Agile coaching"],
    lines: ["Facilitates Scrum for three delivery teams.", "SAFe program increment planning and metrics."],
    req: { title: "Scrum Master", skills: ["Scrum", "SAFe", "Jira"], minYears: 6, rate: 62 } },
];

const CLIENTS = [
  { name: "Woodgrove Bank", slug: "woodgrovebank" }, { name: "Fabrikam Insurance", slug: "fabrikam" },
  { name: "Northwind Traders", slug: "northwind" }, { name: "Adventure Works", slug: "adventureworks" },
  { name: "Tailspin Toys", slug: "tailspintoys" }, { name: "Litware", slug: "litware" }, { name: "Proseware", slug: "proseware" },
  { name: "Wide World Importers", slug: "wideworldimporters" }, { name: "Lucerne Publishing", slug: "lucernepublishing" },
  { name: "Trey Research", slug: "treyresearch" }, { name: "Alpine Ski House", slug: "alpineskihouse" },
  { name: "Fourth Coffee", slug: "fourthcoffee" }, { name: "Humongous Insurance", slug: "humongousinsurance" },
  { name: "Relecloud", slug: "relecloud" }, { name: "Wingtip Toys", slug: "wingtiptoys" },
  { name: "Consolidated Messenger", slug: "consolidatedmessenger" }, { name: "Coho Winery", slug: "cohowinery" },
  { name: "VanArsdel", slug: "vanarsdel" }, { name: "Margie's Travel", slug: "margiestravel" },
];

const VENDOR_NAMES = [
  "Northgate Tech Partners", "Bluepeak Consulting", "Silverline IT Services", "Crestview Solutions", "Ironwood Staffing Group",
  "Lakeshore Infotech", "Summit Ridge Consulting", "Brightpath Technologies", "Oakmont Systems", "Redrock IT Partners",
  "Clearwater Infosolutions", "Highland Talent Labs", "Riverbend Software", "Stonebridge Tech", "Evergreen Bench Solutions",
  "Pinecrest Consulting", "Granite Peak Systems", "Meridian Tech Staffing", "Coastal Code Partners", "Westfield Infotech",
  "Harborview Solutions", "Copperleaf IT", "Maplewood Technologies", "Skyline Bench Partners", "Trailhead Consulting",
];
const VENDOR_REPLY_INDEXES = [1, 4, 7, 11, 16, 20];
const CONSULTANTS_PER_REPLY = [2, 1, 3, 2, 1, 2];

export function buildSeed(opts: { candidates?: number; requirements?: number } = {}): DeskState {
  const totalCandidates = opts.candidates ?? 400;
  const requirementCount = opts.requirements ?? 19;
  const rand = mulberry32(1042);
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const shuffle = <T>(arr: T[]): T[] => {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };

  const usedNames = new Set(HERO_NAMES);
  let nameSerial = 20;
  function person() {
    for (;;) {
      const first = pick(FIRST);
      const last = pick(LAST);
      const name = `${first} ${last}`;
      if (usedNames.has(name)) continue;
      usedNames.add(name);
      nameSerial++;
      const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");
      return {
        name,
        email: `${slug(first)}.${slug(last)}${nameSerial % 97}@mail.example.com`,
        linkedin: `https://linkedin.example.com/in/${slug(first)}-${slug(last)}-${nameSerial}`,
        phone: `(${pick(AREA_CODES)}) 555-01${String(int(0, 99)).padStart(2, "0")}`,
      };
    }
  }
  function workAuth(): WorkAuth {
    const r = rand();
    return r < 0.4 ? "H-1B" : r < 0.6 ? "USC" : r < 0.8 ? "GC" : r < 0.9 ? "H-4 EAD" : "OPT";
  }
  function answers(rate: number, notice: number): ScreenAnswers {
    return {
      interested: rand() > 0.15,
      availability: notice === 0 ? "Available immediately" : `Can start ${notice} weeks after confirmation`,
      noticePeriod: notice === 0 ? "None" : `${notice} weeks`,
      payExpectation: `$${rate}/hr C2C`,
      locationOk: rand() > 0.2,
      workAuthConfirmed: true,
      notes: pick(["Prefers hybrid.", "Open to onsite 3 days.", "Has a competing interview this week.", "Wants a long-term contract."]),
    };
  }
  type Draft = Omit<Candidate, "id" | "workAuthDocs">;
  function base(title: string, skills: string[], lines: string[], loc: string, years: number, rate: number, extra: Partial<Draft> = {}): Draft {
    const p = person();
    const notice = pick([0, 2, 2, 2, 3, 4]);
    const auth = workAuth();
    const education = pick(EDUCATION);
    return {
      ...p,
      title,
      location: loc,
      relocate: false,
      workAuth: auth,
      years,
      skills,
      rateExpectation: rate,
      noticeWeeks: notice,
      availability: notice === 0 ? "Immediate" : `${notice} weeks notice`,
      education,
      resume: `${title} with ${years} years of experience in ${pick(DOMAINS)}. ${lines.join(" ")} Education: ${education}.`,
      source: pick<Source>([...BOARDS, "database"]),
      contactPreference: "text",
      ...extra,
    };
  }

  // Strong Java: all three hero skills and 8+ years, so 80+; location and rate keep them at or below 91.
  const STRONG = 19;
  const strong: Draft[] = [];
  for (let i = 0; i < STRONG; i++) {
    const outOfState = i % 2 === 0;
    const loc = outOfState ? pick(OUT_OF_STATE) : pick(TX_OTHER);
    const rate = outOfState ? int(60, 78) : int(72, 80);
    const extras = shuffle(["Microservices", "Docker", "Kubernetes", "PostgreSQL", "Redis", "Jenkins", "Hibernate", "REST APIs"]).slice(0, 2);
    const years = int(8, 15);
    const draft = base(pick(["Senior Java Developer", "Java Developer", "Backend Engineer (Java)", "Senior Software Engineer"]),
      ["Java", "Spring Boot", "AWS", "Kafka", ...extras],
      [`Built Spring Boot microservices on AWS (${pick(["EKS", "ECS", "Lambda"])}, S3).`, `Kafka event streams at ${int(2, 30)}M messages/day.`],
      loc, years, rate);
    draft.screenAnswers = answers(rate, draft.noticeWeeks);
    strong.push(draft);
  }

  const remaining = totalCandidates - TOP_THREE.length - STRONG;
  const weakCount = Math.round(remaining * 0.28);
  const weak: Draft[] = [];
  const ONE_HERO = ["AWS", "Kafka", "Spring Boot", null, null] as const;
  for (let i = 0; i < weakCount; i++) {
    const hero = pick(ONE_HERO);
    const skills = ["Java", "Spring", ...shuffle(["Hibernate", "Microservices", "REST APIs", "Oracle", "JSP", "Maven", "JUnit", "Struts"]).slice(0, 3)];
    if (hero) skills.push(hero);
    const lines = ["Maintains Java services with Spring MVC and Hibernate.", hero ? `Some hands-on ${hero} work.` : "Works on Oracle-backed batch jobs."];
    weak.push(base(pick(["Java Developer", "Software Engineer", "Junior Java Developer", "Application Developer"]), skills, lines,
      pick(ALL_CITIES), int(3, 14), int(45, 85)));
  }

  const others: { draft: Draft; archetype: string }[] = [];
  const otherCount = remaining - weakCount;
  for (let i = 0; i < otherCount; i++) {
    const a = ARCHETYPES[i % ARCHETYPES.length]!;
    const skills = shuffle(a.skills).slice(0, Math.min(a.skills.length, int(3, 5)));
    for (const must of a.req.skills.slice(0, 2)) if (!skills.includes(must)) skills.unshift(must);
    others.push({ draft: base(a.title, skills, a.lines, pick(ALL_CITIES), int(3, 16), int(45, 95)), archetype: a.key });
  }

  // Assign ids in shuffled order so the hero candidates don't sit at the top of the list.
  const drafts: { draft: Draft; archetype: string }[] = shuffle([
    ...TOP_THREE.map((d) => ({ draft: { ...d }, archetype: "java" })),
    ...strong.map((d) => ({ draft: d, archetype: "java" })),
    ...weak.map((d) => ({ draft: d, archetype: "java" })),
    ...others,
  ]);
  const archetypeOf = new Map<string, string>();
  const candidates: Candidate[] = drafts.map(({ draft, archetype }, i) => {
    const id = `CAN-${String(i + 1).padStart(4, "0")}`;
    archetypeOf.set(id, archetype);
    return { id, ...draft, workAuthDocs: workAuthDocs(id, draft.workAuth) };
  });

  const vendors: Vendor[] = VENDOR_NAMES.map((name, i) => {
    const slug = name.toLowerCase().replace(/[^a-z]/g, "");
    const contact = person();
    return { id: `VEN-${String(i + 1).padStart(2, "0")}`, name, contact: contact.name, email: `bench@${slug}.example.com`, benchSize: int(5, 60) };
  });

  // Vendor consultants: two of the three hero skills, so 55–85 and never above the top 3.
  let consultantSerial = totalCandidates;
  const vendorReplies = VENDOR_REPLY_INDEXES.map((vi, r) => {
    const vendor = vendors[vi]!;
    const consultants: Candidate[] = [];
    for (let k = 0; k < CONSULTANTS_PER_REPLY[r]!; k++) {
      const second = pick(["AWS", "Kafka"]);
      const draft = base("Java Consultant", ["Java", "Spring Boot", second, "Microservices"],
        [`Spring Boot services with ${second}.`, "Available on C2C through the vendor."], pick(OUT_OF_STATE), int(6, 12), int(62, 75),
        { source: "vendor", vendorId: vendor.id, relocate: rand() > 0.5 });
      const id = `CAN-${String(++consultantSerial).padStart(4, "0")}`;
      draft.screenAnswers = answers(draft.rateExpectation, draft.noticeWeeks);
      consultants.push({ id, ...draft, workAuthDocs: workAuthDocs(id, draft.workAuth) });
    }
    const lines = consultants.map((c) => `- ${c.name}, ${c.title}, ${c.years} yrs, ${c.workAuth}, ${c.location}${c.relocate ? " (will relocate)" : ""}, $${c.rateExpectation}/hr C2C, ${c.availability}`);
    const body = [`Hi Desk team,`, ``, `Thanks for the Sr Java req. ${consultants.length === 1 ? "Here is a consultant" : `Here are ${consultants.length} consultants`} on our bench, all C2C through ${vendor.name}:`, ``, ...lines, ``, `Resumes attached. RTR on request.`, ``, `Regards,`, `${vendor.contact}`, vendor.name].join("\n");
    return { vendorId: vendor.id, body, consultants };
  });

  // Seeded requirements and their pipelines.
  const requirements: Requirement[] = [];
  const pipeline: PipelineEntry[] = [];
  const interviews: Interview[] = [];
  const onboarding: Onboarding[] = [];
  const timesheets: Timesheet[] = [];
  const firstId = 1041 - requirementCount + 1;
  const poolOf = (key: string) => shuffle(candidates.filter((c) => archetypeOf.get(c.id) === key));
  let feedbackEmail: EmailDraft | undefined;
  let offerAcceptedEmail: EmailDraft | undefined;
  let interviewSerial = 0;

  for (let i = 0; i < requirementCount; i++) {
    const a = ARCHETYPES[i % ARCHETYPES.length]!;
    const client = CLIENTS[i % CLIENTS.length]!;
    const contact = person();
    const contactEmail = `${contact.email.split("@")[0]!.replace(/\d+$/, "")}@${client.slug}.example.com`;
    const receivedAt = BASE_TIME - int(1, 18) * DAY - int(0, 8) * HOUR;
    const req: Requirement = {
      id: `REQ-${firstId + i}`,
      title: a.req.title,
      client: client.name,
      clientContact: contactEmail,
      location: pick(ALL_CITIES),
      workMode: pick(["onsite", "hybrid", "hybrid", "remote"] as const),
      rate: a.req.rate,
      employmentType: pick(["C2C", "C2C", "W2", "C2C or W2"] as const),
      skills: a.req.skills,
      minYears: a.req.minYears,
      jd: `${a.req.title} for ${client.name}. Must have: ${a.req.skills.join(", ")}. ${a.req.minYears}+ years.`,
      status: "open",
      receivedAt,
      postedOn: shuffle(BOARDS).slice(0, int(1, 3)),
    };
    const pool = poolOf(a.key);
    const k = Math.min(pool.length, int(3, 15));
    const chosen = pool.slice(0, k);
    const stages: Stage[] = chosen.map(() => {
      const r = rand();
      return r < 0.4 ? "sourced" : r < 0.65 ? "matched" : r < 0.8 ? "screened" : r < 0.9 ? "rtr" : "submitted";
    });

    if (i === 0) {
      stages[0] = "interview";
      stages[1] = "onboarding";
      const cand = chosen[0]!;
      interviews.push({ id: `INT-${String(++interviewSerial).padStart(4, "0")}`, reqId: req.id, candidateId: cand.id, round: 1,
        when: "Fri Oct 23, 11:00 AM CT", interviewers: "Hiring manager + tech lead", status: "scheduled" });
      feedbackEmail = {
        kind: "client_feedback", from: `${contact.name} <${contactEmail}>`, to: [DESK_EMAIL], reqId: req.id, candidateId: cand.id,
        subject: `Feedback: ${cand.name} - round 1 (${req.title})`,
        body: `Hi team,\n\n${cand.name.split(" ")[0]} did well in round 1, strong on ${a.req.skills[0]} and clear communicator. Please set up round 2 with our architect this week. Tue or Wed afternoon CT works.\n\nThanks,\n${contact.name.split(" ")[0]}`,
        attachments: [],
      };
      const w2 = chosen[1]!;
      onboarding.push({ reqId: req.id, candidateId: w2.id, path: "W2", offerDocSent: true, bgv: "clear",
        laptopTracking: "FedEx 7781 2245 9034 (delivered)", startDate: "2026-08-03", startConfirmed: true });
      timesheets.push({ candidateId: w2.id, month: "2026-08", hours: 168, status: "billed" });
      timesheets.push({ candidateId: w2.id, month: "2026-09", hours: 160, status: "approved" });
    }
    if (i === 1) {
      stages[0] = "interview";
      stages[1] = "offer";
      stages[2] = "onboarding";
      const cand = chosen[0]!;
      interviews.push({ id: `INT-${String(++interviewSerial).padStart(4, "0")}`, reqId: req.id, candidateId: cand.id, round: 1,
        when: "Tue Oct 20, 2:00 PM CT", interviewers: "Engineering manager", status: "done", feedback: "Good fundamentals.", outcome: "advance" });
      interviews.push({ id: `INT-${String(++interviewSerial).padStart(4, "0")}`, reqId: req.id, candidateId: cand.id, round: 2,
        when: "Wed Oct 28, 3:00 PM CT", interviewers: "Architect panel", status: "scheduled" });
      const offered = chosen[1]!;
      offered.workAuth = "H-1B";
      offered.workAuthDocs = workAuthDocs(offered.id, "H-1B");
      offerAcceptedEmail = {
        kind: "offer_accepted", from: `${contact.name} <${contactEmail}>`, to: [DESK_EMAIL], reqId: req.id, candidateId: offered.id,
        subject: `Offer accepted: ${offered.name} (${req.title})`,
        body: `Hi team,\n\nGood news: ${offered.name} accepted our offer for ${req.title}. The engagement is C2C through their H-1B employer, Brightwave Systems. Please send the MSA and work order, start the background check, and ship the laptop to the address on file. Target start: Mon Nov 9.\n\nThanks,\n${contact.name.split(" ")[0]}`,
        attachments: [],
      };
      onboarding.push({ reqId: req.id, candidateId: chosen[2]!.id, path: "C2C", offerDocSent: true, bgv: "in_progress",
        startDate: "2026-11-02", startConfirmed: false });
    }
    chosen.forEach((c, idx) => {
      const stage = stages[idx]!;
      const score = keywordScore(c, req);
      pipeline.push({ reqId: req.id, candidateId: c.id, stage, ...(stage !== "sourced" ? { score, scoreReasons: `Keyword fit ${score}.` } : {}),
        updatedAt: receivedAt + int(1, 30) * HOUR });
    });
    if (stages.some((s) => s !== "sourced" && s !== "matched" && s !== "screened" && s !== "rtr")) req.firstSubmittedAt = receivedAt + int(2, 9) * HOUR;
    requirements.push(req);
  }

  // Guard the tuning by construction: only the top 3 and the strong pool may reach 80 on REQ-1042.
  const strongNames = new Set([...HERO_NAMES, ...strong.map((s) => s.name)]);
  for (const c of candidates) {
    if (!strongNames.has(c.name) && keywordScore(c, HERO_REQUIREMENT) >= 80) throw new Error(`seed tuning: ${c.name} reached 80`);
  }

  return {
    requirements,
    candidates,
    pipeline,
    emails: [],
    screens: [],
    paperwork: [],
    submissions: [],
    interviews,
    onboarding,
    timesheets,
    vendors,
    activity: [],
    pending: [],
    script: {
      heroClientEmail: heroClientEmail(),
      vendorReplies,
      morning: { feedbackEmail: feedbackEmail!, offerAcceptedEmail: offerAcceptedEmail!, timesheetMonth: "2026-10" },
    },
    counters: { REQ: 1041, CAN: consultantSerial, EM: 0, SUB: 0, INT: interviewSerial, PR: 0 },
    flags: { clientEmailDelivered: false, morningDelivered: false },
  };
}

if (import.meta.main) {
  const out = fileURLToPath(new URL("../data/seed.json", import.meta.url));
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, Number(v)]));
  writeFileSync(out, JSON.stringify(buildSeed(args), null, 1));
  console.log(`wrote ${out}`);
}
