/**
 * Curated product knowledge for plotwell's internal marketing tools.
 * This module provides structured product context that AI tools use
 * to generate accurate, on-brand content.
 *
 * Source of truth: plotwell-app/ and plotwell-backend/ docs.
 * Update this file when major features ship or pricing changes.
 */

/* ------------------------------------------------------------------ */
/*  Core product info                                                  */
/* ------------------------------------------------------------------ */

export const PRODUCT = {
  name: "plotwell",
  tagline: "Professional screenplay editor and production planning platform",
  url: "https://plotwell.co",
  positioning: "The modern alternative to Final Draft and Celtx. Combines script editing, AI writing assistance, and production planning in one tool.",
  competitors: ["Final Draft", "Celtx", "WriterSolo", "Arc Studio Pro", "Highland"],
  targetAudience: [
    "Independent screenwriters",
    "Film students",
    "TV showrunners and writers rooms",
    "Indie filmmakers and producers",
    "Content creators moving into episodic formats",
    "Production coordinators and ADs",
  ],
  differentiators: [
    "AI natively integrated (not bolted on) throughout the workflow",
    "Script editor + production planning in one platform",
    "Real-time collaboration built for writers rooms",
    "TV series support with seasons, episodes, and per-episode tools",
    "Modern web app (no desktop install), works anywhere",
    "Affordable pricing vs legacy tools",
  ],
};

/* ------------------------------------------------------------------ */
/*  Feature catalog                                                    */
/* ------------------------------------------------------------------ */

export interface Feature {
  name: string;
  category: "writing" | "ai" | "production" | "collaboration" | "export";
  description: string;
  userBenefit: string;
}

export const FEATURES: Feature[] = [
  // Writing
  {
    name: "Script Editor",
    category: "writing",
    description: "TipTap-based screenplay editor with auto-formatting for scene headings, action, dialogue, parentheticals, and transitions.",
    userBenefit: "Write in proper screenplay format without thinking about formatting rules.",
  },
  {
    name: "Beat Sheet View",
    category: "writing",
    description: "Visual beat sheet planner with drag-and-drop reordering. Supports Save the Cat, three-act, and custom structures.",
    userBenefit: "Plan your story structure before writing a single scene.",
  },
  {
    name: "Outline View",
    category: "writing",
    description: "High-level story outline with act/sequence organization.",
    userBenefit: "See the big picture of your story at a glance.",
  },
  {
    name: "Concept View",
    category: "writing",
    description: "Project concept document with logline, synopsis, themes, and tone.",
    userBenefit: "Keep your creative vision organized and shareable.",
  },
  {
    name: "Characters View",
    category: "writing",
    description: "Character profiles with AI-powered personality generation, images, arcs, and relationships.",
    userBenefit: "Build rich, consistent characters with AI assistance.",
  },
  {
    name: "Locations View",
    category: "writing",
    description: "Location database with images, descriptions, and production notes.",
    userBenefit: "Organize every location in your project with visual references.",
  },
  {
    name: "TV Series Mode",
    category: "writing",
    description: "Seasons and episodes management. Each episode gets its own script, storyboard, and production breakdown.",
    userBenefit: "Manage multi-episode projects with per-episode tools and cross-episode character/location sharing.",
  },

  // AI
  {
    name: "AI Scene Generation",
    category: "ai",
    description: "Generate full screenplay scenes from brief descriptions or outlines. AI understands screenplay format natively.",
    userBenefit: "Turn a one-line idea into a fully formatted scene in seconds.",
  },
  {
    name: "AI Script Doctor",
    category: "ai",
    description: "AI-powered script analysis that provides feedback on pacing, dialogue, structure, and character consistency.",
    userBenefit: "Get professional-level script notes without waiting for a human reader.",
  },
  {
    name: "AI Brainstorming Chat",
    category: "ai",
    description: "Context-aware AI chat that knows your project's characters, locations, and story. Brainstorm plot ideas, dialogue, and solutions.",
    userBenefit: "Have a creative partner who knows your entire project.",
  },
  {
    name: "Inline Autocomplete",
    category: "ai",
    description: "AI suggests the next line as you type, understanding screenplay context and your writing style.",
    userBenefit: "Write faster with intelligent suggestions that feel like your own voice.",
  },
  {
    name: "AI Storyboard Generation",
    category: "ai",
    description: "Generate storyboard images from scene descriptions using AI image models.",
    userBenefit: "Visualize your scenes without needing to hire an artist for pre-production.",
  },

  // Production
  {
    name: "Scene Breakdown",
    category: "production",
    description: "Automated scene breakdown with cast, props, wardrobe, vehicles, and special effects extraction from the script.",
    userBenefit: "Go from script to production breakdown in minutes instead of days.",
  },
  {
    name: "Call Sheet Generator",
    category: "production",
    description: "Generate professional call sheets with crew details, location info, weather, and scene schedule.",
    userBenefit: "Create production-ready call sheets directly from your script.",
  },
  {
    name: "Budget View",
    category: "production",
    description: "Budget tracking and analytics with category breakdowns and spending forecasts.",
    userBenefit: "Keep your production budget organized and visible to the whole team.",
  },
  {
    name: "Cast & Crew Management",
    category: "production",
    description: "Manage cast assignments, crew roles, and contact information.",
    userBenefit: "Keep your entire team organized in one place.",
  },
  {
    name: "Filming Locations",
    category: "production",
    description: "Map-based filming location management with scouting notes, permits, and logistics.",
    userBenefit: "Plan your shoot locations with all the practical details in one view.",
  },

  // Collaboration
  {
    name: "Real-time Collaboration",
    category: "collaboration",
    description: "Multiple writers can edit the same script simultaneously with live cursors and presence indicators. Built on Y.js CRDT.",
    userBenefit: "Run a virtual writers room with real-time co-editing.",
  },
  {
    name: "Comments & Annotations",
    category: "collaboration",
    description: "Threaded comments on any part of the script with reactions and resolution workflow.",
    userBenefit: "Give and receive precise feedback without leaving the editor.",
  },
  {
    name: "Team Roles",
    category: "collaboration",
    description: "Role-based access control: owner, admin, editor, viewer. Invite collaborators via email.",
    userBenefit: "Control who can edit vs. who can only view your project.",
  },

  // Export
  {
    name: "PDF Export",
    category: "export",
    description: "Export scripts as industry-standard PDF with cover page, scene numbers, and revision marks.",
    userBenefit: "Send polished, professional scripts to agents, producers, or crew.",
  },
  {
    name: "FDX & Fountain Import",
    category: "export",
    description: "Import scripts from Final Draft (.fdx) and Fountain (.fountain) formats.",
    userBenefit: "Bring your existing scripts into plotwell without starting over.",
  },
  {
    name: "Storyboard Editor",
    category: "export",
    description: "Visual storyboard with panel management, drag-and-drop reordering, shot types, and camera movements.",
    userBenefit: "Plan every shot of your film with a professional storyboard.",
  },
];

/* ------------------------------------------------------------------ */
/*  Pricing (keep in sync with plotwell-backend/src/config/pricingPlans.ts) */
/* ------------------------------------------------------------------ */

export const PRICING = {
  currency: "EUR",
  plans: [
    {
      id: "free",
      name: "Free",
      price: 0,
      billing: null,
      limits: {
        projects: 1,
        aiCredits: 50,
        collaborators: 0,
        storage: "100 MB",
      },
      features: [
        "1 project",
        "50 AI credits/month",
        "Script editor with formatting",
        "PDF export",
        "Beat sheet view",
      ],
    },
    {
      id: "paid",
      name: "Pro",
      price: 15,
      billing: "monthly",
      limits: {
        projects: 10,
        aiCredits: 500,
        collaborators: 3,
        storage: "5 GB",
      },
      features: [
        "10 projects",
        "500 AI credits/month",
        "All writing & production tools",
        "Real-time collaboration (3 seats)",
        "TV series mode",
        "Storyboard with AI images",
        "Scene breakdown & call sheets",
        "Priority support",
      ],
    },
  ],
  addons: [
    { name: "Extra Projects", price: 3, unit: "project/month" },
    { name: "Extra Collaborators", price: 5, unit: "seat/month" },
    { name: "AI Credit Pack", price: 5, amount: "200 credits" },
  ],
};

/* ------------------------------------------------------------------ */
/*  Formatted context for AI prompts                                   */
/* ------------------------------------------------------------------ */

export function getProductContext(): string {
  const featuresByCategory = FEATURES.reduce(
    (acc, f) => {
      if (!acc[f.category]) acc[f.category] = [];
      acc[f.category].push(f);
      return acc;
    },
    {} as Record<string, Feature[]>
  );

  const featureList = Object.entries(featuresByCategory)
    .map(
      ([cat, features]) =>
        `${cat.charAt(0).toUpperCase() + cat.slice(1)}:\n${features
          .map((f) => `  - ${f.name}: ${f.description}`)
          .join("\n")}`
    )
    .join("\n\n");

  return `PRODUCT: ${PRODUCT.name}
${PRODUCT.tagline}
URL: ${PRODUCT.url}

POSITIONING: ${PRODUCT.positioning}

TARGET AUDIENCE: ${PRODUCT.targetAudience.join(", ")}

KEY DIFFERENTIATORS:
${PRODUCT.differentiators.map((d) => `- ${d}`).join("\n")}

FEATURES:
${featureList}

PRICING:
- Free: ${PRICING.plans[0].features.join(", ")}
- Pro (${PRICING.plans[1].price} EUR/mo): ${PRICING.plans[1].features.join(", ")}

COMPETITORS: ${PRODUCT.competitors.join(", ")}
plotwell's advantage: modern web app with AI + production tools vs legacy desktop-only editors.`;
}

/** Short context for prompts that need to be concise */
export function getProductContextShort(): string {
  return `${PRODUCT.name} is a ${PRODUCT.tagline.toLowerCase()}.
Key features: script editor, AI scene generation, AI Script Doctor, beat sheets, storyboards, real-time collaboration, TV series mode, scene breakdowns, call sheets, budget tracking.
Target: screenwriters, filmmakers, TV showrunners, indie producers.
Free plan (1 project, 50 AI credits) and Pro plan (15 EUR/mo, 10 projects, 500 AI credits, collaboration).
Differentiator: AI natively integrated + script editor + production planning in one tool.`;
}
