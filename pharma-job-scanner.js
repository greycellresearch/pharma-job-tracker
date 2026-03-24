/**
 * PHARMA JOB TRACKER — Weekly Scanner v3
 * ========================================
 * New in v3:
 *   - When a job disappears (filled/removed), fetches the full job description
 *     via Claude + web search and saves it permanently to data/archive.json
 *   - Main jobs.json stays lean (live roles only, rolling 12-week window)
 *   - Archive is organized by quarter and stored forever
 *
 * Files written:
 *   data/jobs.json     — live roles (read by dashboard Live tab)
 *   data/archive.json  — all removed roles with full descriptions (Archive tab)
 *
 * SETUP:
 *   npm install @anthropic-ai/sdk
 *   export ANTHROPIC_API_KEY=your_key_here
 *   node pharma-job-scanner.js
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CONFIG_PATH  = path.join(__dirname, "config.json");
const DATA_DIR     = path.join(__dirname, "data");
const JOBS_FILE    = path.join(DATA_DIR, "jobs.json");
const ARCHIVE_FILE = path.join(DATA_DIR, "archive.json");

// ── Config ────────────────────────────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`ERROR: config.json not found at ${CONFIG_PATH}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

// ── Region detection ──────────────────────────────────────────────────────────
function buildDetector(regionsConfig) {
  const lookup = [];
  for (const [key, def] of Object.entries(regionsConfig)) {
    for (const country of def.countries) {
      lookup.push({ kw: country.toLowerCase(), region: key });
    }
  }
  lookup.sort((a, b) => b.kw.length - a.kw.length);
  return (location) => {
    if (!location) return "other";
    const l = location.toLowerCase();
    for (const { kw, region } of lookup) {
      if (l.includes(kw)) return region;
    }
    if (/,\s*[A-Z]{2}$/.test(location.trim())) return "US";
    if (l === "remote") return "US";
    return "other";
  };
}

// ── Quarter label ─────────────────────────────────────────────────────────────
function toQuarter(isoDate) {
  const d = new Date(isoDate);
  return `${d.getFullYear()} Q${Math.floor(d.getMonth() / 3) + 1}`;
}

// ── File helpers ──────────────────────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadJson(filePath, defaultVal) {
  return fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf8"))
    : defaultVal;
}
function makeId(company, title, location) {
  return `${company}-${title}-${location}`
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

// ── Step 1: Search for open jobs at a company ─────────────────────────────────
async function searchJobs(company, regionsConfig) {
  console.log(`  Searching: ${company.name}…`);
  const regionList = Object.values(regionsConfig).map(r => r.label).join(", ");

  const prompt = `Search for current open job postings at ${company.name} (pharmaceutical company).

Categories to find:
1. Clinical / Medical Affairs (MSLs, Medical Affairs managers, Regulatory Affairs, Clinical Development)
2. Commercial / Sales (Sales Reps, Brand Managers, Market Access, Commercial Strategy, KAMs)
3. Data / Tech / AI (Data Scientists, AI/ML Engineers, Bioinformatics, Digital Health, Software Engineers)

Geographic scope: ${regionList} and United States.
Search ${company.name}'s careers page (${company.careerUrl}) and LinkedIn/Indeed.

Return ONLY a JSON array, no markdown, no preamble:
[
  {
    "title": "exact job title",
    "location": "City, Country/State — be specific",
    "category": "clinical" | "commercial" | "data",
    "date": "YYYY-MM-DD",
    "url": "direct URL or careers page URL"
  }
]
Up to 10 roles. Return [] if none found.`;

  try {
    const res = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0])
      .filter(j => j.title && j.category)
      .map(j => ({
        id:       makeId(company.name, j.title, j.location || ""),
        title:    j.title,
        location: j.location || "Location TBD",
        category: j.category,
        date:     j.date || new Date().toISOString().slice(0, 10),
        url:      j.url || company.careerUrl,
        status:   "open",
      }));
  } catch (err) {
    console.warn(`  Warning [${company.name}]: ${err.message}`);
    return [];
  }
}

// ── Step 2: Fetch full job description for a removed role ─────────────────────
async function fetchDescription(job, company) {
  console.log(`  Fetching description: "${job.title}" at ${company.name}…`);

  const prompt = `A pharmaceutical job posting has just been filled/removed. I need to permanently save the full job description for future reference.

Job details:
- Company: ${company.name}
- Title: ${job.title}
- Location: ${job.location}
- Category: ${job.category}
- Original URL: ${job.url}

Please search the web for this job posting (try the URL above, the company's careers page, LinkedIn, Indeed, and Glassdoor). 

If you find the actual posting, extract and return the FULL job description text — including the role summary, responsibilities, required qualifications, preferred qualifications, and any other sections. Preserve the structure but use plain text (no HTML).

If you cannot find the exact posting (it may already be taken down), reconstruct a representative description for a "${job.title}" role at a major pharmaceutical company based on your knowledge of what such roles typically involve. Clearly note at the top if this is a reconstruction.

Return ONLY the job description text. No preamble, no "Here is the description:", just the text itself. Aim for 300-600 words.`;

  try {
    const res = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    return text || null;
  } catch (err) {
    console.warn(`  Could not fetch description for "${job.title}": ${err.message}`);
    return null;
  }
}

// ── Step 3: Diff and identify removed jobs ────────────────────────────────────
function diff(previousJobs, freshJobs) {
  const prevMap  = new Map((previousJobs || []).map(j => [j.id, j]));
  const freshMap = new Map(freshJobs.map(j => [j.id, j]));
  const live     = freshJobs.map(j => ({ ...j, status: prevMap.has(j.id) ? "open" : "new" }));
  const removed  = [...prevMap.values()].filter(j => !freshMap.has(j.id) && j.status !== "removed");
  return { live, removed };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function runScan() {
  const config          = loadConfig();
  const activeCompanies = config.companies.filter(c => c.active !== false);
  const detectRegion    = buildDetector(config.regions);

  console.log("\n Pharma Job Tracker — Weekly Scan v3");
  console.log("=".repeat(52));
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Companies: ${activeCompanies.length} active`);
  console.log(`Regions:   ${Object.values(config.regions).map(r => r.label).join(", ")}`);
  console.log("=".repeat(52) + "\n");

  ensureDataDir();
  const previous    = loadJson(JOBS_FILE, null);
  const prevCos     = previous?.companies || [];
  let   archive     = loadJson(ARCHIVE_FILE, []);
  const archivedIds = new Set(archive.map(a => a.id));

  const scanCompanies = [];
  let totalNew = 0, totalRemoved = 0, totalDescFetched = 0;

  for (const company of activeCompanies) {
    // 1. Search for current open roles
    const freshJobs      = await searchJobs(company, config.regions);
    const freshWithRegion = freshJobs.map(j => ({ ...j, region: detectRegion(j.location) }));

    const prevCo = prevCos.find(c => c.name === company.name);
    const { live, removed } = diff(prevCo?.jobs || [], freshWithRegion);

    // 2. For each newly-removed role, fetch description and archive
    for (const job of removed) {
      if (archivedIds.has(job.id)) continue; // already archived
      await new Promise(r => setTimeout(r, 800)); // small pause between API calls
      const description = await fetchDescription(job, company);
      const archiveEntry = {
        id:          job.id,
        company:     company.name,
        title:       job.title,
        location:    job.location,
        category:    job.category,
        region:      job.region || detectRegion(job.location),
        postedDate:  job.date,
        removedDate: new Date().toISOString().slice(0, 10),
        quarter:     toQuarter(new Date()),
        url:         job.url,
        description: description,
      };
      archive.push(archiveEntry);
      archivedIds.add(job.id);
      totalDescFetched += description ? 1 : 0;
      totalRemoved++;
    }

    const nNew = live.filter(j => j.status === "new").length;
    totalNew += nNew;
    console.log(`  ${company.name.padEnd(26)} ${freshJobs.length} live | +${nNew} new | −${removed.length} archived`);

    scanCompanies.push({ name: company.name, abbr: company.abbr, website: company.careerUrl, jobs: live });
    await new Promise(r => setTimeout(r, 1200));
  }

  // 3. Write outputs
  const jobsOutput = { lastScan: new Date().toISOString(), companies: scanCompanies };
  fs.writeFileSync(JOBS_FILE,    JSON.stringify(jobsOutput, null, 2));
  fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(archive,    null, 2));

  const allLive   = scanCompanies.flatMap(c => c.jobs).filter(j => j.status !== "removed");
  const byRegion  = {};
  for (const key of Object.keys(config.regions)) byRegion[key] = 0;
  allLive.forEach(j => { const r = j.region || detectRegion(j.location); if (byRegion[r] !== undefined) byRegion[r]++; });

  console.log("\n" + "=".repeat(52));
  console.log("✅ Scan complete.");
  console.log(`   Live roles:          ${allLive.length}`);
  console.log(`   New this week:       ${totalNew}`);
  console.log(`   Archived (removed):  ${totalRemoved} (${totalDescFetched} descriptions fetched)`);
  console.log(`   Archive total:       ${archive.length} roles`);
  console.log(`   Region breakdown:    ${Object.entries(byRegion).map(([k,v])=>`${k}:${v}`).join("  ")}`);
  console.log(`   jobs.json:           ${JOBS_FILE}`);
  console.log(`   archive.json:        ${ARCHIVE_FILE}`);
  console.log("=".repeat(52) + "\n");
}

runScan().catch(err => { console.error("Fatal:", err); process.exit(1); });


/* ═══════════════════════════════════════════════════════════════════════════
   GITHUB ACTIONS WORKFLOW  →  .github/workflows/weekly-scan.yml

name: Weekly Pharma Job Scan

on:
  schedule:
    - cron: '0 8 * * 1'    # Every Monday 8:00 AM UTC
  workflow_dispatch:

jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - run: npm install @anthropic-ai/sdk

      - name: Run scanner
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: node pharma-job-scanner.js

      - name: Commit updated data
        run: |
          git config user.name  "pharma-tracker-bot"
          git config user.email "bot@noreply.github.com"
          git add data/jobs.json data/archive.json
          git diff --staged --quiet || git commit -m "scan: $(date -u '+%Y-%m-%d')"
          git push

═══════════════════════════════════════════════════════════════════════════
   DASHBOARD LIVE DATA INTEGRATION
   Once hosted on GitHub Pages, update the loadData functions in
   pharma-job-tracker.html to fetch from flat files instead of storage:

   async function boot() {
     try {
       const [jobsRes, archRes] = await Promise.all([
         fetch('./data/jobs.json'),
         fetch('./data/archive.json'),
       ]);
       jobData     = await jobsRes.json();
       archiveData = await archRes.json();
     } catch(e) {
       jobData     = SAMPLE_JOBS;
       archiveData = SAMPLE_ARCHIVE;
     }
     try { const r = await window.storage.get(CONFIG_KEY); if(r) companies = JSON.parse(r.value); } catch{}
     if(!companies.length) { companies = [...DEFAULT_COMPANIES]; await saveCo(); }
     render(); renderArchive(); renderModal();
   }

═══════════════════════════════════════════════════════════════════════════
   HOW DESCRIPTION ARCHIVING WORKS

   Each Monday scan:
   1. Searches for current open roles at each company
   2. Compares against last week's data
   3. Any role that was open last week but is GONE this week is considered filled
   4. For each filled role, Claude does a second web search to find and save
      the full job description (tries the original URL, LinkedIn, Indeed, Glassdoor)
   5. If the posting is already taken down, Claude writes a representative
      description based on the role title and company, clearly labeled as a reconstruction
   6. The archived role + description is appended to archive.json permanently

   archive.json is append-only — roles are never deleted from it.
   This means you build up a permanent, searchable repository over time.
═══════════════════════════════════════════════════════════════════════════ */
