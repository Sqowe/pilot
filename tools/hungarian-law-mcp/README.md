# Hungarian Law MCP Server

MCP server for accessing Hungarian legislation and official documents.

## Data Sources

- **[njt.hu](https://njt.hu)** (Nemzeti Jogszabálytár) — Hungary's official, free legislation database containing all laws from 1827 to present
- **[magyarkozlony.hu](https://www.magyarkozlony.hu)** (Magyar Közlöny) — The Hungarian Official Gazette where new legislation is published as PDF

## Tools

| Tool                  | Description                                       |
| --------------------- | ------------------------------------------------- |
| `search_legislation`  | Search for laws by keyword, year, number, or type |
| `get_law_text`        | Retrieve full text of a specific law              |
| `get_law_section`     | Get a specific section (§) of a law               |
| `list_gazette_issues` | List Magyar Közlöny issues by year/month          |
| `get_gazette_issue`   | Get details of a specific gazette issue           |

## Architecture

- **Transport:** stdio (local MCP server)
- **Scraping:** Direct HTTP (`fetch`) + cheerio for HTML parsing
- **Caching:** In-memory cache with TTL (60 min for laws, 15 min for gazette listings)
- **Rate limiting:** 1 request/second to be respectful to government servers
- **No external API dependencies** — fully self-contained

## Setup

```bash
cd tools/hungarian-law-mcp
npm install
npm run build
```

## Usage

### With Kiro (mcp.json)

Add to `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "hungarian-law": {
      "command": "node",
      "args": ["tools/hungarian-law-mcp/dist/index.js"],
      "disabled": false,
      "autoApprove": [
        "search_legislation",
        "get_law_text",
        "get_law_section",
        "list_gazette_issues",
        "get_gazette_issue"
      ]
    }
  }
}
```

### Development

```bash
npm run dev  # Run with tsx (no build needed)
```

## URL Patterns (njt.hu)

Laws on njt.hu follow this URL pattern:

```
https://njt.jog.gov.hu/jogszabaly/{year}-{number}-{type_code}
```

Common type codes:

- `00-00` — törvény (Act of Parliament)
- `20-22` — Korm. rendelet (Government Decree)
- `10-00` — törvényerejű rendelet (Decree with force of law)

Examples:

- `2017-78-00-00.37` → 2017. évi LXXVIII. törvény (Act on Attorney Activities)
- `2009-191-20-22` → 191/2009. (IX. 15.) Korm. rendelet

## Notes

- The server scrapes public government websites — no API key needed
- Hungarian law numbers use Roman numerals for Acts (törvény) and Arabic for decrees
- The `search_legislation` tool handles Roman ↔ Arabic conversion internally
- Full law texts can be very large (thousands of lines); use `maxLength` or `get_law_section` for targeted retrieval
- Rate limiting ensures respectful usage of government servers
