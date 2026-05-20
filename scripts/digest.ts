// digest.ts
// Bun/Node compatible AI Daily Digest generator
// Features:
// - Fetch 90 curated RSS feeds
// - AI scoring + summarization
// - Gemini primary + OpenAI-compatible fallback
// - Markdown report generation
// - Mermaid charts
// - HTML email rendering
// - Gmail SMTP delivery

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import nodemailer from "nodemailer";
import { marked } from "marked";
import mermaid from "mermaid";

// ============================================================================
// Constants
// ============================================================================

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

const OPENAI_DEFAULT_API_BASE = "https://api.openai.com/v1";
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";

const FEED_FETCH_TIMEOUT_MS = 15_000;
const FEED_CONCURRENCY = 3;
const GEMINI_BATCH_SIZE = 10;
const MAX_CONCURRENT_GEMINI = 1;

const MAIL_SENDER_EMAIL = process.env.MAIL_SENDER_EMAIL || "";
const MAIL_SENDER_PASSWORD = process.env.MAIL_SENDER_PASSWORD || "";
const MAIL_RECIPIENT = process.env.MAIL_RECIPIENT || "";

// ============================================================================
// Feed List
// ============================================================================

const RSS_FEEDS: Array<{
  name: string;
  xmlUrl: string;
  htmlUrl: string;
}> = [
  {
    name: "simonwillison.net",
    xmlUrl: "https://simonwillison.net/atom/everything/",
    htmlUrl: "https://simonwillison.net",
  },
  {
    name: "jeffgeerling.com",
    xmlUrl: "https://www.jeffgeerling.com/blog.xml",
    htmlUrl: "https://jeffgeerling.com",
  },
  {
    name: "seangoedecke.com",
    xmlUrl: "https://www.seangoedecke.com/rss.xml",
    htmlUrl: "https://seangoedecke.com",
  },
  {
    name: "krebsonsecurity.com",
    xmlUrl: "https://krebsonsecurity.com/feed/",
    htmlUrl: "https://krebsonsecurity.com",
  },
  {
    name: "daringfireball.net",
    xmlUrl: "https://daringfireball.net/feeds/main",
    htmlUrl: "https://daringfireball.net",
  },
  {
    name: "ericmigi.com",
    xmlUrl: "https://ericmigi.com/rss.xml",
    htmlUrl: "https://ericmigi.com",
  },
  {
    name: "antirez.com",
    xmlUrl: "http://antirez.com/rss",
    htmlUrl: "http://antirez.com",
  },
  {
    name: "idiallo.com",
    xmlUrl: "https://idiallo.com/feed.rss",
    htmlUrl: "https://idiallo.com",
  },
  {
    name: "maurycyz.com",
    xmlUrl: "https://maurycyz.com/index.xml",
    htmlUrl: "https://maurycyz.com",
  },
  {
    name: "pluralistic.net",
    xmlUrl: "https://pluralistic.net/feed/",
    htmlUrl: "https://pluralistic.net",
  },
];

// ============================================================================
// Types
// ============================================================================

type CategoryId =
  | "ai-ml"
  | "security"
  | "engineering"
  | "tools"
  | "opinion"
  | "other";

const CATEGORY_META: Record<
  CategoryId,
  {
    emoji: string;
    label: string;
  }
> = {
  "ai-ml": {
    emoji: "🤖",
    label: "AI / ML",
  },
  security: {
    emoji: "🔒",
    label: "安全",
  },
  engineering: {
    emoji: "⚙️",
    label: "工程",
  },
  tools: {
    emoji: "🛠",
    label: "工具 / 开源",
  },
  opinion: {
    emoji: "💡",
    label: "观点 / 杂谈",
  },
  other: {
    emoji: "📝",
    label: "其他",
  },
};

interface Article {
  title: string;
  link: string;
  pubDate: Date;
  description: string;
  sourceName: string;
  sourceUrl: string;
}

interface ScoredArticle extends Article {
  score: number;
  scoreBreakdown: {
    relevance: number;
    quality: number;
    timeliness: number;
  };
  category: CategoryId;
  keywords: string[];
  titleZh: string;
  summary: string;
  reason: string;
}

interface GeminiScoringResult {
  results: Array<{
    index: number;
    relevance: number;
    quality: number;
    timeliness: number;
    category: string;
    keywords: string[];
  }>;
}

interface GeminiSummaryResult {
  results: Array<{
    index: number;
    titleZh: string;
    summary: string;
    reason: string;
  }>;
}

interface AIClient {
  call(prompt: string): Promise<string>;
}

interface Args {
  hours: number;
  topN: number;
  lang: "zh" | "en";
  output: string;
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(): Args {
  const args = process.argv.slice(2);

  const getArg = (name: string, defaultValue: string) => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : defaultValue;
  };

  return {
    hours: parseInt(getArg("--hours", "48")),
    topN: parseInt(getArg("--top-n", "15")),
    lang: getArg("--lang", "zh") as "zh" | "en",
    output: getArg("--output", "./digest.md"),
  };
}

// ============================================================================
// Utilities
// ============================================================================

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(parseInt(code))
    )
    .trim();
}

function extractCDATA(text: string): string {
  const match = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return match ? match[1] : text;
}

function getTagContent(xml: string, tagName: string): string {
  const patterns = [
    new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i"),
    new RegExp(`<${tagName}[^>]*/>`, "i"),
  ];

  for (const pattern of patterns) {
    const match = xml.match(pattern);

    if (match?.[1]) {
      return extractCDATA(match[1]).trim();
    }
  }

  return "";
}

function getAttrValue(
  xml: string,
  tagName: string,
  attrName: string
): string {
  const pattern = new RegExp(
    `<${tagName}[^>]*\\s${attrName}=["']([^"']*)["'][^>]*/?>`,
    "i"
  );

  const match = xml.match(pattern);

  return match?.[1] || "";
}

function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;

  const d = new Date(dateStr);

  if (!isNaN(d.getTime())) return d;

  return null;
}

function parseJsonResponse<T>(text: string): T {
  let jsonText = text.trim();

  if (jsonText.startsWith("```")) {
    jsonText = jsonText
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "");
  }

  return JSON.parse(jsonText) as T;
}

function humanizeTime(pubDate: Date): string {
  const diffMs = Date.now() - pubDate.getTime();
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays < 7) return `${diffDays} 天前`;

  return pubDate.toISOString().slice(0, 10);
}

// ============================================================================
// RSS Parsing
// ============================================================================

function parseRSSItems(
  xml: string
): Array<{
  title: string;
  link: string;
  pubDate: string;
  description: string;
}> {
  const items: Array<{
    title: string;
    link: string;
    pubDate: string;
    description: string;
  }> = [];

  const isAtom =
    (xml.includes("<feed") &&
      xml.includes('xmlns="http://www.w3.org/2005/Atom"')) ||
    xml.includes("<feed ");

  if (isAtom) {
    const entryPattern = /<entry[\s>]([\s\S]*?)<\/entry>/gi;

    let entryMatch;

    while ((entryMatch = entryPattern.exec(xml)) !== null) {
      const entryXml = entryMatch[1];

      const title = stripHtml(getTagContent(entryXml, "title"));

      let link = getAttrValue(
        entryXml,
        'link[^>]*rel="alternate"',
        "href"
      );

      if (!link) {
        link = getAttrValue(entryXml, "link", "href");
      }

      const pubDate =
        getTagContent(entryXml, "published") ||
        getTagContent(entryXml, "updated");

      const description = stripHtml(
        getTagContent(entryXml, "summary") ||
          getTagContent(entryXml, "content")
      );

      if (title || link) {
        items.push({
          title,
          link,
          pubDate,
          description: description.slice(0, 500),
        });
      }
    }
  } else {
    const itemPattern = /<item[\s>]([\s\S]*?)<\/item>/gi;

    let itemMatch;

    while ((itemMatch = itemPattern.exec(xml)) !== null) {
      const itemXml = itemMatch[1];

      const title = stripHtml(getTagContent(itemXml, "title"));

      const link =
        getTagContent(itemXml, "link") ||
        getTagContent(itemXml, "guid");

      const pubDate =
        getTagContent(itemXml, "pubDate") ||
        getTagContent(itemXml, "dc:date") ||
        getTagContent(itemXml, "date");

      const description = stripHtml(
        getTagContent(itemXml, "description") ||
          getTagContent(itemXml, "content:encoded")
      );

      if (title || link) {
        items.push({
          title,
          link,
          pubDate,
          description: description.slice(0, 500),
        });
      }
    }
  }

  return items;
}

// ============================================================================
// Feed Fetching
// ============================================================================

async function fetchFeed(
  feed: (typeof RSS_FEEDS)[0]
): Promise<Article[]> {
  try {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      FEED_FETCH_TIMEOUT_MS
    );

    const response = await fetch(feed.xmlUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "AI-Daily-Digest/1.0",
        Accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const xml = await response.text();

    const items = parseRSSItems(xml);

    return items.map((item) => ({
      title: item.title,
      link: item.link,
      pubDate: parseDate(item.pubDate) || new Date(0),
      description: item.description,
      sourceName: feed.name,
      sourceUrl: feed.htmlUrl,
    }));
  } catch (error) {
    console.warn(
      `[digest] ${feed.name} failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );

    return [];
  }
}

async function fetchAllFeeds(
  feeds: typeof RSS_FEEDS
): Promise<Article[]> {
  const allArticles: Article[] = [];

  for (let i = 0; i < feeds.length; i += FEED_CONCURRENCY) {
    const batch = feeds.slice(i, i + FEED_CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(fetchFeed)
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        allArticles.push(...result.value);
      }
    }

    console.log(
      `[digest] progress ${Math.min(
        i + FEED_CONCURRENCY,
        feeds.length
      )}/${feeds.length}`
    );
  }

  return allArticles;
}

// ============================================================================
// AI Provider
// ============================================================================

async function callGemini(
  prompt: string,
  apiKey: string
): Promise<string> {
  const response = await fetch(
    `${GEMINI_API_URL}?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.3,
          topP: 0.8,
          topK: 40,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
        }>;
      };
    }>;
  };

  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callOpenAICompatible(
  prompt: string,
  apiKey: string,
  apiBase: string,
  model: string
): Promise<string> {
  const response = await fetch(
    `${apiBase.replace(/\/+$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.3,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };

  return data.choices?.[0]?.message?.content || "";
}

function inferOpenAIModel(apiBase: string): string {
  if (apiBase.toLowerCase().includes("deepseek")) {
    return "deepseek-chat";
  }

  return OPENAI_DEFAULT_MODEL;
}

function createAIClient(config: {
  geminiApiKey?: string;
  openaiApiKey?: string;
  openaiApiBase?: string;
  openaiModel?: string;
}): AIClient {
  const state = {
    geminiApiKey: config.geminiApiKey?.trim() || "",
    openaiApiKey: config.openaiApiKey?.trim() || "",
    openaiApiBase:
      config.openaiApiBase?.trim() ||
      OPENAI_DEFAULT_API_BASE,
    openaiModel:
      config.openaiModel?.trim() ||
      inferOpenAIModel(
        config.openaiApiBase || OPENAI_DEFAULT_API_BASE
      ),
    geminiEnabled: Boolean(config.geminiApiKey),
  };

  return {
    async call(prompt: string): Promise<string> {
      if (state.geminiEnabled && state.geminiApiKey) {
        try {
          return await callGemini(
            prompt,
            state.geminiApiKey
          );
        } catch (err) {
          console.warn(
            "[digest] Gemini failed, fallback triggered"
          );

          state.geminiEnabled = false;
        }
      }

      if (state.openaiApiKey) {
        return callOpenAICompatible(
          prompt,
          state.openaiApiKey,
          state.openaiApiBase,
          state.openaiModel
        );
      }

      throw new Error("No AI provider configured");
    },
  };
}

// ============================================================================
// AI Scoring
// ============================================================================

function buildScoringPrompt(
  articles: Array<{
    index: number;
    title: string;
    description: string;
    sourceName: string;
  }>
): string {
  const articlesList = articles
    .map(
      (a) =>
        `Index ${a.index}: [${a.sourceName}] ${a.title}\n${a.description}`
    )
    .join("\n\n---\n\n");

  return `
你是技术编辑。

请对文章进行：
1. relevance
2. quality
3. timeliness

评分范围 1-10。

分类只能是：
ai-ml
security
engineering
tools
opinion
other

返回 JSON：

{
  "results":[
    {
      "index":0,
      "relevance":8,
      "quality":7,
      "timeliness":9,
      "category":"engineering",
      "keywords":["rust","compiler"]
    }
  ]
}

文章：

${articlesList}
`;
}

async function scoreArticlesWithAI(
  articles: Article[],
  aiClient: AIClient
) {
  const allScores = new Map<
    number,
    {
      relevance: number;
      quality: number;
      timeliness: number;
      category: CategoryId;
      keywords: string[];
    }
  >();

  const indexed = articles.map((article, index) => ({
    index,
    title: article.title,
    description: article.description,
    sourceName: article.sourceName,
  }));

  const batches: typeof indexed[] = [];

  for (
    let i = 0;
    i < indexed.length;
    i += GEMINI_BATCH_SIZE
  ) {
    batches.push(indexed.slice(i, i + GEMINI_BATCH_SIZE));
  }

  for (
    let i = 0;
    i < batches.length;
    i += MAX_CONCURRENT_GEMINI
  ) {
    const group = batches.slice(
      i,
      i + MAX_CONCURRENT_GEMINI
    );

    await Promise.all(
      group.map(async (batch) => {
        try {
          const prompt = buildScoringPrompt(batch);

          const response = await aiClient.call(prompt);

          const parsed =
            parseJsonResponse<GeminiScoringResult>(
              response
            );

          for (const result of parsed.results) {
            allScores.set(result.index, {
              relevance: result.relevance,
              quality: result.quality,
              timeliness: result.timeliness,
              category:
                (result.category as CategoryId) || "other",
              keywords: result.keywords || [],
            });
          }
        } catch (err) {
          console.warn("[digest] scoring batch failed");
        }
      })
    );
  }

  return allScores;
}

// ============================================================================
// AI Summary
// ============================================================================

function buildSummaryPrompt(
  articles: Array<{
    index: number;
    title: string;
    description: string;
    sourceName: string;
    link: string;
  }>,
  lang: "zh" | "en"
): string {
  const articleList = articles
    .map(
      (a) =>
        `Index ${a.index}\nTitle:${a.title}\nURL:${a.link}\n${a.description}`
    )
    .join("\n\n---\n\n");

  return `
请为文章生成：
1. 中文标题 titleZh
2. summary
3. reason

返回 JSON：

{
  "results":[
    {
      "index":0,
      "titleZh":"标题",
      "summary":"摘要",
      "reason":"推荐理由"
    }
  ]
}

${lang === "zh" ? "请使用中文。" : "Use English."}

${articleList}
`;
}

async function summarizeArticles(
  articles: Array<Article & { index: number }>,
  aiClient: AIClient,
  lang: "zh" | "en"
) {
  const summaries = new Map<
    number,
    {
      titleZh: string;
      summary: string;
      reason: string;
    }
  >();

  const indexed = articles.map((a) => ({
    index: a.index,
    title: a.title,
    description: a.description,
    sourceName: a.sourceName,
    link: a.link,
  }));

  const batches: typeof indexed[] = [];

  for (
    let i = 0;
    i < indexed.length;
    i += GEMINI_BATCH_SIZE
  ) {
    batches.push(indexed.slice(i, i + GEMINI_BATCH_SIZE));
  }

  for (const batch of batches) {
    try {
      const prompt = buildSummaryPrompt(batch, lang);

      const response = await aiClient.call(prompt);

      const parsed =
        parseJsonResponse<GeminiSummaryResult>(
          response
        );

      for (const result of parsed.results) {
        summaries.set(result.index, {
          titleZh: result.titleZh,
          summary: result.summary,
          reason: result.reason,
        });
      }
    } catch (err) {
      console.warn("[digest] summary batch failed");
    }
  }

  return summaries;
}

// ============================================================================
// Charts
// ============================================================================

function generateKeywordBarChart(
  articles: ScoredArticle[]
): string {
  const kwCount = new Map<string, number>();

  for (const a of articles) {
    for (const kw of a.keywords) {
      kwCount.set(
        kw,
        (kwCount.get(kw) || 0) + 1
      );
    }
  }

  const sorted = Array.from(kwCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (sorted.length === 0) return "";

  const labels = sorted
    .map(([k]) => `"${k}"`)
    .join(", ");

  const values = sorted
    .map(([, v]) => v)
    .join(", ");

  return `
\`\`\`mermaid
xychart-beta horizontal
    title "高频关键词"
    x-axis [${labels}]
    y-axis "出现次数" 0 --> 10
    bar [${values}]
\`\`\`
`;
}

// ============================================================================
// Mermaid
// ============================================================================

async function renderMermaidToSvg(
  code: string
): Promise<string> {
  mermaid.initialize({
    startOnLoad: false,
    theme: "default",
  });

  const id = `mermaid-${Date.now()}`;

  const result = await mermaid.render(id, code);

  return result.svg;
}

// ============================================================================
// Markdown -> HTML
// ============================================================================

async function convertMarkdownToHtml(
  markdown: string
): Promise<string> {
  const mermaidRegex = /```mermaid([\s\S]*?)```/g;

  let processed = markdown;

  const matches = [...markdown.matchAll(mermaidRegex)];

  for (const match of matches) {
    const full = match[0];
    const code = match[1].trim();

    try {
      const svg = await renderMermaidToSvg(code);

      processed = processed.replace(
        full,
        `<div style="margin:20px 0">${svg}</div>`
      );
    } catch {
      processed = processed.replace(
        full,
        `<pre>${code}</pre>`
      );
    }
  }

  const htmlBody = marked(processed);

  return `
<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<style>
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  line-height:1.7;
  max-width:900px;
  margin:auto;
  padding:24px;
}
pre{
  background:#f5f5f5;
  padding:12px;
  border-radius:8px;
  overflow:auto;
}
code{
  background:#f2f2f2;
  padding:2px 4px;
  border-radius:4px;
}
table{
  border-collapse:collapse;
  width:100%;
}
th,td{
  border:1px solid #ddd;
  padding:10px;
}
img,svg{
  max-width:100%;
}
</style>
</head>
<body>
${htmlBody}
</body>
</html>
`;
}

// ============================================================================
// Email
// ============================================================================

async function sendEmail(
  subject: string,
  markdown: string
) {
  if (
    !MAIL_SENDER_EMAIL ||
    !MAIL_SENDER_PASSWORD ||
    !MAIL_RECIPIENT
  ) {
    console.log("[digest] email skipped");

    return;
  }

  const html = await convertMarkdownToHtml(markdown);

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: MAIL_SENDER_EMAIL,
      pass: MAIL_SENDER_PASSWORD,
    },
  });

  await transporter.sendMail({
    from: MAIL_SENDER_EMAIL,
    to: MAIL_RECIPIENT,
    subject,
    text: markdown,
    html,
  });

  console.log("[digest] email sent");
}

// ============================================================================
// Highlights
// ============================================================================

async function generateHighlights(
  articles: ScoredArticle[],
  aiClient: AIClient,
  lang: "zh" | "en"
): Promise<string> {
  const articleList = articles
    .slice(0, 10)
    .map(
      (a, i) =>
        `${i + 1}. ${a.titleZh || a.title} - ${a.summary}`
    )
    .join("\n");

  const prompt = `
总结今天技术圈趋势。

要求：
- 3~5 句话
- 宏观总结
- 新闻导语风格

${lang === "zh" ? "中文" : "English"}

${articleList}
`;

  try {
    return (await aiClient.call(prompt)).trim();
  } catch {
    return "";
  }
}

// ============================================================================
// Report
// ============================================================================

function generateDigestReport(
  articles: ScoredArticle[],
  highlights: string,
  stats: {
    totalFeeds: number;
    successFeeds: number;
    totalArticles: number;
    filteredArticles: number;
    hours: number;
  }
): string {
  const now = new Date();

  const dateStr = now
    .toISOString()
    .split("T")[0];

  let report = `# 📰 AI 博客每日精选 — ${dateStr}\n\n`;

  report += `> 来自 ${stats.totalFeeds} 个技术 RSS 源\n\n`;

  if (highlights) {
    report += `## 📝 今日看点\n\n`;
    report += `${highlights}\n\n`;
  }

  report += `## 📊 数据概览\n\n`;

  report += `| 扫描源 | 抓取文章 | 时间范围 | 精选 |\n`;
  report += `|---|---|---|---|\n`;
  report += `| ${stats.successFeeds}/${stats.totalFeeds} | ${stats.totalArticles} | ${stats.hours}h | ${articles.length} |\n\n`;

  report += generateKeywordBarChart(articles);

  report += `\n---\n\n`;

  let idx = 0;

  for (const article of articles) {
    idx++;

    const cat = CATEGORY_META[article.category];

    report += `## ${idx}. ${article.titleZh || article.title}\n\n`;

    report += `[原文链接](${article.link})\n\n`;

    report += `来源：${article.sourceName} · ${humanizeTime(
      article.pubDate
    )} · ${cat.emoji} ${cat.label}\n\n`;

    report += `> ${article.summary}\n\n`;

    if (article.reason) {
      report += `💡 ${article.reason}\n\n`;
    }

    if (article.keywords.length > 0) {
      report += `🏷️ ${article.keywords.join(", ")}\n\n`;
    }

    report += `---\n\n`;
  }

  return report;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = parseArgs();

  const geminiApiKey = process.env.GEMINI_API_KEY;

  const openaiApiKey = process.env.OPENAI_API_KEY;

  const openaiApiBase = process.env.OPENAI_API_BASE;

  const openaiModel = process.env.OPENAI_MODEL;

  const aiClient = createAIClient({
    geminiApiKey,
    openaiApiKey,
    openaiApiBase,
    openaiModel,
  });

  console.log("[digest] fetching feeds");

  const allArticles = await fetchAllFeeds(RSS_FEEDS);

  const cutoffTime = new Date(
    Date.now() - args.hours * 60 * 60 * 1000
  );

  const recentArticles = allArticles.filter(
    (a) => a.pubDate.getTime() > cutoffTime.getTime()
  );

  console.log(
    `[digest] ${recentArticles.length} recent articles`
  );

  console.log("[digest] AI scoring");

  const scores = await scoreArticlesWithAI(
    recentArticles,
    aiClient
  );

  const scored = recentArticles.map((article, index) => {
    const score = scores.get(index) || {
      relevance: 5,
      quality: 5,
      timeliness: 5,
      category: "other" as CategoryId,
      keywords: [],
    };

    return {
      ...article,
      totalScore:
        score.relevance +
        score.quality +
        score.timeliness,
      breakdown: score,
    };
  });

  scored.sort((a, b) => b.totalScore - a.totalScore);

  const topArticles = scored.slice(0, args.topN);

  console.log("[digest] generating summaries");

  const indexedTopArticles = topArticles.map(
    (a, i) => ({
      ...a,
      index: i,
    })
  );

  const summaries = await summarizeArticles(
    indexedTopArticles,
    aiClient,
    args.lang
  );

  const finalArticles: ScoredArticle[] =
    topArticles.map((a, i) => {
      const sm = summaries.get(i) || {
        titleZh: a.title,
        summary: a.description,
        reason: "",
      };

      return {
        title: a.title,
        link: a.link,
        pubDate: a.pubDate,
        description: a.description,
        sourceName: a.sourceName,
        sourceUrl: a.sourceUrl,
        score: a.totalScore,
        scoreBreakdown: {
          relevance: a.breakdown.relevance,
          quality: a.breakdown.quality,
          timeliness: a.breakdown.timeliness,
        },
        category: a.breakdown.category,
        keywords: a.breakdown.keywords,
        titleZh: sm.titleZh,
        summary: sm.summary,
        reason: sm.reason,
      };
    });

  const highlights = await generateHighlights(
    finalArticles,
    aiClient,
    args.lang
  );

  const successfulSources = new Set(
    allArticles.map((a) => a.sourceName)
  );

  const report = generateDigestReport(
    finalArticles,
    highlights,
    {
      totalFeeds: RSS_FEEDS.length,
      successFeeds: successfulSources.size,
      totalArticles: allArticles.length,
      filteredArticles: recentArticles.length,
      hours: args.hours,
    }
  );

  await mkdir(dirname(args.output), {
    recursive: true,
  });

  await writeFile(args.output, report);

  console.log(`[digest] saved -> ${args.output}`);

  const markdownContent = await readFile(
    args.output,
    "utf-8"
  );

  await sendEmail(
    `AI 日报 - ${new Date()
      .toISOString()
      .slice(0, 10)}`,
    markdownContent
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
