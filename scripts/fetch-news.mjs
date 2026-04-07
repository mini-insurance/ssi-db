import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import https from 'https';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NEWS_FILE = process.argv[2] || resolve(__dirname, '..', 'news.json');
const RSS_URL = 'https://news.google.com/rss/search?q=%22%E5%B0%91%E9%A1%8D%E7%9F%AD%E6%9C%9F%E4%BF%9D%E9%99%BA%22&hl=ja&gl=JP&ceid=JP:ja';

// 会社名マッチング用（companies.json があれば読み込み）
let COMPANY_NAMES = [];
try {
  const cp = resolve(__dirname, '..', 'companies.json');
  if (existsSync(cp)) {
    COMPANY_NAMES = JSON.parse(readFileSync(cp, 'utf-8')).map(c => c.company || c.name).filter(Boolean);
  }
} catch { /* ignore */ }

const CATEGORY_KEYWORDS = {
  '規制': ['金融庁', '保険業法', '規制', '施行', '改正', '監督', '命令', '行政処分'],
  'M&A': ['買収', '合併', '統合', '譲渡', '子会社', 'M&A', '事業譲渡', '株式取得'],
  '新商品': ['新商品', '発売', '販売開始', 'リリース', '提供開始', '新サービス', '新プラン'],
  '決算': ['決算', '業績', '収益', '増収', '減収', '営業利益', '経常利益'],
  '提携': ['提携', '連携', '協業', 'パートナーシップ', '業務委託'],
};

function guessCategory(title) {
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => title.includes(kw))) return cat;
  }
  return '業界動向';
}

function matchCompanies(title) {
  return COMPANY_NAMES.filter(name => {
    const short = name.replace(/少額短期保険|株式会社/g, '');
    return short.length >= 2 && title.includes(short);
  });
}

function httpGet(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return httpGet(loc, maxRedirects - 1).then(resolve, reject);
      }
      let data = '';
      res.on('data', c => { data += c; if (data.length > 100000) res.destroy(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/** 記事ページから meta description / og:description を取得 */
async function fetchMetaDescription(url, timeoutMs = 8000) {
  try {
    const html = await Promise.race([
      httpGet(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    const metaDesc =
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1];
    const ogDesc =
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)?.[1];
    const desc = metaDesc || ogDesc || '';
    return desc.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
  } catch {
    return '';
  }
}

function parseRssItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
      const v = r.exec(block);
      return v ? v[1].trim() : '';
    };
    const srcMatch = /source[^>]*>([^<]*)</.exec(block);
    // description から実際の記事URLを抽出
    const descRaw = get('description')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    const descUrlMatch = descRaw.match(/<a href="([^"]+)"/);

    items.push({
      title: get('title')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
      link: get('link'),
      descUrl: descUrlMatch ? descUrlMatch[1] : '',
      pubDate: get('pubDate'),
      source: srcMatch ? srcMatch[1].trim() : '',
    });
  }
  return items;
}

function toDateStr(d) {
  if (!d) return new Date().toISOString().slice(0, 10);
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return new Date().toISOString().slice(0, 10);
  return dt.toISOString().slice(0, 10);
}

async function main() {
  console.log(`ニュースファイル: ${NEWS_FILE}`);
  console.log('Google News RSS から少額短期保険ニュースを取得中...');
  const xml = await httpGet(RSS_URL);
  const rssItems = parseRssItems(xml);
  console.log(`${rssItems.length} 件の記事を取得`);

  const raw = existsSync(NEWS_FILE)
    ? JSON.parse(readFileSync(NEWS_FILE, 'utf-8'))
    : { lastFetched: '', items: [] };
  const existing = Array.isArray(raw) ? raw : (raw.items || []);
  const existingTitles = new Set(existing.map(n => n.title.slice(0, 30)));
  const existingUrls = new Set(existing.map(n => n.url));

  const newItems = [];
  for (const item of rssItems) {
    const title = item.title.replace(/ - [^-]+$/, '').trim();
    const url = item.link;
    if (!title || existingUrls.has(url) || existingTitles.has(title.slice(0, 30))) continue;

    newItems.push({
      date: toDateStr(item.pubDate),
      title,
      summary: '',
      source: item.source,
      url,
      descUrl: item.descUrl,
      category: guessCategory(title),
      companies: matchCompanies(title),
    });
    existingTitles.add(title.slice(0, 30));
    existingUrls.add(url);
    console.log(`  + ${toDateStr(item.pubDate)} ${title.slice(0, 60)}`);
  }

  // 新規記事の概要を取得（descUrl → meta description）
  if (newItems.length > 0) {
    console.log(`\n${newItems.length} 件の概要を取得中...`);
    for (const item of newItems) {
      if (item.descUrl) {
        const desc = await fetchMetaDescription(item.descUrl);
        if (desc && desc.length > 20) {
          item.summary = desc.slice(0, 300);
          console.log(`  ✓ ${item.title.slice(0, 40)}`);
        } else {
          console.log(`  × ${item.title.slice(0, 40)}`);
        }
      }
    }
  }

  // descUrl は保存不要
  for (const item of newItems) delete item.descUrl;

  existing.unshift(...newItems);
  existing.sort((a, b) => b.date.localeCompare(a.date));

  const output = { lastFetched: new Date().toISOString().slice(0, 10), items: existing };
  writeFileSync(NEWS_FILE, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.log(`\n完了: ${newItems.length} 件追加 (合計 ${existing.length} 件)`);
}

main().catch(e => { console.error(e); process.exit(1); });
