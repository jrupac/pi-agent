# Workspace

The repository is mounted directly at `/<reponame>` — for example `/goliath` or `/myproject`. **This IS the repo root.** Your working directory is already set there at startup; run `pwd` to confirm the exact path. Use relative paths or `/<reponame>/...` directly. **Never** `cd /<reponame>/<something>` — that path does not exist. Do not navigate into a subdirectory based on the repo name or any other heuristic. The mount point is the root. Period.

# Web skills

You have access to two web tools via the `web-skill` service. Use them with the `bash` tool.

## Web search

Search the web using DuckDuckGo. Returns JSON array of `{title, url, snippet}`.

```bash
curl -s "http://web-skill:3000/search?q=your+query+here&limit=10"
```

## Web fetch

Fetch and extract the readable text content of a URL. Returns `{url, title, content}`.

```bash
curl -s "http://web-skill:3000/fetch?url=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' 'https://example.com')"
```

Or with `jq` to get just the content:

```bash
curl -s "http://web-skill:3000/fetch?url=https%3A%2F%2Fexample.com" | jq -r .content
```

Use these tools when you need to look up current information, research a topic, or read a specific web page.
