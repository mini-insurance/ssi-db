import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NEWS_FILE = join(__dirname, '..', 'news.json');
const RSS_URL = 'https://news.google.com/rss/search?q=%22%E5%B0%91%E9%A1%8D%E7%9F%AD%E6%9C%9F%E4%BF%9D%E9%99%BA%22&hl=ja&gl=JP&ceid=JP:ja';

const CATEGORY_KEYWORDS = {
  '規制': ['金融庁', '保険業法', '規制', '施行', '改正', '監督', '命令'],
  'M&A': ['買収', '合併', '統合', '譲渡', '子会社', 'M&A', '事業譲渡'],
  '新商品': ['新商品', '発売', '販売開始', 'リリース', '提供開始', '新サービス'],
  '決算': ['決算', '業績', '収益', '増収', '減収', '営業利益'],
};

function guessCategory(title) {
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => title.includes(kw))) return cat;
  }
  return '業界動向';
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseRssItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => { const r = new RegExp('<' + tag + '>([^<]+)</' + tag + '>'); const v = r.exec(block); return v ? v[1].trim() : ''; };
    const srcMatch = /source[^>]*>([^<]*)</.exec(block);
    items.push({
      title: get('title').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
      link: get('link'),
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
  console.log('Google News RSS から少額短期保険ニュースを取得中...');
  const xml = await httpGet(RSS_URL);
  const items = parseRssItems(xml);
  console.log(items.length + ' 件の記事を取得');

  const raw = JSON.parse(readFileSync(NEWS_FILE, 'utf-8'));
  const existing = Array.isArray(raw) ? raw : (raw.items || []);
  const existingTitles = new Set(existing.map(n => n.title.slice(0, 30)));
  const existingUrls = new Set(existing.map(n => n.url));
  let added = 0;

  for (const item of items) {
    const title = item.title.replace(/ - [^-]+$/, '').trim();
    const url = item.link;
    const source = item.source;
    const date = toDateStr(item.pubDate);

    if (!title || existingUrls.has(url) || existingTitles.has(title.slice(0, 30))) continue;

    existing.unshift({ date, title, summary: '', source, url, category: guessCategory(title), companies: [] });
    existingTitles.add(title.slice(0, 30));
    existingUrls.add(url);
    added++;
    console.log('  + ' + date + ' ' + title.slice(0, 50));
  }

  existing.sort((a, b) => b.date.localeCompare(a.date));
  const output = { lastFetched: new Date().toISOString().slice(0, 10), items: existing };
  writeFileSync(NEWS_FILE, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.log('完了: ' + added + ' 件追加 (合計 ' + existing.length + ' 件)');
}

main().catch(e => { console.error(e); process.exit(1); });
