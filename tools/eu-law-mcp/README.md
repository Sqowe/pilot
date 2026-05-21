# EU Law MCP Server

MCP server for accessing European Union legislation, case-law, and official documents.

## Data Sources

- **[Cellar SPARQL endpoint](https://publications.europa.eu/webapi/rdf/sparql)** — Open knowledge graph of all EU publications (no auth required)
- **[EUR-Lex](https://eur-lex.europa.eu)** — Official EU law portal for document retrieval
- **Official Journal of the EU** — Published via Cellar/EUR-Lex

## Tools

| Tool                       | Description                                                           |
| -------------------------- | --------------------------------------------------------------------- |
| `search_eu_legislation`    | Search EU laws by keyword, year, type (regulation/directive/decision) |
| `get_eu_document`          | Retrieve full text of a document by CELEX number                      |
| `get_eu_document_metadata` | Get structured metadata (title, date, status, subjects)               |
| `search_eu_caselaw`        | Search CJEU case-law by keyword, year, or ECLI                        |
| `list_official_journal`    | List Official Journal issues by year and series                       |
| `eu_sparql_query`          | Execute custom SPARQL queries against Cellar                          |

## Architecture

- **Transport:** stdio (local MCP server)
- **Data access:** SPARQL queries (Cellar) + direct HTTP (EUR-Lex HTML)
- **No cheerio needed** — HTML-to-text extraction is regex-based (EU docs are well-structured)
- **No authentication** — Cellar SPARQL and EUR-Lex document URLs are fully open
- **Caching:** In-memory TTL (30 min for SPARQL, 60 min for documents)
- **Rate limiting:** 500ms between requests

## Setup

```bash
cd tools/eu-law-mcp
npm install
npm run build
```

## Usage

### With Kiro (mcp.json)

Add to `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "eu-law": {
      "command": "node",
      "args": ["tools/eu-law-mcp/dist/index.js"],
      "disabled": false,
      "autoApprove": [
        "search_eu_legislation",
        "get_eu_document",
        "get_eu_document_metadata",
        "search_eu_caselaw",
        "list_official_journal",
        "eu_sparql_query"
      ]
    }
  }
}
```

### Development

```bash
npm run dev  # Run with tsx (no build needed)
```

## CELEX Numbers

CELEX is the unique identifier for EU legal documents. Format: `{sector}{year}{type}{number}`

| Sector | Meaning                                          |
| ------ | ------------------------------------------------ |
| 3      | Legislation (regulations, directives, decisions) |
| 6      | Case-law                                         |
| 5      | Preparatory acts                                 |
| 0      | Consolidated texts                               |

| Type | Meaning       |
| ---- | ------------- |
| R    | Regulation    |
| L    | Directive     |
| D    | Decision      |
| CJ   | CJEU Judgment |

**Examples:**

- `32024R1689` → Regulation (EU) 2024/1689 (AI Act)
- `32016R0679` → Regulation (EU) 2016/679 (GDPR)
- `32000L0031` → Directive 2000/31/EC (e-Commerce)
- `62019CJ0311` → Case C-311/19 (Schrems II)

## SPARQL Examples

The `eu_sparql_query` tool auto-prepends CDM prefixes. Example queries:

**Find all regulations from 2024 still in force:**

```sparql
SELECT ?celex ?title
WHERE {
  ?work cdm:resource_legal_in-force "true"^^xsd:boolean.
  ?work cdm:resource_legal_year "2024"^^xsd:gYear.
  ?work cdm:work_id_document ?celex.
  FILTER(CONTAINS(?celex, "R"))
  ?expr cdm:expression_belongs_to_work ?work.
  ?expr cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG>.
  ?expr cdm:expression_title ?title.
}
LIMIT 20
```

**Find documents about artificial intelligence:**

```sparql
SELECT ?celex ?title ?date
WHERE {
  ?work cdm:work_id_document ?celex.
  ?work cdm:work_date_document ?date.
  ?expr cdm:expression_belongs_to_work ?work.
  ?expr cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG>.
  ?expr cdm:expression_title ?title.
  FILTER(CONTAINS(LCASE(?title), "artificial intelligence"))
}
ORDER BY DESC(?date)
LIMIT 10
```

## Comparison with Hungarian Law MCP

| Feature      | hungarian-law-mcp             | eu-law-mcp                      |
| ------------ | ----------------------------- | ------------------------------- |
| Data access  | Web scraping (HTTP + cheerio) | SPARQL + REST (structured APIs) |
| Auth         | None                          | None                            |
| Languages    | Hungarian only                | 24 EU languages                 |
| Document IDs | Custom URL slugs              | CELEX (standardized)            |
| Metadata     | Limited (parsed from HTML)    | Rich (knowledge graph)          |
| Dependencies | cheerio                       | None (just fetch)               |
