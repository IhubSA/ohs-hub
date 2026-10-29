#!/usr/bin/env python3
"""
OHS Hub — static page builder.
Generates the marketing HTML pages from one shared header/footer so the
navigation stays consistent. The OUTPUT is plain HTML: upload the
generated .html files to GitHub as usual. You never need to run this to
deploy; it is only used when the shared header/footer or page copy changes.

    python tools/build_site.py
"""
from pathlib import Path
import html, datetime

ROOT = Path(__file__).resolve().parent.parent
SITE_URL = "https://ihubsa.github.io/ohs-hub/"   # change when a custom domain is set
TODAY = datetime.date.today().isoformat()
ENQ = "enquiries@ihub-sa.co.za"

LOGO = ('<svg viewBox="0 0 34 34" aria-hidden="true"><rect width="34" height="34" rx="6" fill="#052E3A"/>'
        '<path d="M17 6.5 28.5 26.5H5.5Z" fill="#FC7312" stroke="#FC7312" stroke-width="2.4" stroke-linejoin="round"/>'
        '<path d="m12.2 19.6 3.3 3.3 6.4-6.8" fill="none" stroke="#052E3A" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>')

def icon(paths):
    return ('<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2" '
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>')

ICONS = {
    "sop": icon('<path d="M10 5h14l7 7v23H10z"/><path d="M24 5v7h7"/><path d="M15 19h11M15 24h11M15 29h7"/><path d="m29 2 1.2 2.6L33 6l-2.8 1.4L29 10l-1.2-2.6L25 6l2.8-1.4z" fill="currentColor"/>'),
    "risk": icon('<rect x="6" y="6" width="28" height="28" rx="2"/><path d="M6 15.3h28M6 24.6h28M15.3 6v28M24.6 6v28"/><rect x="25.5" y="7" width="7.5" height="7.5" fill="currentColor"/>'),
    "inspect": icon('<rect x="9" y="6" width="22" height="29" rx="2"/><path d="M15 4h10v5H15z"/><path d="m14 17 2.5 2.5L21 15M14 27l2.5 2.5L21 25"/><path d="M24 18h4M24 28h4"/>'),
    "incident": icon('<path d="M20 5 36 33H4z"/><path d="M20 15v8"/><circle cx="20" cy="28" r="1.2" fill="currentColor"/>'),
    "legal": icon('<path d="M20 5v30M10 35h20"/><path d="M8 11h24"/><path d="m8 11-5 11h10zM32 11l-5 11h10z"/><path d="M3 22a5 3 0 0 0 10 0M27 22a5 3 0 0 0 10 0"/>'),
    "docs": icon('<path d="M8 9h16v26H8z"/><path d="M13 9V5h19v26h-8"/><path d="M12 16h8M12 21h8M12 26h5"/>'),
    "action": icon('<circle cx="20" cy="20" r="14"/><path d="m13.5 20.5 4.5 4.5 9-10"/>'),
    "equipment": icon('<path d="M24.5 9.5a7 7 0 0 0-9.4 9.4L5 29l6 6 10.1-10.1a7 7 0 0 0 9.4-9.4l-4.4 4.4-4.2-1.1-1.1-4.2z"/>'),
    "emergency": icon('<circle cx="20" cy="20" r="15"/><path d="M20 12v16M12 20h16"/>'),
    "training": icon('<path d="M4 15 20 8l16 7-16 7z"/><path d="M10 18v8c0 2.5 4.5 5 10 5s10-2.5 10-5v-8"/><path d="M36 15v10"/>'),
    "contractor": icon('<path d="M8 25a12 12 0 0 1 24 0"/><path d="M5 25h30v4H5z"/><path d="M17 13V9h6v4"/><path d="M20 25v-8"/>'),
    "report": icon('<path d="M6 34h28"/><path d="M10 34V22h5v12M18 34V14h5v20M26 34V8h5v26"/>'),
}

NAV = [
    ("index.html", "Home"), ("features.html", "Features"), ("industries.html", "Industries"),
    ("index.html#how-it-works", "How It Works"), ("pricing.html", "Pricing"),
    ("resources.html", "Resources"), ("contact.html", "Contact"),
]

def header(current):
    links = []
    for href, label in NAV:
        cur = ' aria-current="page"' if href == current else ''
        links.append(f'<a href="{href}"{cur}>{label}</a>')
    signin_cur = ' aria-current="page"' if current == "signin.html" else ''
    return f'''<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="index.html"><img src="assets/img/logo.png" alt="OHS Hub home" width="120" height="48"></a>
    <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">Menu</button>
    <nav class="nav" id="site-nav" aria-label="Main">
      {"".join(links)}
      <a class="nav-signin" href="signin.html"{signin_cur}>Sign In</a>
      <a class="btn btn-primary" href="register.html">Start Free Trial</a>
    </nav>
  </div>
</header>'''

FOOTER = f'''<footer class="site-footer">
  <div class="wrap">
    <div class="footer-grid">
      <div>
        <a class="brand" href="index.html"><img src="assets/img/logo-light.png" alt="OHS Hub home" width="115" height="46"></a>
        <p>Occupational health and safety management for South African workplaces.</p>
        <p class="small">A product of iHubSA, Fish Hoek, Western Cape.</p>
      </div>
      <div>
        <h2>Product</h2>
        <ul><li><a href="features.html">Features</a></li><li><a href="industries.html">Industries</a></li>
        <li><a href="pricing.html">Pricing</a></li><li><a href="index.html#how-it-works">How it works</a></li></ul>
      </div>
      <div>
        <h2>Company</h2>
        <ul><li><a href="about.html">About us</a></li><li><a href="contact.html">Contact us</a></li>
        <li><a href="resources.html">Resources</a></li><li><a href="faq.html">FAQ</a></li></ul>
      </div>
      <div>
        <h2>Legal</h2>
        <ul><li><a href="privacy.html">Privacy policy</a></li><li><a href="terms.html">Terms and conditions</a></li>
        <li><a href="popia.html">POPIA and data protection</a></li></ul>
      </div>
    </div>
    <div class="footer-base">
      <span>© <span data-year>2026</span> iHubSA. All rights reserved.</span>
      <span><a href="mailto:{ENQ}">{ENQ}</a></span>
    </div>
  </div>
</footer>'''

def page(filename, title, description, body, current=None, scripts=("site.js",), extra_head="", page_id="", noindex=False):
    canonical = SITE_URL + ("" if filename == "index.html" else filename)
    full_title = title if filename == "index.html" else f"{title} | OHS Hub"
    robots = '<meta name="robots" content="noindex">' if noindex else ''
    script_tags = "".join(f'<script type="module" src="assets/js/{s}"></script>' for s in scripts)
    return f'''<!doctype html>
<html lang="en-ZA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(full_title)}</title>
<meta name="description" content="{html.escape(description)}">
{robots}
<link rel="canonical" href="{canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="OHS Hub">
<meta property="og:title" content="{html.escape(full_title)}">
<meta property="og:description" content="{html.escape(description)}">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{SITE_URL}assets/img/og-image.png">
<meta property="og:locale" content="en_ZA">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#052E3A">
<link rel="icon" href="assets/img/favicon.png" type="image/png">
<link rel="apple-touch-icon" href="assets/img/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@600;700&family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/css/site.css">
{extra_head}
</head>
<body data-page="{page_id}">
{header(current or filename)}
<main id="main">
{body}
</main>
{FOOTER}
{script_tags}
</body>
</html>
'''

def cta(heading="Bring your safety records into one place.", text="Start a 14-day free trial. No card details needed."):
    return f'''<section class="section section--ink"><div class="wrap cta-band">
  <div><h2>{heading}</h2><p>{text}</p></div>
  <div class="btn-row"><a class="btn btn-primary" href="register.html">Start Free Trial</a>
  <a class="btn btn-secondary" href="contact.html?topic=demo">Book a walkthrough</a></div>
</div></section>'''

def draft_notice(what):
    return (f'<div class="alert alert--info" role="note" style="margin-bottom:28px"><strong>Draft for legal review.</strong> '
            f'This {what} must be reviewed by a qualified legal adviser before OHS Hub launches. '
            f'Highlighted items in [brackets] still need to be completed.</div>')

FEATURES = [
    ("ai-sop", "sop", "AI SOP Generator",
     "Answer a guided form and get a structured first draft of a standard operating procedure, ready for review and approval."),
    ("ai-risk", "risk", "AI Risk Assessment Generator",
     "Draft baseline, issue-based and task risk assessments. Scores come from your own matrix, never from the AI."),
    ("inspections", "inspect", "Digital Inspections and Audits",
     "Build checklists, schedule recurring inspections and capture findings with photos on a phone."),
    ("incidents", "incident", "Incident Reporting and Investigation",
     "Report injuries, near misses and dangerous occurrences, then investigate with 5 Whys and cause analysis."),
    ("legal", "legal", "South African Legal Compliance Register",
     "Track requirements under the OHS Act 85 of 1993, with every legal reference marked verified or unverified."),
    ("documents", "docs", "Document Control",
     "Version, review, approve and retire safety documents. Previous versions and their history are kept."),
    ("actions", "action", "Corrective Action Management",
     "One register for actions from risks, inspections, incidents and audits, with verification before closure."),
    ("training", "training", "Training and Competency Tracking",
     "Keep a training matrix, certificates and licences, with reminders before anything expires."),
    ("contractors", "contractor", "Contractor Management",
     "Register contractors, collect safety documents, record inductions and control site access."),
    ("equipment", "equipment", "Equipment and PPE",
     "An equipment register with inspection due dates and defect tracking, and a record of PPE issued to each person."),
    ("emergency", "emergency", "Emergency Preparedness",
     "Emergency numbers per site, tap-to-call on a phone, plus evacuation drill planning and results."),
    ("reporting", "report", "Safety Reporting and Analytics",
     "Monthly and quarterly OHS reports built from your actual records, exportable to PDF, Word and CSV."),
]

# =====================================================================
# HOME
# =====================================================================
feature_rows = []
for i, (fid, ic, name, text) in enumerate(FEATURES):
    if i == 0:
        feature_rows.append(f'''<div class="feature-row is-lead">{ICONS[ic]}<div><h3>{name}</h3><p>{text}</p></div>
<a class="btn btn-primary" href="features.html#{fid}">See how SOP drafting works</a></div>''')
    else:
        feature_rows.append(f'''<div class="feature-row">{ICONS[ic]}<div><h3>{name}</h3><p>{text}</p>
<a href="features.html#{fid}" aria-label="More about {name}">More detail</a></div></div>''')

INDUSTRIES = [
    ("Construction", "Task risk assessments, site inspections, method statements and contractor control across changing sites."),
    ("Mining", "Core OHS workflows today. The legal register can hold Mine Health and Safety Act 29 of 1996 requirements; mining-specific modules are planned."),
    ("Manufacturing", "Machine and workshop inspections, SOPs for equipment, PPE issue records and incident trends by line."),
    ("Engineering and maintenance", "Permit-ready job safety analyses, equipment registers and maintenance-linked inspections."),
    ("Logistics and warehousing", "Racking, forklift and housekeeping inspections, plus near-miss reporting from the floor."),
    ("Transport", "Vehicle inspection checklists, driver competency and licence expiry tracking."),
    ("Facilities management", "Multi-site inspection schedules, fire safety checks and contractor management."),
    ("General commercial businesses", "A straightforward way to keep risk assessments, emergency plans and records current."),
    ("OHS consultants", "Manage separate client companies from one login, each with fully isolated data."),
]
industry_html = "".join(f'<div class="industry"><h3>{n}</h3><p>{t}</p></div>' for n, t in INDUSTRIES)

home = f'''
<section class="hero">
  <div class="wrap hero-grid">
    <div>
      <h1>Simplify Workplace Safety. Strengthen Compliance. Protect Your People.</h1>
      <p class="lede">Manage your occupational health and safety processes in one intelligent platform. Generate safety documentation with AI, manage risk assessments, conduct inspections, investigate incidents and track corrective actions, all from one central system.</p>
      <div class="btn-row"><a class="btn btn-primary" href="register.html">Start Free Trial</a>
      <a class="btn btn-secondary" href="#features">Explore Features</a></div>
      <p class="hero-note">14-day free trial. No card details needed. Built for South African workplaces.</p>
    </div>
    <div class="matrix-card" aria-labelledby="rm-title">
      <h2 id="rm-title">Try the risk matrix</h2>
      <p>Pick a likelihood and severity. OHS Hub scores every hazard this way, using the matrix your company approves.</p>
      <div class="matrix" id="risk-matrix" role="group" aria-label="5 by 5 risk matrix: severity rows, likelihood columns"></div>
      <p class="matrix-axis-title" aria-hidden="true">Rows show severity. Columns show likelihood.</p>
      <div class="readout" aria-live="polite">
        <span class="score" id="rm-score">16</span>
        <span class="band" id="rm-band">Rated High</span>
        <span class="calc" id="rm-calc">Likelihood 4 (Likely) × severity 4 (Major)</span>
        <p class="readout-note">Calculated by your configured matrix, never estimated by AI. Thresholds and labels are editable.</p>
      </div>
    </div>
  </div>
</section>

<section class="section" aria-labelledby="ps-title">
  <div class="wrap">
    <div class="section-head">
      <h2 id="ps-title">Safety management shouldn't live in ten spreadsheets</h2>
      <p>Most safety teams aren't short of effort. They're short of one place where risks, inspections, incidents and actions connect.</p>
    </div>
    <div class="ps">
      <div class="ps-col">
        <h3>What we hear from safety teams</h3>
        <ul class="ps-list is-problem">
          <li>Too much paperwork, and too little time on site</li>
          <li>Safety documents that are out of date or hard to find</li>
          <li>Risk assessments scored differently by different people</li>
          <li>Inspection schedules that slip without anyone noticing</li>
          <li>Incident investigations recorded inconsistently</li>
          <li>Corrective actions that quietly go overdue</li>
          <li>No clear view of where compliance stands</li>
          <li>Monthly reports that take days to compile</li>
          <li>Records scattered across spreadsheets, folders and inboxes</li>
        </ul>
      </div>
      <div class="ps-col">
        <h3>How OHS Hub handles it</h3>
        <ul class="ps-list is-solution">
          <li>Guided forms and AI-assisted first drafts</li>
          <li>Controlled documents with review dates and reminders</li>
          <li>One configurable risk matrix, applied the same way every time</li>
          <li>Recurring schedules with reminders to the inspector</li>
          <li>A structured investigation workflow with sign-off</li>
          <li>One action register with owners, due dates and verification</li>
          <li>A legal register with evidence against each requirement</li>
          <li>Reports generated from live records in minutes</li>
          <li>Everything in one secure system, separated by company</li>
        </ul>
      </div>
    </div>
  </div>
</section>

<section class="section section--white" id="features" aria-labelledby="f-title">
  <div class="wrap">
    <div class="section-head">
      <h2 id="f-title">Everything your OHS system needs, connected</h2>
      <p>A hazard found in an inspection can become a risk register entry and a corrective action, with each step linked and auditable.</p>
    </div>
    <div class="feature-index">{"".join(feature_rows)}</div>
  </div>
</section>

<section class="section section--ink" aria-labelledby="ai-title">
  <div class="wrap ai-grid">
    <div>
      <h2 id="ai-title">First drafts in minutes. Final say stays with your competent person.</h2>
      <p>Tell OHS Hub about the task, site, equipment and people involved. It drafts a structured document using your company details and approved templates, then flags what is missing.</p>
      <ul class="doc-types">
        <li>Standard operating procedures</li><li>Safe work procedures</li><li>Risk assessments</li>
        <li>Job safety analyses</li><li>Inspection checklists</li><li>Toolbox talks</li>
        <li>Emergency response plans</li><li>Incident investigation reports</li>
      </ul>
      <p>Every draft can be edited, reviewed, approved and kept under document control, with version numbers, effective dates and review reminders.</p>
      <p class="caution">AI-generated content is a starting point. It must be checked and approved by a competent person before use. OHS Hub never marks a document as compliant because AI wrote it, and any legal reference it can't match to a verified source is labelled "needs verification".</p>
    </div>
    <figure class="doc-preview" aria-label="Example of an AI-drafted SOP awaiting review">
      <div class="doc-bar"><span class="status status--draft">Draft, awaiting review</span><span>Version 0.1</span></div>
      <div class="doc-body">
        <h3>SOP: Working from portable ladders</h3>
        <p class="doc-meta">Example draft for illustration. Site and approver are chosen during setup.</p>
        <div class="doc-sec"><h4>Purpose <span class="flag flag--ok">Complete</span></h4>
          <p>To set out how portable ladders are selected, inspected and used so that work at height on this site is done safely.</p></div>
        <div class="doc-sec"><h4>Step-by-step instructions <span class="flag flag--ok">Complete</span></h4>
          <ol><li>Inspect the ladder before use and tag it out if damaged.</li><li>Set up on firm, level ground at the correct angle.</li><li>Maintain three points of contact while climbing.</li></ol></div>
        <div class="doc-sec"><h4>Required competencies <span class="flag flag--missing">Information missing</span></h4>
          <p>Add the training or authorisation your company requires for this task.</p></div>
        <div class="doc-sec"><h4>Legal references <span class="flag flag--verify">Needs verification</span></h4>
          <p>Work-at-height requirements: reference not yet matched to your verified legal register.</p></div>
      </div>
      <p class="doc-foot">Author, reviewer and approver are recorded. The draft can't become effective until it's approved.</p>
    </figure>
  </div>
</section>

<section class="section" aria-labelledby="ind-title">
  <div class="wrap">
    <div class="section-head">
      <h2 id="ind-title">Built for the way South African sites work</h2>
      <p>One platform, configured to your industry. Where a sector needs specialised modules, we say so plainly.</p>
    </div>
    <div class="industry-list">{industry_html}</div>
    <p style="margin-top:24px"><a href="industries.html">See what's available for each industry</a></p>
  </div>
</section>

<section class="section section--ink" id="how-it-works" aria-labelledby="hiw-title">
  <div class="wrap">
    <div class="section-head"><h2 id="hiw-title">How it works</h2>
      <p>Four steps from sign-up to a working OHS system.</p></div>
    <ol class="steps">
      <li><h3>Set up your company</h3><p>Add your sites, departments and workforce, and invite your team with the right roles.</p></li>
      <li><h3>Configure and generate</h3><p>Set your risk matrix and approval rules, then generate and approve your core safety documents.</p></li>
      <li><h3>Inspect, assess and report</h3><p>Run inspections on a phone, manage risks and report incidents as they happen.</p></li>
      <li><h3>Monitor and improve</h3><p>Track actions, compliance and performance on dashboards built from your live data.</p></li>
    </ol>
  </div>
</section>

<section class="section section--white" aria-labelledby="pr-title">
  <div class="wrap">
    <div class="section-head"><h2 id="pr-title">Plans that grow with your operation</h2>
      <p>Start on a free trial of Professional. Commercial pricing is being finalised, so contact us for a quote.</p></div>
    <div class="plans" id="plans"></div>
    <p style="margin-top:20px"><a href="pricing.html">Compare plans in detail</a></p>
  </div>
</section>
{cta()}
'''

jsonld = '''<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"OHS Hub",
"applicationCategory":"BusinessApplication","operatingSystem":"Web","description":"Occupational health and safety management software for South African businesses: risk assessments, inspections, incidents, corrective actions, document control and AI-assisted safety documentation.",
"publisher":{"@type":"Organization","name":"iHubSA","email":"enquiries@ihub-sa.co.za","address":{"@type":"PostalAddress","addressLocality":"Fish Hoek","addressRegion":"Western Cape","addressCountry":"ZA"}}}</script>'''

# =====================================================================
# FEATURES
# =====================================================================
FEATURE_DETAIL = {
 "ai-sop": ("Guided SOP builder with an AI first draft", '''
<p>Fill in a structured form. OHS Hub drafts each section, checks that every required section is present, and highlights anything it couldn't complete.</p>
<ul class="two-col"><li>Title and reference number</li><li>Purpose and scope</li><li>Site and department</li><li>Responsible persons</li>
<li>Required competencies and authorisations</li><li>Required PPE</li><li>Equipment and materials</li><li>Prerequisites</li>
<li>Identified hazards and precautions</li><li>Step-by-step work instructions</li><li>Critical control measures</li>
<li>Emergency response procedures</li><li>Required records</li><li>Author, reviewer and approver</li><li>Issue and review dates</li></ul>
<p>Regenerate a single section without overwriting the rest. Every generated version and every edit is kept. Approved SOPs can be printed or exported.</p>'''),
 "ai-risk": ("Risk assessments scored by your methodology", '''
<p>Supports baseline, issue-based and task-specific risk assessments, job safety analyses and job hazard analyses, using configurable templates.</p>
<ul class="two-col"><li>Activity, task and hazard</li><li>Persons exposed</li><li>Potential consequences</li><li>Existing controls</li>
<li>Initial likelihood, severity, score and rating</li><li>Additional controls, following the hierarchy of controls</li>
<li>Residual likelihood, severity, score and rating</li><li>Responsible person and completion date</li><li>Approval and review details</li></ul>
<p>Choose a 3×3 or 5×5 matrix and set your own labels and rating thresholds. Scores are calculated by the database from your approved formula. The AI can suggest hazards and controls but can't change a score.</p>'''),
 "inspections": ("Inspections from template to close-out", '''
<p>Generate checklist templates for general workplaces, construction sites, workshops, vehicles, machinery, electrical installations, fire safety, housekeeping, PPE and warehouses. Edit, group, reorder and approve every item before it's used.</p>
<ul><li>Scheduled, recurring and ad hoc inspections, assigned to an inspector</li>
<li>Responses: compliant, non-compliant, not applicable, not inspected</li>
<li>Comments, photo evidence and risk classification on findings</li>
<li>Any non-compliant item can raise a corrective action</li>
<li>Inspection reports, follow-up inspections and close-out verification</li>
<li>Mobile-friendly capture that keeps your answers if the signal drops and sends them when it returns</li></ul>'''),
 "incidents": ("A complete incident lifecycle", '''
<p>Anyone in your organisation can report injuries, near misses, dangerous occurrences, property damage, occupational illnesses, environmental events and unsafe conditions, with photos and witnesses.</p>
<ul><li>Investigator assignment, milestones and an evidence register</li><li>Witness statements and an event timeline</li>
<li>Immediate causes, underlying causes and contributing factors</li><li>5 Whys and cause-and-effect analysis</li>
<li>Links to existing risk assessments and SOPs</li><li>Reviewer comments, final approval and close-out</li>
<li>Confidential reporting, visible only to people you authorise</li></ul>
<p>AI can help structure evidence and suggest questions to ask. Its suggestions are labelled as unverified and are never recorded as an established cause.</p>
<p><strong>Statutory reporting:</strong> configurable, versioned rules help you assess whether an event may need external notification, and track the responsible person, due date, submission and evidence. Rules must be verified by your organisation before they are relied on.</p>'''),
 "legal": ("A legal register you can trust", '''
<p>Start with the Occupational Health and Safety Act 85 of 1993, and add your own company requirements. Industry frameworks such as the Mine Health and Safety Act 29 of 1996 can be added for mining customers.</p>
<ul><li>Legal reference, requirement and applicability</li><li>Applicable site or activity, and the responsible person</li>
<li>Compliance evaluation with supporting evidence and findings</li><li>Corrective actions linked to each gap</li>
<li>Assessment date, review date, source reference and version</li>
<li>A clear distinction between legislation, recommended practice and company requirements</li></ul>
<p>A requirement only shows as verified once a second competent person has checked it against the official source and recorded how. If anyone changes the wording, it goes back to "needs verification". OHS Hub helps you manage compliance; it doesn't guarantee it.</p>'''),
 "documents": ("Controlled documents", '''
<ul><li>A document library with categories and reference numbers</li><li>Draft, in review, approved, obsolete and archived statuses</li>
<li>Review and approval workflows, with independent approval enforced when your policy requires it</li>
<li>Version numbers, revision history, change summaries and effective dates</li>
<li>Review-date reminders and employee acknowledgements</li><li>Access permissions by role</li></ul>
<p>When a new version is approved, the previous one is kept with its full audit history. Drafts are always clearly marked so nobody works from an unapproved procedure.</p>'''),
 "actions": ("One corrective action register", '''
<p>Actions arrive from risk assessments, inspections, audits, incident investigations, legal compliance assessments and management reviews.</p>
<ul><li>Unique reference and a link back to the source record</li><li>Priority, responsible person and due date</li>
<li>Evidence attachments</li><li>Verification requirements and outcomes</li><li>Reminders before the due date and when overdue</li></ul>
<p>An action that needs verification can't be closed until someone other than the responsible person has confirmed it worked.</p>'''),
 "training": ("Training and competency", '''
<ul class="two-col"><li>Training matrix: valid, expiring, expired or missing for every person</li><li>Inductions, courses, certificates and licences</li><li>Requirements by job title or department</li>
<li>Certificate uploads</li><li>Expiry dates worked out from each course's validity</li><li>Reminders before training expires</li></ul>
<p>Employees can see their own training records. Export the matrix to CSV.</p>'''),
 "contractors": ("Contractor management", '''
<ul class="two-col"><li>Contractor register and company details</li><li>Safety file and document uploads with expiry dates</li><li>Document review by a manager, never by the uploader</li>
<li>Site induction records</li><li>Site access approved by a manager, only after induction</li><li>Contractor training records and corrective actions</li></ul>
<p>Reminders go out before contractor documents or site access expire.</p>'''),
 "equipment": ("Equipment and PPE", '''
<ul class="two-col"><li>Equipment register by category, site and location</li><li>Inspection intervals and next-due dates</li><li>Inspection, maintenance, defect and repair history</li>
<li>Certificate expiry for lifting and pressure equipment</li><li>Failed inspections and defects take an item out of service</li><li>PPE issued to each employee, with sizes and replacement dates</li></ul>
<p>Reminders go out before inspections, certificates and PPE replacements fall due. Employees see the PPE issued to them.</p>'''),
 "emergency": ("Emergency preparedness", '''
<ul class="two-col"><li>Emergency numbers for each site, visible to everyone</li><li>Tap-to-call on a phone</li><li>Evacuation and emergency drill planning</li>
<li>Drill results: attendance, evacuation time, outcome and observations</li><li>Last drill per site, flagged after a year</li><li>Links to emergency plans and emergency equipment</li></ul>
<p>Corrective actions can be raised from any drill. Available on every plan.</p>'''),
 "reporting": ("Reports from real records", '''
<ul class="two-col"><li>Monthly and quarterly OHS reports</li><li>Incident statistics and near-miss trends</li><li>Inspection compliance</li>
<li>Risk register summaries</li><li>Corrective action performance</li><li>Document review status</li>
<li>Incidents by site</li></ul>
<p>Filter by site, department, date range and incident category. Every report states its period and data scope. AI can write an executive summary of significant changes, but it never invents figures or presents a pattern as a proven cause. Export to PDF, Word and CSV.</p>'''),
}
# Modules included only from the Business plan up (enforced in the database)
BUSINESS_UP = {"legal", "training", "contractors", "equipment"}
toc = "".join(f'<li><a href="#{fid}">{name}</a></li>' for fid, _, name, _ in FEATURES)
details = []
for fid, ic, name, short in FEATURES:
    sub, body = FEATURE_DETAIL[fid]
    tag = '<span class="tag">Business and Enterprise plans</span>' if fid in BUSINESS_UP else ''
    details.append(f'''<section class="detail" id="{fid}" aria-labelledby="{fid}-h">
  <aside>{ICONS[ic]}<h2 id="{fid}-h">{name}</h2>{tag}</aside>
  <div><h3>{sub}</h3>{body}</div>
</section>''')
features = f'''
<section class="page-head"><div class="wrap">
  <h1>Features built around real OHS workflows</h1>
  <p class="lede">Twelve connected modules, one record of truth. Every module listed here is available now; some are included from the Business plan up.</p>
</div></section>
<section class="section section--white" style="padding-top:32px"><div class="wrap">
  <ul class="toc" aria-label="Jump to a feature">{toc}</ul>
  {"".join(details)}
</div></section>
{cta()}'''

# =====================================================================
# INDUSTRIES
# =====================================================================
IND_DETAIL = [
 ("Construction", "Available now", ["Task-specific risk assessments and method statements", "Site inspection checklists for scaffolding, excavations and housekeeping", "Contractor registration, safety files and site access", "Incident reporting from site, on a phone"]),
 ("Mining", "Core modules now; mining modules planned", ["All core OHS modules: risk, inspections, incidents, actions and documents", "Legal register structure ready for Mine Health and Safety Act 29 of 1996 requirements", "Mining-specific modules and reporting are on the roadmap, not yet available"]),
 ("Manufacturing", "Available now", ["Machine and workshop inspections", "Equipment SOPs and lock-out procedures drafted with AI", "PPE issue records with replacement dates", "Incident trends by site and department"]),
 ("Engineering and maintenance", "Available now", ["Job safety analyses and job hazard analyses", "Equipment register with inspection due dates", "Corrective actions linked to defects"]),
 ("Logistics and warehousing", "Available now", ["Racking, forklift and housekeeping checklists", "Near-miss reporting from any employee", "Recurring inspection schedules per site"]),
 ("Transport", "Available now", ["Vehicle inspection checklists", "Driver licence and competency expiry tracking", "Incident investigation for road events"]),
 ("Facilities management", "Available now", ["Multi-site schedules and dashboards", "Fire safety and emergency plan documents", "Contractor management and emergency drills"]),
 ("General commercial businesses", "Available now", ["A baseline risk assessment and emergency plan to start from", "Simple incident reporting for all staff", "Clear dashboards without enterprise complexity"]),
 ("OHS consultants", "Available now", ["Separate companies for each client, with isolated data", "One login across the companies you're invited to", "Consistent templates you can reuse per client"]),
]
ind_blocks = "".join(
    f'''<div class="industry"><h3>{n}</h3><p><span class="tag{' tag--phase' if 'planned' in s else ''}" style="margin:0 0 8px">{s}</span></p>
<ul class="small" style="padding-left:18px;color:var(--ink-2)">{"".join(f"<li>{x}</li>" for x in pts)}</ul></div>''' for n, s, pts in IND_DETAIL)
industries = f'''
<section class="page-head"><div class="wrap">
  <h1>Industries we serve</h1>
  <p class="lede">OHS Hub's core modules work across sectors. Here is what each industry can use today, and what is still on the way.</p>
</div></section>
<section class="section section--white"><div class="wrap"><div class="industry-list">{ind_blocks}</div></div></section>
{cta("Not sure OHS Hub fits your operation?", "Tell us how your sites work and we'll show you what applies.")}'''

# =====================================================================
# PRICING
# =====================================================================
pricing = f'''
<section class="page-head"><div class="wrap">
  <h1>Pricing</h1>
  <p class="lede">Every plan starts with a 14-day free trial of Professional. Commercial pricing is being finalised, so contact us for a quote for your team size.</p>
</div></section>
<section class="section section--white"><div class="wrap">
  <div class="plans" id="plans"></div>
  <div class="faq" style="margin-top:56px">
    <h2>Pricing questions</h2>
    <details><summary>Do I need a card to start the trial?</summary><div><p>No. You can start a 14-day trial without payment details. Online payment isn't switched on yet, so we'll contact you about billing before your trial ends.</p></div></details>
    <details><summary>Are prices in rand and do they include VAT?</summary><div><p>All prices are quoted in South African rand (ZAR). Quotes state clearly whether VAT is included.</p></div></details>
    <details><summary>What happens if we need more users or sites?</summary><div><p>You can move up a plan at any time. Enterprise customers get limits set to their needs.</p></div></details>
    <details><summary>What counts as an AI generation?</summary><div><p>Each draft or section regeneration requested from the AI counts as one generation. Your monthly allowance depends on your plan, and you can see your usage in your account.</p></div></details>
  </div>
</div></section>
{cta("Want a quote for your team?", "Tell us how many people and sites you have.")}'''

# =====================================================================
# RESOURCES
# =====================================================================
resources = f'''
<section class="page-head"><div class="wrap">
  <h1>Resources</h1>
  <p class="lede">Official sources and plain-language guidance on how OHS Hub works.</p>
</div></section>
<section class="section"><div class="wrap">
  <h2>Official sources</h2>
  <div class="res-list" style="margin-bottom:48px">
    <a class="res" href="https://www.gov.za/documents/occupational-health-and-safety-act" rel="noopener" target="_blank">
      <h3>Occupational Health and Safety Act 85 of 1993</h3><p>The full text of the Act on the South African Government website.</p><span class="src">gov.za (opens in a new tab)</span></a>
    <a class="res" href="https://inforegulator.org.za/" rel="noopener" target="_blank">
      <h3>Information Regulator (South Africa)</h3><p>The regulator responsible for the Protection of Personal Information Act (POPIA).</p><span class="src">inforegulator.org.za (opens in a new tab)</span></a>
  </div>
  <h2>About OHS Hub</h2>
  <div class="res-list">
    <a class="res" href="features.html#ai-sop"><h3>How AI drafting works</h3><p>What the AI does, what it doesn't do, and why every draft needs approval.</p></a>
    <a class="res" href="features.html#ai-risk"><h3>How risk scores are calculated</h3><p>Configurable 3×3 and 5×5 matrices, scored the same way every time.</p></a>
    <a class="res" href="popia.html"><h3>POPIA and data protection</h3><p>How we protect employee information, incident evidence and medical details.</p></a>
    <a class="res" href="faq.html"><h3>Frequently asked questions</h3><p>Trials, security, AI, data ownership and support.</p></a>
  </div>
</div></section>
{cta()}'''

# =====================================================================
# ABOUT
# =====================================================================
about = f'''
<section class="page-head"><div class="wrap">
  <h1>About OHS Hub</h1>
  <p class="lede">OHS Hub is built by iHubSA, a South African company that turns paperwork, spreadsheets and manual processes into secure online systems.</p>
</div></section>
<section class="section section--white"><div class="wrap prose">
  <h2>Why we built it</h2>
  <p>Safety professionals spend too much of their time chasing paper: risk assessments in one folder, inspection sheets in another, incident reports in an inbox and corrective actions in a spreadsheet nobody updates. OHS Hub brings those records into one connected system, so the time goes back to the work that protects people.</p>
  <h2>What we believe</h2>
  <ul>
    <li><strong>Competent people make the decisions.</strong> AI drafts and suggests. Your safety professionals review and approve.</li>
    <li><strong>Numbers must be real.</strong> Dashboards and reports come only from records in your system.</li>
    <li><strong>Legal references must be verifiable.</strong> Anything not matched to a verified source is labelled as needing verification.</li>
    <li><strong>Your data is yours.</strong> Each company's records are isolated at database level and handled in line with POPIA.</li>
  </ul>
  <h2>Who we are</h2>
  <p>iHubSA is based in Fish Hoek, Western Cape, and builds business systems, databases, dashboards and SaaS platforms for South African organisations.</p>
  <p><a class="btn btn-secondary" href="contact.html">Get in touch</a></p>
</div></section>
{cta()}'''

# =====================================================================
# CONTACT
# =====================================================================
contact = f'''
<section class="page-head"><div class="wrap">
  <h1>Contact us</h1>
  <p class="lede">Ask a question, request a walkthrough or talk to us about pricing. We'll reply by email.</p>
</div></section>
<section class="section"><div class="wrap contact-grid">
  <div class="panel">
    <form id="contact-form" class="form" novalidate>
      <div id="contact-status" class="alert" role="status" tabindex="-1" hidden></div>
      <div class="form-row">
        <div class="field"><label for="full_name">Full name</label><input id="full_name" name="full_name" autocomplete="name" required maxlength="120"><p class="error"></p></div>
        <div class="field"><label for="email">Work email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="200"><p class="error"></p></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="company">Company <span class="muted">(optional)</span></label><input id="company" name="company" autocomplete="organization" maxlength="160"></div>
        <div class="field"><label for="company_size">Number of employees <span class="muted">(optional)</span></label>
          <select id="company_size" name="company_size"><option value="">Select</option><option>1–20</option><option>21–50</option><option>51–200</option><option>201–1000</option><option>More than 1000</option></select></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="industry">Industry <span class="muted">(optional)</span></label>
          <select id="industry" name="industry"><option value="">Select</option><option>Construction</option><option>Mining</option><option>Manufacturing</option><option>Engineering and maintenance</option><option>Logistics and warehousing</option><option>Transport</option><option>Facilities management</option><option>General commercial</option><option>OHS consultancy</option></select></div>
        <div class="field"><label for="topic">What is this about?</label>
          <select id="topic" name="topic"><option value="general">General question</option><option value="demo">Book a walkthrough</option><option value="pricing">Pricing and quotes</option><option value="partnership">Partnerships</option><option value="support">Support</option></select></div>
      </div>
      <div class="field"><label for="message">Message</label><textarea id="message" name="message" required maxlength="4000"></textarea><p class="error"></p></div>
      <div class="hp" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
      <div class="check-field"><label class="check"><input type="checkbox" name="consent" id="consent" required>
        <span>I agree that iHubSA may use these details to respond to my enquiry, as described in the <a href="privacy.html">privacy policy</a>.</span></label><p class="error" style="margin-left:32px"></p></div>
      <div><button class="btn btn-primary" type="submit">Send message</button></div>
    </form>
  </div>
  <div>
    <h2 style="font-size:1.5rem">Email</h2>
    <p><a href="mailto:{ENQ}">{ENQ}</a></p>
    <h2 style="font-size:1.5rem;margin-top:28px">Office</h2>
    <p>iHubSA<br>Fish Hoek, Western Cape<br>South Africa</p>
  </div>
</div></section>'''

# =====================================================================
# FAQ
# =====================================================================
FAQ = [
 ("Getting started", [
   ("What is OHS Hub?", "A web application that brings risk assessments, inspections, incidents, corrective actions, safety documents and compliance tracking into one system, with AI to help draft safety documentation."),
   ("Do I need to install anything?", "No. OHS Hub runs in a web browser on computers, tablets and phones."),
   ("How long is the free trial?", "14 days on the Professional plan. No card details are needed to start."),
 ]),
 ("AI and compliance", [
   ("Will AI-generated documents make us compliant?", "No software can guarantee compliance. AI drafts are a starting point that a competent person must review, adjust and approve. OHS Hub records who reviewed and approved each document."),
   ("Does the AI decide our risk ratings?", "No. Risk scores are calculated by the system from your approved matrix. The AI can suggest hazards and controls, which you can accept, change or reject."),
   ("Where do the legal references come from?", "From the legal register, where requirements are added and verified through a review process. If a reference can't be matched to a verified source, it is clearly marked as needing verification."),
   ("Is our data used to train AI models?", "Your records are sent to the AI provider only when you ask for a draft, and only the information that draft needs. We use provider settings that don't allow your data to be used for model training. Details are in the privacy policy."),
 ]),
 ("Security and data", [
   ("Can other companies see our records?", "No. Every record belongs to one company, and access is enforced by the database itself, not just hidden in the screens. This separation is tested automatically."),
   ("Where is our data stored?", "In a managed PostgreSQL database and private file storage provided by Supabase. Files are only available through short-lived, signed links."),
   ("Who owns the data?", "You do. You can export your records, and you can ask for them to be deleted when you leave."),
   ("How do you handle POPIA?", "We collect only what each workflow needs, restrict sensitive records such as injury details and confidential incidents to authorised roles, and keep an audit trail. See our POPIA page for details."),
 ]),
 ("Account and support", [
   ("Can one person work across several companies?", "Yes. A consultant can be invited to several client companies and switch between them, with each company's data kept separate."),
   ("How do I get help?", f"Email {ENQ} or use the contact form on this site."),
 ]),
]
faq_html = "".join(f'<div class="faq-group"><h2>{g}</h2>' + "".join(
    f'<details><summary>{q}</summary><div><p>{a}</p></div></details>' for q, a in items) + '</div>' for g, items in FAQ)
faq = f'''
<section class="page-head"><div class="wrap"><h1>Frequently asked questions</h1>
<p class="lede">Can't find your answer? <a href="contact.html">Contact us</a>.</p></div></section>
<section class="section section--white"><div class="wrap faq">{faq_html}</div></section>
{cta()}'''
faq_ld = '<script type="application/ld+json">' + __import__("json").dumps({
    "@context": "https://schema.org", "@type": "FAQPage",
    "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for _, items in FAQ for q, a in items]
}) + '</script>'

# =====================================================================
# LEGAL PAGES (drafts)
# =====================================================================
PH = lambda s: f'<span class="placeholder">[{s}]</span>'
privacy = f'''
<section class="page-head"><div class="wrap"><h1>Privacy policy</h1><p class="lede">How iHubSA collects, uses and protects personal information on the OHS Hub website and platform.</p></div></section>
<section class="section section--white"><div class="wrap prose">
{draft_notice("privacy policy")}
<p><strong>Last updated:</strong> {PH("DATE OF PUBLICATION")}</p>
<h2>1. Who we are</h2>
<p>OHS Hub is operated by iHubSA {PH("REGISTERED COMPANY NAME AND REGISTRATION NUMBER")}, Fish Hoek, Western Cape, South Africa ("we", "us"). For POPIA purposes our Information Officer is Brent Proctor, contactable at <a href="mailto:{ENQ}">{ENQ}</a>.</p>
<h2>2. Two roles we play</h2>
<p><strong>Website visitors and account holders:</strong> we are the responsible party for the information you give us when you contact us, register or manage your subscription.</p>
<p><strong>Customer OHS records:</strong> when your company records employees, incidents, training or other OHS information in the platform, your company is the responsible party and we process that information on its behalf as an operator, under our <a href="terms.html">terms</a>.</p>
<h2>3. Information we collect</h2>
<ul><li>Contact enquiries: name, email address, company, industry, company size and your message.</li>
<li>Accounts: name, email address, job title, company details, and sign-in and security logs.</li>
<li>Platform records entered by customers: workforce details, risk, inspection, incident, training and document records, including photographs and evidence files.</li>
<li>Technical information: IP address (stored only as a one-way hash for abuse prevention), browser type and error logs.</li></ul>
<p>We don't use advertising cookies or third-party tracking on this website.</p>
<h2>4. Why we use it</h2>
<ul><li>To respond to enquiries and provide the service you sign up for.</li><li>To send service notifications such as approvals, reminders and overdue actions.</li>
<li>To keep the platform secure, prevent abuse and keep audit trails.</li><li>To meet legal obligations.</li></ul>
<h2>5. Special personal information</h2>
<p>Incident and health-related records may include special personal information. Access is limited to roles your company authorises, confidential incidents are restricted further, and these records are never used for any purpose other than providing the service.</p>
<h2>6. Service providers</h2>
<table><thead><tr><th>Provider</th><th>Purpose</th><th>Location</th></tr></thead><tbody>
<tr><td>Supabase</td><td>Database, authentication and file storage</td><td>{PH("CONFIRM REGION")}</td></tr>
<tr><td>Resend</td><td>Transactional email</td><td>{PH("CONFIRM REGION")}</td></tr>
<tr><td>{PH("AI PROVIDER")}</td><td>Drafting documents when a user requests it</td><td>{PH("CONFIRM REGION")}</td></tr>
<tr><td>GitHub Pages</td><td>Hosting of the public website</td><td>United States</td></tr></tbody></table>
<p>Where information is transferred outside South Africa, we rely on the safeguards permitted by section 72 of POPIA {PH("CONFIRM BASIS WITH LEGAL ADVISER")}.</p>
<h2>7. How long we keep it</h2>
<p>Enquiries: {PH("RETENTION PERIOD")}. Account and platform data: for the duration of the subscription, then deleted or returned within {PH("PERIOD")} unless the law requires longer retention. Audit logs: {PH("RETENTION PERIOD")}.</p>
<h2>8. Your rights</h2>
<p>You may ask to access, correct or delete your personal information, or object to its processing, by emailing <a href="mailto:{ENQ}">{ENQ}</a>. If your information is held as part of your employer's OHS records, we'll pass your request to your employer. You may also lodge a complaint with the <a href="https://inforegulator.org.za/" rel="noopener">Information Regulator</a>.</p>
<h2>9. Security</h2>
<p>Data is encrypted in transit, access is controlled by database-level security rules for each company, files are private and shared only through short-lived links, and significant actions are logged.</p>
</div></section>'''

terms = f'''
<section class="page-head"><div class="wrap"><h1>Terms and conditions</h1><p class="lede">The terms that apply when you use the OHS Hub website and platform.</p></div></section>
<section class="section section--white"><div class="wrap prose">
{draft_notice("document")}
<p><strong>Last updated:</strong> {PH("DATE OF PUBLICATION")}</p>
<h2>1. Agreement</h2><p>These terms form an agreement between iHubSA {PH("REGISTERED COMPANY NAME AND REGISTRATION NUMBER")} and the organisation that registers for OHS Hub ("the Customer").</p>
<h2>2. The service</h2><p>OHS Hub is a software tool that helps the Customer manage occupational health and safety records and processes. It doesn't replace the Customer's legal duties, its competent persons, or professional advice.</p>
<h2>3. AI-generated content</h2><p>Drafts produced with AI are suggestions only. The Customer is responsible for having a competent person review, amend and approve any document before it is used. We don't warrant that AI-generated content is complete, accurate or legally compliant.</p>
<h2>4. Legal references</h2><p>The legal register is a management tool. References marked "needs verification" have not been confirmed against an authoritative source. The Customer remains responsible for identifying and meeting its legal obligations.</p>
<h2>5. Customer data</h2><p>The Customer owns its data. We process it as an operator on the Customer's instructions and in line with our <a href="privacy.html">privacy policy</a> and POPIA. {PH("OPERATOR AGREEMENT / DATA PROCESSING TERMS")}</p>
<h2>6. Accounts and security</h2><p>The Customer controls who has access and which roles they hold, and must keep login details confidential.</p>
<h2>7. Trials, plans and fees</h2><p>Trials last for the period stated at sign-up. Fees, limits and billing terms are as quoted to the Customer. {PH("PAYMENT TERMS, VAT, CANCELLATION")}</p>
<h2>8. Availability</h2><p>We aim for high availability but don't guarantee uninterrupted service. {PH("SERVICE LEVELS, IF ANY")}</p>
<h2>9. Limitation of liability</h2><p>{PH("LIABILITY CLAUSE TO BE DRAFTED BY LEGAL ADVISER")}</p>
<h2>10. Termination</h2><p>On termination the Customer may export its data within {PH("PERIOD")}, after which it will be deleted unless retention is legally required.</p>
<h2>11. Governing law</h2><p>These terms are governed by the laws of the Republic of South Africa.</p>
<h2>12. Contact</h2><p><a href="mailto:{ENQ}">{ENQ}</a></p>
</div></section>'''

popia = f'''
<section class="page-head"><div class="wrap"><h1>POPIA and data protection</h1><p class="lede">How OHS Hub is designed to help you handle employee and incident information responsibly under the Protection of Personal Information Act.</p></div></section>
<section class="section section--white"><div class="wrap prose">
{draft_notice("page")}
<h2>Built-in safeguards</h2>
<ul>
<li><strong>Company separation:</strong> every record belongs to one company, and the database refuses access from any other company.</li>
<li><strong>Role-based access:</strong> employees see approved documents and their own reports and actions; managers see what their role requires; auditors have read-only access.</li>
<li><strong>Confidential incidents:</strong> can be restricted to named, authorised people.</li>
<li><strong>Data minimisation:</strong> workforce records don't ask for ID numbers or medical history. Injury details are captured only where an incident requires them.</li>
<li><strong>Private files:</strong> evidence and certificates are stored privately and opened through short-lived links.</li>
<li><strong>Audit trail:</strong> significant changes are logged with who made them and when.</li>
<li><strong>AI requests:</strong> only the information needed for the requested draft is sent, and your records aren't used to train AI models.</li>
</ul>
<h2>Your responsibilities as the responsible party</h2>
<p>Your company decides what OHS information to record, who may access it and how long to keep it. OHS Hub gives you the tools; your Information Officer remains accountable for your processing.</p>
<h2>Information Officer</h2>
<p>iHubSA's Information Officer is Brent Proctor. Contact: <a href="mailto:{ENQ}">{ENQ}</a>. {PH("INFORMATION REGULATOR REGISTRATION REFERENCE")}</p>
<h2>Requests and complaints</h2>
<p>To request access, correction or deletion, email us. You may also contact the <a href="https://inforegulator.org.za/" rel="noopener">Information Regulator</a>.</p>
</div></section>'''

# =====================================================================
# AUTH PAGES
# =====================================================================
auth_side = '''<div class="auth-side">
  <h2>One place for your OHS system</h2>
  <ul><li>Risk assessments scored by your own matrix</li><li>Inspections and incident reports from a phone</li>
  <li>AI first drafts, approved by your competent person</li><li>Each company's data kept separate and secure</li></ul>
</div>'''

signin = f'''<div class="auth">{auth_side}
<div class="auth-main"><div class="auth-box">
  <h1>Sign in</h1>
  <div id="auth-status" class="alert" role="status" hidden></div>
  <form id="signin-form" class="form" data-auth novalidate style="margin-top:16px">
    <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required><p class="error"></p></div>
    <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><p class="error"></p></div>
    <button class="btn btn-primary btn-block" type="submit">Sign in</button>
  </form>
  <details style="margin-top:22px"><summary style="cursor:pointer;font-weight:600">Forgot your password?</summary>
    <form id="forgot-form" class="form" data-auth novalidate style="margin-top:14px">
      <div class="field"><label for="forgot-email">Email</label><input id="forgot-email" name="email" type="email" autocomplete="email" required><p class="error"></p></div>
      <button class="btn btn-secondary btn-block" type="submit">Send reset link</button>
    </form></details>
  <div class="auth-links"><span>New to OHS Hub? <a href="register.html" data-keep-invite>Create an account</a></span></div>
</div></div></div>'''

register = f'''<div class="auth">{auth_side}
<div class="auth-main"><div class="auth-box">
  <h1>Start your free trial</h1>
  <p class="muted">14 days on Professional. No card details needed.</p>
  <div id="auth-status" class="alert" role="status" hidden></div>
  <form id="register-form" class="form" data-auth novalidate style="margin-top:16px">
    <div class="field"><label for="full_name">Full name</label><input id="full_name" name="full_name" autocomplete="name" required maxlength="120"><p class="error"></p></div>
    <div class="field"><label for="company_name">Company name</label><input id="company_name" name="company_name" autocomplete="organization" required maxlength="160"><p class="error"></p></div>
    <div class="field"><label for="industry">Industry</label>
      <select id="industry" name="industry"><option value="general">General commercial</option><option value="construction">Construction</option><option value="mining">Mining</option><option value="manufacturing">Manufacturing</option><option value="engineering_maintenance">Engineering and maintenance</option><option value="logistics_warehousing">Logistics and warehousing</option><option value="transport">Transport</option><option value="facilities_management">Facilities management</option><option value="ohs_consultancy">OHS consultancy</option></select></div>
    <div class="field"><label for="email">Work email</label><input id="email" name="email" type="email" autocomplete="email" required><p class="error"></p></div>
    <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="10"><p class="hint">At least 10 characters, including a letter and a number.</p><p class="error"></p></div>
    <input type="hidden" name="plan" value="professional">
    <div class="check-field"><label class="check"><input type="checkbox" name="terms" required><span>I accept the <a href="terms.html">terms and conditions</a> and <a href="privacy.html">privacy policy</a>.</span></label><p class="error" style="margin-left:32px"></p></div>
    <button class="btn btn-primary btn-block" type="submit">Create account</button>
  </form>
  <div class="auth-links"><span>Already registered? <a href="signin.html" data-keep-invite>Sign in</a></span></div>
</div></div></div>'''

reset = f'''<div class="auth">{auth_side}
<div class="auth-main"><div class="auth-box">
  <h1>Choose a new password</h1>
  <div id="auth-status" class="alert" role="status" hidden></div>
  <form id="reset-form" class="form" data-auth novalidate style="margin-top:16px">
    <div class="field"><label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" required><p class="hint">At least 10 characters, including a letter and a number.</p><p class="error"></p></div>
    <div class="field"><label for="confirm">Confirm new password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required><p class="error"></p></div>
    <button class="btn btn-primary btn-block" type="submit">Save new password</button>
  </form>
  <div class="auth-links"><a href="signin.html">Back to sign in</a></div>
</div></div></div>'''

notfound = '''<section class="page-head" style="border:0"><div class="wrap">
<h1>This page doesn't exist</h1><p class="lede">The link may be out of date. Try the <a href="index.html">home page</a> or <a href="contact.html">contact us</a>.</p></div></section>'''

PAGES = [
    ("index.html", "OHS Hub | Occupational Health and Safety Management Software for South Africa",
     "Manage risk assessments, inspections, incidents, corrective actions and safety documents in one platform, with AI-assisted drafting for South African workplaces.", home, {"extra_head": jsonld}),
    ("features.html", "Features", "AI SOP and risk assessment drafting, digital inspections, incident investigation, legal register, document control, corrective actions and OHS reporting.", features, {}),
    ("industries.html", "Industries", "OHS Hub for construction, mining, manufacturing, engineering, logistics, transport, facilities management, commercial businesses and OHS consultants.", industries, {}),
    ("pricing.html", "Pricing", "OHS Hub plans for South African businesses: Starter, Professional, Business and Enterprise. Start with a 14-day free trial.", pricing, {}),
    ("resources.html", "Resources", "Official South African OHS and data protection sources, and guidance on how OHS Hub's AI drafting and risk scoring work.", resources, {}),
    ("about.html", "About us", "OHS Hub is built by iHubSA in Fish Hoek, Western Cape, to bring South African safety records into one connected system.", about, {}),
    ("contact.html", "Contact us", "Contact the OHS Hub team for questions, walkthroughs, pricing or support.", contact, {}),
    ("faq.html", "Frequently asked questions", "Answers about OHS Hub trials, AI drafting, legal references, data security, POPIA and support.", faq, {"extra_head": faq_ld}),
    ("privacy.html", "Privacy policy", "How iHubSA collects, uses and protects personal information on the OHS Hub website and platform.", privacy, {}),
    ("terms.html", "Terms and conditions", "Terms of use for the OHS Hub website and platform.", terms, {}),
    ("popia.html", "POPIA and data protection", "How OHS Hub helps you protect employee and incident information under POPIA.", popia, {}),
    ("signin.html", "Sign in", "Sign in to your OHS Hub workspace.", signin, {"scripts": ("site.js", "auth.js"), "page_id": "signin"}),
    ("register.html", "Start your free trial", "Create an OHS Hub account and start a 14-day free trial.", register, {"scripts": ("site.js", "auth.js"), "page_id": "register"}),
    ("reset-password.html", "Reset password", "Choose a new password for your OHS Hub account.", reset, {"scripts": ("site.js", "auth.js"), "page_id": "reset", "noindex": True}),
    ("404.html", "Page not found", "This page could not be found.", notfound, {"noindex": True}),
]

def main():
    for fn, title, desc, body, opts in PAGES:
        (ROOT / fn).write_text(page(fn, title, desc, body, **opts), encoding="utf-8")
    # sitemap + robots
    urls = [p[0] for p in PAGES if not p[4].get("noindex")]
    sm = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in urls:
        loc = SITE_URL + ("" if u == "index.html" else u)
        pri = "1.0" if u == "index.html" else ("0.8" if u in ("features.html", "pricing.html", "industries.html") else "0.5")
        sm.append(f"  <url><loc>{loc}</loc><lastmod>{TODAY}</lastmod><priority>{pri}</priority></url>")
    sm.append("</urlset>")
    (ROOT / "sitemap.xml").write_text("\n".join(sm) + "\n", encoding="utf-8")
    (ROOT / "robots.txt").write_text(f"User-agent: *\nAllow: /\nDisallow: /app/\n\nSitemap: {SITE_URL}sitemap.xml\n", encoding="utf-8")
    print(f"Built {len(PAGES)} pages")

if __name__ == "__main__":
    main()
