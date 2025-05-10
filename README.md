# LibGen MCP Server

This MCP (Model Context Protocol) server allows you to search for books on LibGen (Library Genesis) and attempt to download them directly to your computer's Downloads folder.

**Disclaimer:** Interacting with LibGen via this tool relies on web scraping, as LibGen does not provide an official API. The structure of the LibGen website can change at any time, which may break the functionality of this server. Use at your own discretion and expect potential inconsistencies or failures in book searching and downloading.

## Prerequisites

*   Node.js (v16 or higher recommended)
*   npm (comes with Node.js)

## Installation

1.  Install the package globally using npm:

    ```bash
    npm install -g libgen-mcp-server
    ```
    *(Note: If the package name 'libgen-mcp-server' is taken on npm, you will need to choose a unique name and adjust the installation command accordingly.)*

## MCP Configuration

To use this server with an LLM or other MCP-compatible client, you'll need to register it. After installing the package globally, you can configure your client to use the `libgen-mcp-server-cli` command:

```json
{
  "mcpServers": {
    "libgen-book-finder": {
      "command": "libgen-mcp-server-cli",
      "args": [] // No arguments needed if 'index.js' is correctly linked via 'bin'
    }
  }
}
```

If your MCP client requires the command to be an absolute path, you might need to find where npm installs global binaries on your system (e.g., by running `npm bin -g` and then appending `libgen-mcp-server-cli` to that path). However, typically, globally installed CLI tools are available in the system's PATH.

## Available Tools

### `searchAndDownloadBook`

Searches LibGen for a specified book and attempts to download it in the preferred format (PDF or EPUB) to your system's default Downloads folder.

**Parameters:**

*   `query` (string, required): The search term for the book. This can be the book's title, author, ISBN, or other relevant keywords.
    *   Example: `"The Hitchhiker's Guide to the Galaxy"`
*   `format` (string, optional): The preferred book format. Accepts 'PDF' or 'EPUB' (case-insensitive). Defaults to 'PDF' if not specified.
    *   Example: `"epub"`

**Example Usage (conceptual, depends on your LLM/client):
**
`LLM, please use the libgen-book-finder to find 'Sapiens by Yuval Noah Harari' and download it as an EPUB.`

This would translate to an MCP tool call like:
`searchAndDownloadBook({ query: "Sapiens by Yuval Noah Harari", format: "epub" })`

## How it Works (Briefly)

1.  The `searchAndDownloadBook` tool receives a query and preferred format.
2.  It constructs a search URL for `libgen.is` (this mirror can change).
3.  It fetches the search results page and parses the HTML to find a matching book and its details page link.
4.  It then fetches the book's detail page and tries to find a direct download link.
5.  If a download link is found, it streams the book content to a file in your OS's default Downloads folder.

**Important Notes:**

*   **Reliability:** The success of finding and downloading books heavily depends on the current state of LibGen's website(s) and their HTML structure. Changes to their site can break this tool.
*   **Download Location:** Books are saved to your operating system's standard Downloads folder (e.g., `~/Downloads` on macOS/Linux, `C:\Users\YourUser\Downloads` on Windows).
*   **Error Handling:** Basic error handling is in place, but due to the nature of web scraping, not all failure scenarios can be perfectly predicted or handled. Check the server console logs for more details if issues occur.
*   **No Browser Simulation:** This tool uses direct HTTP requests (`axios`) and HTML parsing (`cheerio`). It does not simulate a full browser environment, so it may not bypass advanced anti-bot measures like JavaScript challenges or complex CAPTCHAs.
