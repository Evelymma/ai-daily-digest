import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";
import { marked } from "marked";
import mermaid from "mermaid";
import { chromium } from "playwright";

interface Args {
  hours: number;
  topN: number;
  lang: string;
  output: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);

  const getArg = (name: string, defaultValue: string) => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : defaultValue;
  };

  return {
    hours: parseInt(getArg("--hours", "48")),
    topN: parseInt(getArg("--top-n", "15")),
    lang: getArg("--lang", "zh"),
    output: getArg("--output", "./digest.md"),
  };
}

async function renderMermaidToSvg(code: string): Promise<string> {
  mermaid.initialize({
    startOnLoad: false,
    theme: "default",
  });

  const id = `mermaid-${Date.now()}`;

  const result = await mermaid.render(id, code);

  return result.svg;
}

async function convertMarkdownToHtml(markdown: string): Promise<string> {
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
        `
<div style="margin:20px 0;text-align:center;">
${svg}
</div>
`
      );
    } catch (err) {
      console.error("Mermaid render failed:", err);

      processed = processed.replace(
        full,
        `
<pre style="background:#f5f5f5;padding:12px;border-radius:8px;overflow:auto;">
${code}
</pre>
`
      );
    }
  }

  const htmlBody = marked(processed);

  return `
<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />

<style>
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  line-height:1.7;
  color:#222;
  max-width:900px;
  margin:auto;
  padding:24px;
}

h1,h2,h3{
  margin-top:32px;
}

table{
  border-collapse:collapse;
  width:100%;
  margin:20px 0;
}

th,td{
  border:1px solid #ddd;
  padding:10px;
  text-align:left;
}

th{
  background:#f5f5f5;
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

blockquote{
  border-left:4px solid #ddd;
  padding-left:12px;
  color:#666;
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

async function sendEmail(subject: string, markdown: string) {
  const html = await convertMarkdownToHtml(markdown);

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.MAIL_SENDER_EMAIL,
      pass: process.env.MAIL_SENDER_PASSWORD,
    },
  });

  await transporter.sendMail({
    from: process.env.MAIL_SENDER_EMAIL,
    to: process.env.MAIL_RECIPIENT,
    subject,
    text: markdown,
    html,
  });

  console.log("Email sent successfully");
}

async function generateDigest(): Promise<string> {
  return `
# AI Daily Digest

## 数据概览

| 指标 | 数值 |
|---|---|
| 扫描源 | 83 |
| 抓取文章 | 2454 |
| 时间范围 | 48h |
| 精选 | 15 |

## 分类分布

\`\`\`mermaid
pie title 文章分类分布
    "AI Agents" : 8
    "Open Source" : 3
    "Research" : 2
    "其他" : 2
\`\`\`

## 今日重点

### 1. AI Agent 新趋势

近期 AI Agent 编排能力明显增强。

### 2. 多模态模型发展

视觉与推理进一步融合。
`;
}

async function main() {
  const args = parseArgs();

  console.log("Generating digest...");

  const markdown = await generateDigest();

  fs.writeFileSync(args.output, markdown);

  console.log(`Markdown saved to ${args.output}`);

  await sendEmail(
    `AI Daily Digest ${new Date().toLocaleDateString()}`,
    markdown
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
