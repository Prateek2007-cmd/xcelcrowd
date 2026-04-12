// Seed script — run with: node scripts/seed.mjs
// Requires the API server to be running on port 5000

const API = "http://localhost:5000/api";

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`  ✗ POST ${path} → ${res.status}`, data);
    return null;
  }
  return data;
}

async function seed() {
  console.log("=== Seeding Database ===\n");

  // 1. Create Jobs
  console.log("Creating jobs...");
  const job1 = await post("/jobs", {
    title: "Senior Backend Engineer",
    description: "Lead backend systems architecture and build scalable APIs",
    capacity: 3,
  });
  console.log(`  ✓ Job: ${job1?.title} (capacity: ${job1?.capacity})`);

  const job2 = await post("/jobs", {
    title: "Product Manager",
    description: "Drive product strategy and roadmap",
    capacity: 2,
  });
  console.log(`  ✓ Job: ${job2?.title} (capacity: ${job2?.capacity})`);

  const job3 = await post("/jobs", {
    title: "Data Scientist",
    description: "Build ML models and data pipelines",
    capacity: 1,
  });
  console.log(`  ✓ Job: ${job3?.title} (capacity: ${job3?.capacity})`);

  // 2. Create Applicants
  console.log("\nRegistering applicants...");
  const applicants = [
    { name: "Alice Chen", email: "alice@example.com" },
    { name: "Bob Martinez", email: "bob@example.com" },
    { name: "Carol Smith", email: "carol@example.com" },
    { name: "David Kim", email: "david@example.com" },
    { name: "Eva Torres", email: "eva@example.com" },
  ];

  const created = [];
  for (const a of applicants) {
    const result = await post("/applicants", a);
    if (result) {
      created.push(result);
      console.log(`  ✓ Applicant: ${result.name} (id: ${result.id})`);
    }
  }

  if (!job1 || !job2 || !job3 || created.length < 5) {
    console.log("\n⚠ Some entities already exist. Skipping applications.");
    return;
  }

  // 3. Apply to Jobs
  console.log("\nSubmitting applications...");

  // Senior Backend Engineer (capacity 3): Alice gets active
  const app1 = await post("/apply", { applicantId: created[0].id, jobId: job1.id });
  console.log(`  ✓ ${created[0].name} → ${job1.title}: ${app1?.status}`);

  // Product Manager (capacity 2): no applicants yet

  // Data Scientist (capacity 1): Bob gets active, Carol gets waitlisted
  const app2 = await post("/apply", { applicantId: created[1].id, jobId: job3.id });
  console.log(`  ✓ ${created[1].name} → ${job3.title}: ${app2?.status}`);

  const app3 = await post("/apply", { applicantId: created[2].id, jobId: job3.id });
  console.log(`  ✓ ${created[2].name} → ${job3.title}: ${app3?.status}`);

  console.log("\n=== Seed Complete ===");
  console.log(`
Dashboard should now show:
  • Senior Backend Engineer: 1/3 active, 0 waitlist
  • Product Manager: 0/2 active, 0 waitlist
  • Data Scientist: 1/1 active, 1 waitlist

Applicant Registry: 5 applicants
  `);
}

seed().catch(console.error);
