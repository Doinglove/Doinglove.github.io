import { writeFile } from 'node:fs/promises';

const sources = [
  { name: '教务快讯', path: 'jwkx' },
  { name: '考试信息', path: 'ksxx' },
  { name: '课程信息', path: 'tkxx' },
  { name: '教改动态', path: 'jgdt' },
  { name: '图片新闻', path: 'tpxw' },
];

function decodeHtml(value) {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .trim();
}

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function fetchList(source) {
  let lastError;
  for (const protocol of ['https', 'http']) {
    const base = `${protocol}://jwc.bjfu.edu.cn/${source.path}/`;
    try {
      const response = await fetch(base, {
        headers: { 'User-Agent': 'BJFU-JWC-RSS/1.0' },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const list = html.match(/<ul\s+class=["']list_c["'][^>]*>([\s\S]*?)<\/ul>/i)?.[1];
      if (!list) throw new Error('公告列表不存在');

      const pattern = /<li[^>]*>\s*<span[^>]*class=["']datetime["'][^>]*>(\d{4}-\d{2}-\d{2})<\/span>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/li>/gi;
      const items = [...list.matchAll(pattern)].map((match) => ({
        category: source.name,
        date: match[1],
        link: new URL(match[2], base).toString().replace(/^http:/, 'https:'),
        title: decodeHtml(match[3]),
      }));
      if (!items.length) throw new Error('公告列表为空');
      return items;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${source.name}无法读取：${lastError?.message ?? '未知错误'}`);
}

const results = await Promise.allSettled(sources.map(fetchList));
const failures = results.filter((result) => result.status === 'rejected');
if (failures.length) {
  for (const failure of failures) console.error(failure.reason);
  process.exitCode = 1;
} else {
  const seen = new Set();
  const items = results.flatMap((result) => result.value)
    .filter((item) => {
      if (seen.has(item.link)) return false;
      seen.add(item.link);
      return true;
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 60);

  const lastBuildDate = new Date(`${items[0].date}T00:00:00+08:00`).toUTCString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>北林教务处 · 合并通知</title>
    <link>https://jwc.bjfu.edu.cn/</link>
    <description>北京林业大学教务处五个公开栏目的合并订阅源</description>
    <language>zh-cn</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <ttl>30</ttl>
${items.map((item) => `    <item>
      <title>${escapeXml(`[${item.category}] ${item.title}`)}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="true">${escapeXml(item.link)}</guid>
      <category>${escapeXml(item.category)}</category>
      <pubDate>${new Date(`${item.date}T00:00:00+08:00`).toUTCString()}</pubDate>
      <description>${escapeXml(`栏目：${item.category}；发布日期：${item.date}。点击查看教务处原文。`)}</description>
    </item>`).join('\n')}
  </channel>
</rss>
`;
  await writeFile(new URL('../rss.xml', import.meta.url), xml, 'utf8');
  console.log(`已生成 ${items.length} 条公告，覆盖 ${sources.length} 个栏目。`);
}
