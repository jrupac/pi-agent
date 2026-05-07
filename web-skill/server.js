'use strict';

const express = require('express');
const cheerio = require('cheerio');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

const app = express();
const PORT = 3000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0';

app.get('/search', async (req, res) => {
  const { q, limit = '10' } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  try {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;
    const html = await fetch(url, { headers: { 'User-Agent': UA } }).then(r => r.text());
    const $ = cheerio.load(html);
    const results = [];

    $('a.result-link').each((_, el) => {
      const title = $(el).text().trim();
      let href = $(el).attr('href') || '';
      // DDG lite wraps destinations: /l/?uddg=<encoded-url>&...
      try {
        const uddg = new URL('https://duckduckgo.com' + href).searchParams.get('uddg');
        if (uddg) href = uddg;
      } catch (_) {}
      const snippet = $(el).closest('tr').next('tr').find('td').first().text().trim();
      if (title && href) results.push({ title, url: href, snippet });
    });

    res.json(results.slice(0, parseInt(limit, 10)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/fetch', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
    const response = await fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal });
    clearTimeout(timeout);
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    if (!contentType.includes('html')) {
      return res.json({ url, title: '', content: text });
    }

    const dom = new JSDOM(text, { url });
    const article = new Readability(dom.window.document).parse();
    res.json({
      url,
      title: article?.title || '',
      content: article?.textContent?.trim() || text,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`web-skill listening on :${PORT}`));
