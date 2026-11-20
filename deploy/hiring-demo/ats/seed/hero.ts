// Hand-written data for the live run: the REQ-1042 client email and the three candidates the demo turns on.
// Everything here is fictional.
import type { Attachment, Candidate, EmailDraft, Requirement, WorkAuth } from "../src/types.ts";

export const DESK_EMAIL = "desk@recruitingdesk.example.com";

export const HERO_REQUIREMENT = {
  title: "Senior Java Developer",
  client: "Contoso Health",
  clientContact: "dana.whitfield@contosohealth.example.com",
  location: "Dallas, TX",
  workMode: "hybrid",
  rate: 68,
  employmentType: "C2C",
  skills: ["Spring Boot", "AWS", "Kafka"],
  minYears: 8,
} satisfies Partial<Requirement>;

export function heroClientEmail(): EmailDraft {
  return {
    kind: "client_requirement",
    from: "Dana Whitfield <dana.whitfield@contosohealth.example.com>",
    to: [DESK_EMAIL],
    subject: "Req: Sr Java Dev - Dallas (hybrid) - $68/hr C2C",
    body: [
      "Hi team,",
      "",
      "New one for you, hoping to move fast on this. Need 3 strong profiles by EOD please.",
      "",
      "Role: Senior Java Developer (backend)",
      "Location: Dallas, TX - hybrid, 3 days onsite (Tue-Thu)",
      "Duration: 12 months, likely extension",
      "Rate: $68/hr C2C max (W2 ok if the candidate prefers, same budget)",
      "Must have: Spring Boot, AWS, Kafka, 8+ yrs Java",
      "Nice to have: healthcare domain (claims/eligibility), Kubernetes",
      "Interview: 2 rounds, video then onsite w/ our architect",
      "",
      "JD below (from the hiring manager, sorry for the formatting):",
      "",
      "> We're modernising our claims-processing platform. You'll build and own Spring Boot microservices running on AWS (EKS, RDS, S3), " +
        "design event-driven flows on Kafka, and work with the data team on real-time eligibility checks. Expect code reviews, on-call " +
        "rotation 1 week in 6, and mentoring two mid-level devs. Java 17, Gradle, Terraform, GitHub Actions.",
      "",
      "Please include work auth + visa copy and LinkedIn with each submission, same as usual.",
      "",
      "Thanks!",
      "Dana Whitfield",
      "Talent Acquisition, Contoso Health",
    ].join("\n"),
    attachments: [],
  };
}

const DOC_NAMES: Record<string, string> = {
  h1b: "H-1B approval notice (SAMPLE).html",
  i94: "I-94 record (SAMPLE).html",
  ead: "EAD card (SAMPLE).html",
  gc: "Green card (SAMPLE).html",
};

/** SAMPLE placeholders per work authorization; served by GET /docs/:candidateId/:docType. */
export function workAuthDocs(candidateId: string, workAuth: WorkAuth): Attachment[] {
  const types: Record<WorkAuth, string[]> = { "H-1B": ["h1b", "i94"], "H-4 EAD": ["ead", "i94"], GC: ["gc"], OPT: ["ead"], USC: [] };
  return types[workAuth].map((t) => ({ name: DOC_NAMES[t]!, url: `/docs/${candidateId}/${t}` }));
}

type HeroCandidate = Omit<Candidate, "id" | "workAuthDocs">;

export const TOP_THREE: HeroCandidate[] = [
  {
    name: "Kiran Rao",
    email: "kiran.rao@mail.example.com",
    phone: "(972) 555-0142",
    linkedin: "https://linkedin.example.com/in/kiran-rao-7",
    title: "Senior Java Developer",
    location: "Irving, TX",
    relocate: false,
    workAuth: "H-1B",
    years: 11,
    skills: ["Java", "Spring Boot", "AWS", "Kafka", "Kubernetes", "Microservices", "Terraform"],
    rateExpectation: 66,
    noticeWeeks: 2,
    availability: "2 weeks after confirmation",
    education: "MS Computer Science, University of Texas at Dallas",
    resume: [
      "Senior Java Developer with 11 years building backend systems, the last 6 in healthcare payer platforms.",
      "Owns Spring Boot microservices for claims adjudication on AWS (EKS, RDS, S3, Lambda); cut claim turnaround from 3 days to 4 hours.",
      "Designed Kafka event streams for real-time eligibility checks (40M messages/day) with exactly-once processing.",
      "Runs services on Kubernetes with Terraform and GitHub Actions; on-call lead for a team of 7.",
      "Mentors mid-level engineers; led the Java 8 to Java 17 upgrade across 30 services.",
      "Current employer: Brightwave Systems (H-1B), client: a regional health insurer.",
    ].join(" "),
    source: "dice",
    contactPreference: "phone",
  },
  {
    name: "Ana Souza",
    email: "ana.souza@mail.example.com",
    phone: "(214) 555-0118",
    linkedin: "https://linkedin.example.com/in/ana-souza-3",
    title: "Java Backend Engineer",
    location: "Dallas, TX",
    relocate: false,
    workAuth: "H-4 EAD",
    years: 9,
    skills: ["Java", "Spring Boot", "AWS", "Kafka", "PostgreSQL", "Docker"],
    rateExpectation: 65,
    noticeWeeks: 2,
    availability: "2 weeks notice",
    education: "BE Computer Engineering, University of Sao Paulo",
    resume: [
      "Java Backend Engineer with 9 years in fintech and retail.",
      "Builds Spring Boot REST and event-driven services on AWS (ECS, SQS, DynamoDB) and Kafka for order and payment flows.",
      "Improved p99 latency of the payments API by 60% through caching and async processing.",
      "Comfortable with Docker, PostgreSQL and CI/CD; pairs with QA on contract tests.",
    ].join(" "),
    source: "linkedin",
    contactPreference: "text",
    screenAnswers: {
      interested: true,
      availability: "Can start 2 weeks after confirmation",
      noticePeriod: "2 weeks",
      payExpectation: "$65/hr C2C",
      locationOk: true,
      workAuthConfirmed: true,
      notes: "Hybrid 3 days in Dallas is fine. EAD valid until March 2028. Prefers Tue-Thu onsite.",
    },
  },
  {
    name: "Marcus Lee",
    email: "marcus.lee@mail.example.com",
    phone: "(469) 555-0175",
    linkedin: "https://linkedin.example.com/in/marcus-lee-12",
    title: "Senior Software Engineer (Java)",
    location: "Plano, TX",
    relocate: false,
    workAuth: "USC",
    years: 10,
    skills: ["Java", "Spring Boot", "AWS", "Kafka", "Terraform", "Redis"],
    rateExpectation: 68,
    noticeWeeks: 3,
    availability: "3 weeks notice",
    education: "BS Computer Science, Texas A&M University",
    resume: [
      "Senior Software Engineer with 10 years of Java, mostly telecom and logistics.",
      "Built Spring Boot services on AWS (EKS, Aurora) and Kafka pipelines for shipment tracking at 15M events/day.",
      "Infrastructure as code with Terraform; Redis caching; led a team of 4 through a cloud migration.",
    ].join(" "),
    source: "monster",
    contactPreference: "text",
    screenAnswers: {
      interested: true,
      availability: "Can start in 3 weeks",
      noticePeriod: "3 weeks",
      payExpectation: "$68/hr C2C, firm",
      locationOk: true,
      workAuthConfirmed: true,
      notes: "US citizen. Hybrid is fine, 25 minutes from the Dallas office.",
    },
  },
];
