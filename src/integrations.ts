export interface ContentIdeaSummary {
  id: string;
  title: string;
  category: string;
  niche: string;
  tags: string[];
  status: string;
}

export interface ScoredIdeaRecommendation {
  ideaId: string;
  title: string;
  category: string;
  niche: string;
  score: number;
  matchedTags: string[];
  reason: string;
}

export interface ContentResearchProvider {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
  readonly statusLabel: "Connected" | "Not Connected";
  readonly description: string;
}

export interface SocialPublishingIntegration {
  readonly platform: "instagram" | "tiktok";
  readonly displayName: string;
  readonly connected: boolean;
  readonly statusLabel: "Connected" | "Not Connected";
  readonly missingCredentials: string[];
  readonly note: string;
}

export class RuleBasedIdeaRecommender {
  /**
   * Scores candidate ideas strictly using tags, category, and niche overlap
   * with the client's previously approved content.
   */
  recommend(
    ideas: ContentIdeaSummary[],
    preferredTags: string[],
    clientNiche = ""
  ): ScoredIdeaRecommendation[] {
    const approvedIdeas = ideas.filter((i) => i.status === "approved");
    const approvedTagFreq = new Map<string, number>();
    const approvedCategoryFreq = new Map<string, number>();

    for (const t of preferredTags) {
      const norm = t.trim().toLowerCase();
      if (norm) approvedTagFreq.set(norm, (approvedTagFreq.get(norm) || 0) + 2);
    }

    for (const idea of approvedIdeas) {
      const cat = (idea.category || "").trim().toLowerCase();
      if (cat) approvedCategoryFreq.set(cat, (approvedCategoryFreq.get(cat) || 0) + 1);
      for (const t of idea.tags || []) {
        const norm = t.trim().toLowerCase();
        if (norm) approvedTagFreq.set(norm, (approvedTagFreq.get(norm) || 0) + 1);
      }
    }

    const nicheNorm = clientNiche.trim().toLowerCase();
    const candidates = ideas.filter((i) => i.status !== "rejected");

    const scored: ScoredIdeaRecommendation[] = candidates.map((idea) => {
      let score = 0;
      const matchedTags: string[] = [];
      for (const rawTag of idea.tags || []) {
        const tag = rawTag.trim().toLowerCase();
        const weight = approvedTagFreq.get(tag) || 0;
        if (weight > 0) {
          score += weight * 10;
          matchedTags.push(rawTag);
        }
      }
      const cat = (idea.category || "").trim().toLowerCase();
      if (cat && approvedCategoryFreq.has(cat)) {
        score += (approvedCategoryFreq.get(cat) || 0) * 8;
      }
      if (nicheNorm && (idea.niche || "").trim().toLowerCase().includes(nicheNorm)) {
        score += 12;
      }
      if (idea.status === "approved") {
        score += 5;
      }

      const reasons: string[] = [];
      if (matchedTags.length > 0) {
        reasons.push(`Matches approved tags: ${matchedTags.join(", ")}`);
      }
      if (cat && approvedCategoryFreq.has(cat)) {
        reasons.push(`Category "${idea.category}" previously approved`);
      }
      if (nicheNorm && (idea.niche || "").trim().toLowerCase().includes(nicheNorm)) {
        reasons.push(`Aligned with niche "${clientNiche}"`);
      }

      return {
        ideaId: idea.id,
        title: idea.title,
        category: idea.category,
        niche: idea.niche,
        score,
        matchedTags,
        reason: reasons.length > 0 ? reasons.join(" · ") : "New candidate idea",
      };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }
}

export function getResearchProvidersStatus(): ContentResearchProvider[] {
  return [
    {
      id: "rule_recommender",
      name: "Tag & Approval Rule Scorer",
      connected: true,
      statusLabel: "Connected",
      description:
        "Deterministic tag, category, and niche scoring built from approved client ideas.",
    },
    {
      id: "external_ai_research",
      name: "External AI Research Provider",
      connected: false,
      statusLabel: "Not Connected",
      description:
        "Modular provider interface ready for an explicitly configured API key; no live scraping or external LLM is active.",
    },
  ];
}

export function getPublishingIntegrationsStatus(): SocialPublishingIntegration[] {
  const igMissing: string[] = [];
  if (!process.env.INSTAGRAM_ACCESS_TOKEN) igMissing.push("INSTAGRAM_ACCESS_TOKEN");
  if (!process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID) {
    igMissing.push("INSTAGRAM_BUSINESS_ACCOUNT_ID");
  }

  const ttMissing: string[] = [];
  if (!process.env.TIKTOK_CLIENT_KEY) ttMissing.push("TIKTOK_CLIENT_KEY");
  if (!process.env.TIKTOK_ACCESS_TOKEN) ttMissing.push("TIKTOK_ACCESS_TOKEN");

  return [
    {
      platform: "instagram",
      displayName: "Instagram Graph API (Reels)",
      connected: igMissing.length === 0,
      statusLabel: igMissing.length === 0 ? "Connected" : "Not Connected",
      missingCredentials: igMissing,
      note:
        igMissing.length === 0
          ? "Official Meta Graph API credentials configured."
          : "Not Connected — configure Meta Graph API credentials and permissions before publishing directly.",
    },
    {
      platform: "tiktok",
      displayName: "TikTok Content Posting API",
      connected: ttMissing.length === 0,
      statusLabel: ttMissing.length === 0 ? "Connected" : "Not Connected",
      missingCredentials: ttMissing,
      note:
        ttMissing.length === 0
          ? "Official TikTok Content Posting credentials configured."
          : "Not Connected — configure approved TikTok Content Posting API credentials before publishing directly.",
    },
  ];
}
